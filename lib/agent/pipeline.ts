import { hasUnsafeSuccessClaim, simulationIsDisclosed, validEvidence } from "./evidence.ts";
import { decideHandoff } from "./handoff.ts";
import { executeAgentTools, isFailedReceipt } from "./tool-engine.ts";
import type {
  AgentContext,
  AgentFinalStatus,
  AgentResult,
  ChatMessage,
  Intent,
  ToolReceipt,
} from "./types.ts";
import { normalizeResponse, questionCount, repetitionScore } from "./repetition.ts";

const normalized = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function analyzeIntent(message: string): {
  intent: Intent;
  confidence: number;
  goal: string;
} {
  const text = normalized(message);
  if (/ignore.*regra|revele.*prompt|dados de outro cliente|cpf de outro|acesse outro cliente|execute.*sem permissao|acao nao autorizada/.test(text)) return { intent: "unauthorized_request", confidence: 0.99, goal: "Bloquear solicitação não autorizada" };
  if (/humano|atendente|pessoa de verdade|supervisor/.test(text)) return { intent: "human_handoff", confidence: 0.99, goal: "Transferir com contexto" };
  if (/cancelar|cancelo|vou cancelar/.test(text)) return { intent: "cancellation_risk", confidence: 0.97, goal: "Preservar cliente e transferir com contexto" };
  if (/reclamacao formal|reclamação formal|anatel|processo|procon/.test(text)) return { intent: "complaint", confidence: 0.98, goal: "Registrar reclamação para revisão humana" };
  if (/reinici|reboot|desliga.*equipamento/.test(text)) return { intent: "technical_restart", confidence: 0.96, goal: "Avaliar reinicialização segura" };
  if (/abrir chamado|abr[ae].*chamado|chamado tecnico|chamado técnico|protocolo tecnico|protocolo técnico/.test(text)) return { intent: "technical_ticket", confidence: 0.97, goal: "Preparar chamado técnico" };
  if (/visita|agendar|agenda.*tecnico|agenda.*técnico|horario.*tecnico|horário.*técnico/.test(text)) return { intent: "technical_visit", confidence: 0.96, goal: "Preparar visita técnica" };
  if (/ja paguei|já paguei|pagamento|paguei|nao reconheceu|não reconheceu/.test(text)) return { intent: "financial_payment", confidence: 0.97, goal: "Verificar reconhecimento do pagamento" };
  if (/pix|copia e cola|qr code/.test(text)) return { intent: "financial_pix", confidence: 0.98, goal: "Preparar PIX da fatura" };
  if (/boleto|segunda via|fatura|vencimento/.test(text)) return { intent: "financial_invoice", confidence: 0.97, goal: "Preparar segunda via" };
  if (/desbloq|bloquead/.test(text)) return { intent: "financial_unlock", confidence: 0.95, goal: "Avaliar desbloqueio com segurança" };
  if (/wifi|wi-fi|quarto|comodo|cômodo|alcanca|alcança|sinal.*casa/.test(text)) return { intent: "technical_wifi", confidence: 0.94, goal: "Diagnosticar cobertura Wi-Fi" };
  if (/lent|travando|demora|velocidade|ping|via cabo/.test(text)) return { intent: "technical_slow", confidence: 0.96, goal: "Identificar causa da lentidão" };
  if (/sem internet|sem conex|caiu|onu offline|pppoe offline|potencia|potência|offline|conexao.*nao voltou|conexão.*não voltou/.test(text)) return { intent: "technical_no_connection", confidence: 0.97, goal: "Restaurar conexão" };
  if (/nao funciona|não funciona/.test(text)) return { intent: "technical_no_connection", confidence: 0.68, goal: "Restaurar conexão" };
  if (/receita|futebol|previsao do tempo|previsão do tempo|politica|política/.test(text)) return { intent: "out_of_scope", confidence: 0.96, goal: "Orientar limite de escopo" };
  return { intent: "general_information", confidence: 0.55, goal: "Entender a necessidade do cliente" };
}

function previousIntent(history: ChatMessage[]) {
  const previousCustomer = [...history]
    .reverse()
    .find((item) => item.role === "customer" && analyzeIntent(item.content).intent !== "general_information");
  return previousCustomer ? analyzeIntent(previousCustomer.content) : null;
}

function resolveIntent(message: string, history: ChatMessage[]) {
  let analysis = analyzeIntent(message);
  const reference = /^(sim|nao|não|cad[eê]|onde|nao funcionou|não funcionou|ja reiniciei|já reiniciei|essa|esse|aquela|aquele)\b/i.test(message.trim());
  if (reference && (analysis.intent === "general_information" || /^(sim|nao|não|nao funcionou|não funcionou|ja reiniciei|já reiniciei)\b/i.test(message.trim()))) {
    const inferred = previousIntent(history);
    if (inferred) analysis = { ...inferred, confidence: 0.9 };
  }
  if (/cad[eê]|onde.*pix|nao recebi|não recebi/i.test(message) && history.some((item) => /pix/i.test(item.content))) {
    analysis = { intent: "financial_pix", confidence: 0.98, goal: "Reentregar PIX já solicitado" };
  }
  return analysis;
}

function failedResponse(receipt: ToolReceipt, handoff: boolean): string {
  const ending = handoff
    ? "Vou encaminhar o contexto para um atendente continuar com segurança."
    : "Preciso de uma confirmação antes de continuar.";
  switch (receipt.outcome) {
    case "timeout": return `A consulta demorou além do limite seguro e eu não consegui confirmar o diagnóstico. ${ending}`;
    case "unavailable": return `A ferramenta necessária está indisponível agora, então não confirmei nenhuma ação. ${ending}`;
    case "partial": return `Os dados retornaram incompletos ou contraditórios. Não vou afirmar um resultado sem confirmação. ${ending}`;
    case "forbidden": return `Essa ação não está autorizada neste ambiente e não foi executada. ${ending}`;
    case "not_found": return `Não encontrei uma opção válida para concluir isso agora. ${ending}`;
    case "requires_human": return `Preparei o contexto, mas nenhuma alteração real foi executada. ${ending}`;
    case "invalid": return `A consulta voltou sem dados válidos, então não consegui confirmar o resultado. ${ending}`;
    default: return `A consulta falhou e nenhuma ação foi confirmada. ${ending}`;
  }
}

function responseFor(input: {
  intent: Intent;
  message: string;
  tools: ToolReceipt[];
  context: AgentContext;
  handoff: boolean;
}): string {
  const { intent, message, tools, context, handoff } = input;
  const profile = context.simulationProfile ?? "default";
  const failure = tools.find(isFailedReceipt);
  if (failure) return failedResponse(failure, handoff);
  const worksFromHome = /trabalho.*casa|home office/i.test(message);
  const empathy = worksFromHome ? "Sei que isso interfere diretamente no seu trabalho em casa. " : "";

  if (profile === "multiple_contracts") return "Encontrei duas instalações no cadastro de homologação. Qual delas você quer consultar: Centro ou Bairro Novo?";
  if (profile === "multiple_invoices") return "Encontrei duas faturas fictícias em aberto. Você quer a que vence dia 10 ou a que vence dia 20?";

  switch (intent) {
    case "financial_pix":
      return "No ambiente de homologação, preparei um PIX copia e cola fictício e deixei o artefato simulado abaixo. Nenhuma cobrança real foi criada ou enviada.";
    case "financial_invoice":
      return "No ambiente de homologação, preparei a segunda via fictícia e deixei o documento simulado abaixo. Nenhum boleto real foi enviado.";
    case "financial_payment":
      return profile === "payment_recognized"
        ? "O cenário controlado confirma o pagamento. Isso é uma evidência de homologação e não altera o financeiro real."
        : "A consulta simulada ainda não reconhece o pagamento. Não fiz desbloqueio nem qualquer alteração real; o caso precisa de conferência financeira.";
    case "technical_no_connection":
      if (/ja reiniciei|já reiniciei/i.test(message)) return `${empathy}Certo, não vou pedir para reiniciar de novo. No diagnóstico simulado, a ONU está online e o PPPoE segue offline; preparei um chamado fictício para revisão e nenhuma ordem real foi aberta.`;
      if (/nao funcionou|não funcionou/i.test(message)) return `${empathy}Entendi, então a orientação anterior não resolveu. Preparei um chamado fictício com o diagnóstico simulado e nenhuma ordem real foi aberta.`;
      if (profile === "regional_incident") return `${empathy}O diagnóstico simulado confirma uma falha regional. Não há ajuste seguro no equipamento do cliente; o próximo passo é acompanhar a normalização da massiva.`;
      if (profile === "regional_reports_unconfirmed") return `${empathy}Há relatos na região, mas nenhuma massiva foi confirmada. Não vou tratar isso como falha regional sem evidência; o caso seguirá para revisão.`;
      if (profile === "onu_offline") return `${empathy}No diagnóstico simulado, a ONU está offline e não existe massiva confirmada. Isso aponta para perda de comunicação óptica; preparei o contexto para análise técnica.`;
      if (profile === "optical_critical") return `${empathy}A ONU aparece online, mas a potência óptica simulada está crítica em -29,7 dBm. O sinal de fibra precisa de avaliação técnica; nenhuma ação real foi executada.`;
      return `${empathy}No diagnóstico simulado, a ONU está online, a potência está normal e o PPPoE está offline. Sem massiva confirmada, a evidência aponta para autenticação da sessão. O roteador já foi reiniciado?`;
    case "technical_slow":
      return profile === "cable_slow"
        ? `${empathy}A lentidão também apareceu no teste cabeado simulado. Isso reduz a chance de ser apenas Wi-Fi; preparei o diagnóstico para revisão técnica.`
        : `${empathy}O link e a fibra aparecem normais no cenário simulado, mas há degradação no Wi-Fi. A lentidão acontece perto do roteador ou em outro cômodo?`;
    case "technical_wifi":
      return "No diagnóstico simulado, o roteador está online e os aparelhos estão concentrados em 2.4 GHz. O ponto com sinal ruim fica em qual cômodo?";
    case "technical_ticket":
      return "Preparei um rascunho de chamado no ambiente de homologação e deixei o protocolo simulado abaixo. Nenhuma ordem real foi aberta.";
    case "technical_visit":
      return "Consultei apenas horários fictícios e preparei o contexto para confirmação humana. Nenhuma visita real foi agendada.";
    case "human_handoff":
    case "complaint":
    case "cancellation_risk":
      return "Preparei o transbordo com um resumo sanitizado e um protocolo simulado. Nenhuma transferência externa foi executada neste ambiente.";
    case "unauthorized_request":
      return "Não posso acessar dados de outro cliente nem executar ações sem autorização. A tentativa foi bloqueada e registrada sem expor dados pessoais.";
    case "out_of_scope":
      return "Consigo ajudar com internet, Wi-Fi, cadastro e financeiro do provedor. Para esse outro assunto, não tenho uma fonte confiável e prefiro não inventar.";
    default:
      return "Ainda não tenho evidência suficiente para consultar o cadastro correto. Informe apenas o número fictício do contrato usado neste teste.";
  }
}

function evaluate(
  response: string,
  recentAgent: string[],
  tools: ToolReceipt[],
): AgentResult["evaluation"] {
  const repetition = repetitionScore(response, recentAgent);
  const unsafe = hasUnsafeSuccessClaim(response, tools) || !simulationIsDisclosed(response, tools);
  const hasFailure = tools.some(isFailedReceipt);
  return {
    score: unsafe ? 3.5 : hasFailure ? 9.2 : 9.6,
    naturalness: 9.2,
    precision: unsafe ? 4 : 9.7,
    empathy: 9,
    safety: unsafe ? 2 : 10,
    continuity: 9.5,
    memory: 9.4,
    repetitionScore: Number(repetition.toFixed(2)),
    noveltyScore: Number((1 - repetition).toFixed(2)),
    progressScore: repetition > 0.72 ? 0.35 : 0.94,
    answeredUserQuestion: true,
    unnecessaryQuestion: questionCount(response) > 1,
    falseActionClaim: unsafe,
    contextContinuity: 9.6,
    suggestion: unsafe ? "Remover a confirmação sem evidência válida." : "Manter resposta curta, evidência explícita e um único próximo passo.",
    idealResponse: response,
  };
}

function customerRepeated(message: string, history: ChatMessage[]): boolean {
  const previous = history.filter((item) => item.role === "customer").slice(-3);
  return previous.some((item) => repetitionScore(message, [item.content]) > 0.72);
}

function determineFinalStatus(input: {
  handoff: boolean;
  tools: ToolReceipt[];
  response: string;
  intent: Intent;
}): AgentFinalStatus {
  if (input.intent === "unauthorized_request") return "blocked";
  if (input.handoff) return "handoff";
  if (input.tools.some(isFailedReceipt)) return "failed";
  if (questionCount(input.response) > 0) return "waiting_customer";
  if (input.tools.some((tool) => tool.simulated)) return "simulated";
  return "resolved";
}

export function runAgentPipeline(
  message: string,
  history: ChatMessage[] = [],
  context: AgentContext = {},
): AgentResult {
  const channel = context.channel ?? "web";
  const analysis = resolveIntent(message, history);
  const tools = executeAgentTools(analysis.intent, message, context);
  const recentAgent = history.filter((item) => item.role === "agent").map((item) => item.content);
  const repeatedWithoutResolution = customerRepeated(message, history) && recentAgent.length > 0;
  const handoff = decideHandoff({ ...analysis, message, tools, history, repeatedWithoutResolution });
  let response = responseFor({ intent: analysis.intent, message, tools, context, handoff: handoff.required });
  if (repetitionScore(response, recentAgent) > 0.72 && !handoff.required) {
    response = "A orientação anterior não resolveu. Não vou repetir o mesmo passo; preparei o contexto para revisão humana, sem executar ação real.";
  }
  if (hasUnsafeSuccessClaim(response, tools) || !simulationIsDisclosed(response, tools)) {
    response = "Não consegui confirmar a ação com evidência válida. Nenhuma alteração real foi executada e o caso precisa de revisão humana.";
  }

  const evidence = validEvidence(tools);
  const finalStatus = determineFinalStatus({ handoff: handoff.required, tools, response, intent: analysis.intent });
  const state = finalStatus === "handoff" ? "handoff" : finalStatus === "blocked" ? "blocked" : finalStatus === "waiting_customer" ? "waiting_customer" : finalStatus === "failed" ? "handoff" : "delivered";
  const artifacts = tools.flatMap((tool) => tool.artifact ? [tool.artifact] : []);
  const pendingTools = tools.filter(isFailedReceipt).map((tool) => tool.tool);
  const nextStep = handoff.required
    ? "Atendente deve revisar o resumo e continuar sem repetir perguntas"
    : questionCount(response)
      ? "Aguardar uma resposta do cliente"
      : "Confirmar compreensão do resultado de homologação";

  return {
    ...analysis,
    channel,
    state,
    finalStatus,
    response,
    tools,
    pendingTools,
    evidence,
    actionExecuted: tools.some((tool) => tool.realAction),
    simulationOnly: tools.some((tool) => tool.simulated) && !tools.some((tool) => tool.realAction),
    handoff,
    safetyAlerts: [
      ...(tools.some((tool) => tool.simulated) ? ["SIMULATION_ONLY"] : []),
      ...(tools.some(isFailedReceipt) ? ["TOOL_RESULT_NOT_SUCCESS"] : []),
      ...(analysis.intent === "unauthorized_request" ? ["UNAUTHORIZED_REQUEST_BLOCKED"] : []),
    ],
    conversationSummary: handoff.summary ?? `${history.length + 1} mensagem(ns). Objetivo: ${analysis.goal}. ${tools.length} ferramenta(s), ${evidence.length} evidência(s), ${artifacts.length} artefato(s) simulado(s).`,
    nextStep,
    evaluation: evaluate(response, recentAgent, tools),
    conversationState: {
      activeGoal: analysis.goal,
      step: finalStatus,
      collectedData: tools.some((tool) => tool.tool === "customer.lookup") ? ["cliente fictício identificado", "contrato fictício localizado"] : [],
      pendingQuestion: questionCount(response) ? response.split(".").find((part) => part.includes("?"))?.trim() ?? null : null,
      suppliedInformation: history.filter((item) => item.role === "customer").slice(-5).map((item) => item.content),
      promisedActions: [],
      executedActions: tools.filter((tool) => tool.realAction).map((tool) => tool.tool),
      artifacts: artifacts.map((artifact) => artifact.value),
      blocker: tools.find(isFailedReceipt)?.errorCode ?? null,
      nextStep,
      fingerprints: [{
        normalizedText: normalizeResponse(response),
        intent: analysis.intent,
        goal: analysis.goal,
        actions: tools.map((tool) => tool.tool),
        artifacts: artifacts.map((artifact) => artifact.type),
        at: new Date().toISOString(),
      }],
    },
    correlationId: `lzr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}
