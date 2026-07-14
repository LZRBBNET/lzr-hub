import type { AgentResult, ChatMessage, Intent, ToolReceipt } from "./types";
import { hasFalseActionClaim, normalizeResponse, questionCount, repetitionScore } from "./repetition";

const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function analyzeIntent(message: string): { intent: Intent; confidence: number; goal: string } {
  const text = normalized(message);
  if (/humano|atendente|pessoa de verdade|supervisor/.test(text)) return { intent: "human_handoff", confidence: .99, goal: "Transferir com contexto" };
  if (/pix|copia e cola|qr code/.test(text)) return { intent: "financial_pix", confidence: .98, goal: "Entregar PIX da fatura" };
  if (/boleto|segunda via|fatura|vencimento/.test(text)) return { intent: "financial_invoice", confidence: .97, goal: "Entregar segunda via" };
  if (/desbloq|bloquead|paguei agora/.test(text)) return { intent: "financial_unlock", confidence: .95, goal: "Verificar pagamento e desbloqueio" };
  if (/wifi|wi-fi|quarto|sinal.*casa/.test(text)) return { intent: "technical_wifi", confidence: .94, goal: "Melhorar cobertura Wi-Fi" };
  if (/lent|travando|demora|velocidade|ping/.test(text)) return { intent: "technical_slow", confidence: .96, goal: "Identificar causa da lentidão" };
  if (/sem internet|sem conex|caiu|offline|nao funciona|não funciona/.test(text)) return { intent: "technical_no_connection", confidence: .97, goal: "Restaurar conexão" };
  return { intent: "general_information", confidence: .78, goal: "Entender e orientar o cliente" };
}

function execute(intent: Intent, message=""): ToolReceipt[] {
  const completed = (tool: string, summary: string, artifact?: ToolReceipt["artifact"]): ToolReceipt => ({ tool, status: "completed", summary, artifact });
  switch (intent) {
    case "financial_pix":
      return [
        completed("customer.lookup", "Cliente e contrato localizados"),
        completed("billing.open_invoice", "Fatura de julho localizada: R$ 89,90"),
        completed("billing.generate_pix", "PIX de homologação gerado e anexado", { type: "pix", label: "PIX copia e cola", value: "00020126580014BR.GOV.BCB.PIX0136LZR-HUB-DEMO-2026-07-520400005303986540589.905802BR5920BBNET DEMONSTRACAO6008ITABAIANA62070503***6304A1B2" }),
      ];
    case "financial_invoice":
      return [
        completed("customer.lookup", "Cliente e contrato localizados"),
        completed("billing.open_invoice", "Fatura de julho localizada: R$ 89,90"),
        completed("billing.issue_copy", "Segunda via demonstrativa anexada", { type: "invoice", label: "Fatura — julho/2026", value: "https://demo.lzrhub.local/fatura/BBN-2026-0715" }),
      ];
    case "financial_unlock":
      return [completed("customer.lookup", "Contrato localizado"), completed("billing.payment_status", "Pagamento ainda não conciliado"), completed("workflow.create_handoff", "Análise financeira encaminhada", { type: "protocol", label: "Protocolo", value: "LZR-260711-1842" })];
    case "technical_no_connection": {
      const tools=[completed("customer.lookup", "Contrato ativo localizado"), completed("network.onu_status", "ONU online há 2 dias"), completed("network.pppoe_status", "PPPoE offline"), completed("network.optical_power", "Potência óptica -19,8 dBm"), completed("network.regional_incident", "Nenhuma falha regional")];
      if(/nao funcionou|não funcionou|ja reiniciei|já reiniciei/i.test(message))tools.push(completed("support.open_ticket","Chamado técnico demonstrativo aberto",{type:"protocol",label:"Protocolo",value:"LZR-260712-2041"}));return tools;
    }
    case "technical_slow":
      return [completed("customer.lookup", "Plano de 600 Mega localizado"), completed("network.onu_status", "ONU online"), completed("network.optical_power", "Potência óptica -20,1 dBm"), completed("network.session_diagnostics", "Sessão estável; teste via Wi-Fi")];
    case "technical_wifi":
      return [completed("customer.lookup", "Equipamento Wi-Fi localizado"), completed("network.cpe_status", "Roteador online"), completed("network.wifi_diagnostics", "Dispositivos concentrados em 2.4 GHz")];
    case "human_handoff":
      return [completed("workflow.create_handoff", "Conversa transferida com resumo e histórico", { type: "protocol", label: "Protocolo", value: "LZR-260711-1901" })];
    default:
      return [completed("knowledge.search", "Base consultada; é necessária uma informação adicional")];
  }
}

function responseFor(intent: Intent, message: string): string {
  const worksFromHome = /trabalho.*casa|home office/i.test(message);
  const empathy = worksFromHome ? "Sei que isso atrapalha bastante seu trabalho em casa. " : "";
  switch (intent) {
    case "financial_pix": return "Prontinho, João. Encontrei sua fatura de julho, no valor de R$ 89,90, e deixei o PIX copia e cola logo abaixo.";
    case "financial_invoice": return "Achei sua fatura, João. A segunda via de julho, no valor de R$ 89,90, já está anexada aqui na conversa.";
    case "financial_unlock": return "Conferi seu contrato. O pagamento ainda não apareceu na conciliação, então registrei a análise com o financeiro para não te deixar esperando sem acompanhamento.";
    case "technical_no_connection": if(/ja reiniciei|já reiniciei/i.test(message))return "Perfeito, não vou pedir para reiniciar de novo. A fibra e a ONU estão normais, mas o PPPoE continua offline. Registrei um chamado técnico com esse diagnóstico e deixei o protocolo abaixo.";if(/nao funcionou|não funcionou/i.test(message))return "Certo, então aquele procedimento não resolveu. Como a ONU segue online e o PPPoE offline, avancei para o chamado técnico e já deixei o protocolo abaixo.";return `${empathy}Acabei de conferir: sua ONU está online e o sinal da fibra está normal. Como o PPPoE está offline e não há falha na região, o problema parece estar na autenticação da sessão. Consegue desligar o roteador da tomada por 20 segundos?`;
    case "technical_slow": return `${empathy}Olhei sua conexão e a fibra está estável. O teste indica que a lentidão está acontecendo no Wi-Fi, não no link que chega à sua casa. Você percebe mais isso perto do roteador ou em outro cômodo?`;
    case "technical_wifi": return "Encontrei o roteador online, mas a maioria dos aparelhos está usando a rede de 2.4 GHz. Isso dá mais alcance, porém reduz a velocidade. O aparelho que está lento fica no mesmo cômodo do roteador?";
    case "human_handoff": return "Certo. Já transferi seu atendimento com todo o histórico, então você não vai precisar explicar tudo de novo. O protocolo ficou logo abaixo.";
    default: return "Entendi. Para eu consultar isso no cadastro certo, me diga somente o CPF do titular ou o número do contrato.";
  }
}

function evaluate(response: string, intent: Intent, recentAgent:string[],completedTools:number): AgentResult["evaluation"] {
  const hasArtifact = ["financial_pix", "financial_invoice", "human_handoff"].includes(intent);
  const ideal = response;
  const repetition=repetitionScore(response,recentAgent);
  return {
    score: hasArtifact ? 9.6 : 9.3,
    naturalness: 9.4,
    precision: 9.7,
    empathy: 9.1,
    safety: 10,
    continuity: 9.6,
    memory: 9.4,
    repetitionScore:Number(repetition.toFixed(2)),noveltyScore:Number((1-repetition).toFixed(2)),progressScore:repetition>.72?.35:.94,answeredUserQuestion:true,unnecessaryQuestion:questionCount(response)>1,falseActionClaim:hasFalseActionClaim(response,completedTools),contextContinuity:9.6,
    suggestion: "Manter a resposta curta e confirmar o resultado antes de encerrar o objetivo.",
    idealResponse: ideal,
  };
}

export function runAgentPipeline(message: string, history: ChatMessage[] = []): AgentResult {
  let analysis = analyzeIntent(message);
  const reference=/^(sim|nao|não|cad[eê]|onde|nao funcionou|não funcionou|ja reiniciei|já reiniciei)/i.test(message.trim());
  if(reference&&analysis.intent==="general_information"){const previous=[...history].reverse().find(item=>item.role==="customer"&&analyzeIntent(item.content).intent!=="general_information")??[...history].reverse().find(item=>item.role==="agent");if(previous){const inferred=analyzeIntent(previous.content);if(inferred.intent!=="general_information")analysis={...inferred,confidence:.9}}}
  if(/cad[eê]|onde.*pix|nao recebi|não recebi/i.test(message)&&history.some(item=>/pix/i.test(item.content)))analysis={intent:"financial_pix",confidence:.98,goal:"Reentregar PIX já solicitado"};
  const tools = execute(analysis.intent,message);
  const recentAgent=history.filter(item=>item.role==="agent").map(item=>item.content);
  let response = responseFor(analysis.intent, message);
  let repeated=repetitionScore(response,recentAgent)>.72;
  if(repeated){const artifact=tools.find(tool=>tool.artifact)?.artifact;response=artifact?`Você tem razão em cobrar. Reenviei o mesmo ${artifact.label.toLowerCase()} logo abaixo, sem gerar uma cobrança duplicada.`:`Já considerei o que você informou e não vou repetir a orientação anterior. Avancei o atendimento com os dados disponíveis.`;repeated=repetitionScore(response,recentAgent)>.72}
  if(repeated)response="Para não repetir uma orientação que já não resolveu, transferi o contexto completo para revisão humana.";
  const delivered = tools.every((tool) => tool.status === "completed");
  const artifacts = tools.filter((tool) => tool.artifact).length;
  return {
    ...analysis,
    state: analysis.intent === "human_handoff" ? "handoff" : delivered ? "delivered" : "waiting_customer",
    response,
    tools,
    pendingTools: [],
    conversationSummary: `${history.length + 1} mensagem(ns). Objetivo atual: ${analysis.goal}. ${tools.length} ação(ões) executada(s), ${artifacts} artefato(s) entregue(s).`,
    nextStep: analysis.intent.startsWith("technical_") ? "Aguardar resposta do cliente e continuar o diagnóstico" : "Confirmar que o cliente recebeu a entrega",
    evaluation: evaluate(response, analysis.intent,recentAgent,tools.filter(tool=>tool.status==="completed").length),
    conversationState:{activeGoal:analysis.goal,step:delivered?"resultado_entregue":"aguardando",collectedData:["cliente identificado","contrato localizado"],pendingQuestion:questionCount(response)?response.split(".").find(part=>part.includes("?"))?.trim()??null:null,suppliedInformation:history.filter(item=>item.role==="customer").slice(-5).map(item=>item.content),promisedActions:[],executedActions:tools.filter(tool=>tool.status==="completed").map(tool=>tool.tool),artifacts:tools.flatMap(tool=>tool.artifact?[tool.artifact.value]:[]),blocker:tools.some(tool=>tool.status==="failed")?"tool_failure":null,nextStep:analysis.intent.startsWith("technical_")?"validar resolução":"confirmar recebimento",fingerprints:[{normalizedText:normalizeResponse(response),intent:analysis.intent,goal:analysis.goal,actions:tools.map(tool=>tool.tool),artifacts:tools.flatMap(tool=>tool.artifact?[tool.artifact.type]:[]),at:new Date().toISOString()}]},
    correlationId: `lzr-${Date.now().toString(36)}`,
  };
}
