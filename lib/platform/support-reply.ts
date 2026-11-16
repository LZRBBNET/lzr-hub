import { servicePreferences } from "../agent/service-preferences.ts";
import { asksRestart, troubleshootingContext, supportRequest, supportReportSummary, negatesSupportRequest, pendingSupportRequest } from "../agent/troubleshooting-context.ts";
import type { ChatMessage, Intent } from "../agent/types.ts";
import { isProtectedFinancialReply, resolveReply, validateReplyText, type ReplyOverrides } from "./reply-templates-shared.ts";

/**
 * Small, deterministic adaptations of approved replies. This is NOT model
 * generation or a diagnosis: customer statements remain reports, not IXC facts.
 * The caller supplies recent, delivered history (never unsent suggestions).
 * No name, account status, outage, ETA or completed action is inferred here.
 */
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function asksAiIdentity(message: string): boolean {
  return /\b(?:voce|vc|voces|vcs) (?:e|eh|sao) (?:um |uma )?(?:robo|bot|ia|inteligencia artificial|humano|humana|pessoa)\b|\bestou falando com (?:um |uma )?(?:robo|bot|ia|humano|humana|pessoa)\b/.test(normalize(message));
}

export function requestsHuman(message: string): boolean {
  return /\b(?:quero|preciso|prefiro|posso|pode|chame|chama|chamar|falar|fale|transfira|transferir|passe|passa)\b.{0,50}\b(?:atendente|humano|humana|pessoa|supervisor)\b/.test(normalize(message));
}

export function expressesFrustration(message: string): boolean {
  return /\b(?:absurdo|porcaria|incompetente|raiva|terceira vez)\b/.test(normalize(message));
}

export interface SupportReplyInput {
  intent: Intent;
  message: string;
  history: ChatMessage[];
  handoffReason?: string | null;
  templates?: ReplyOverrides;
}

function resolveSupportReplyContent(input: SupportReplyInput): string {

  const preference = servicePreferences(input.message, troubleshootingContext(input.message, input.history).recent);
  if (input.intent !== "unauthorized_request") {
    if (preference.directThreat || preference.ambiguousThreat) return "Essa mensagem precisa da avaliação de um responsável. O atendimento pode continuar com a equipe, sem prolongar os testes por aqui.";
    if (preference.nonContractCancellation) return "A menção a esse pedido ou item precisa ser conferida por um atendente, sem presumir que você deseja cancelá-lo. Não há alteração confirmada por aqui.";
    if (preference.dispute) return "Entendo sua preocupação. A cobrança que você não reconhece precisa ser conferida por um atendente antes de qualquer conclusão.";
    if (preference.explicitCancellation) return "Entendi seu pedido de cancelamento. Ele precisa ser tratado por um atendente; ainda não há cancelamento confirmado por aqui.";
    if (preference.persistentInsult) return "Quero ajudar a resolver, mas precisamos continuar sem ofensas pessoais. O caso precisa da avaliação de um atendente; o atendimento continua disponível.";
  }

  // Clear requests to stop triage take priority over optional operator copy.
  // This renders a truthful pending next step, not an executed transfer or OS.
  const request = supportRequest(input.message);
  if (!request && negatesSupportRequest(input.message) && input.intent === "general_information") return "Tudo bem. Não vou tratar isso como um pedido de atendimento.";
  if (["human_handoff", "technical_visit", "technical_ticket"].includes(input.intent) && request) {
    const summary = supportReportSummary(input.message, input.history);
    if (request === "pause") return `Tudo bem, não vou insistir em testes agora. ${summary}O próximo passo é um atendente revisar esse contexto.`;
    if (request === "visit") return `Sinto muito pelo transtorno. Entendi o pedido de avaliação técnica. ${summary}A equipe precisa avaliar a visita e confirmar a disponibilidade; não consigo confirmar um agendamento por aqui.`;
    if (request === "ticket") return `Entendi o pedido de chamado. ${summary}Um atendente precisa conferir e dar continuidade; ainda não tenho abertura ou protocolo confirmados.`;
    return summary ? `Certo, sem mais testes por aqui. ${summary}O próximo passo é continuar com um atendente.` : resolveReply("human_handoff");
  }

  // An unresolved customer request survives short classifier windows. Do not
  // carry it into billing/cancellation or an explicitly different topic.
  const pending = pendingSupportRequest(input.message, input.history);
  if (pending && (input.intent.startsWith("technical_") || input.intent === "general_information")
    && !troubleshootingContext(input.message, input.history).resolved) {
    const summary = supportReportSummary(input.message, input.history);
    if (pending === "visit") return `Seu pedido de avaliação técnica continua como contexto desta conversa. ${summary}A equipe precisa avaliar a visita e confirmar a disponibilidade; ainda não tenho agendamento confirmado.`;
    if (pending === "ticket") return `Você pediu um chamado. ${summary}Um atendente precisa conferir e continuar; ainda não tenho abertura ou protocolo confirmados.`;
    return `Não vou insistir em testes. ${summary}O próximo passo é um atendente revisar esse contexto; não tenho encaminhamento confirmado.`;
  }

  // No operational receipt is passed here. Saved prose cannot prove a payment,
  // invoice delivery, agreement, unlock or future handoff/return.
  if (isProtectedFinancialReply(input.intent)) return resolveReply(input.intent, input.templates);

  const context = troubleshootingContext(input.message, input.history);
  // Contextual technical decisions run BEFORE operator copy. A saved template
  // is only a fallback, never a way to repeat completed steps or known questions.
  // This does not try to prove arbitrary custom prose semantically compatible.
  // When an attempt/resolution is known, suppress technical custom copy entirely,
  // except when the customer explicitly asks again how to restart.
  const technical = input.intent.startsWith("technical_");
  const technicalTemplates = technical && !asksRestart(input.message)
    && (context.restarted || context.attemptedWithoutResult || context.resolved)
    ? undefined : input.templates;
  const edited = input.templates?.[input.intent]?.trim();
  if (!technical && edited && validateReplyText(edited) === null) return edited;

  const current = normalize(input.message);
  const customer = [...context.recent.filter((turn) => turn.role === "customer").map((turn) => turn.content), input.message];
  const agents = context.recent.filter((turn) => turn.role === "agent").map((turn) => normalize(turn.content));

  if (input.intent === "unauthorized_request" || input.intent === "out_of_scope"
    || input.intent === "human_handoff" || input.intent === "cancellation_risk"
    || input.intent.startsWith("financial_")) return resolveReply(input.intent);

  if ((input.intent.startsWith("technical_") || input.intent === "general_information") && context.resolved) {
    return "Que bom que você relata que a conexão voltou a funcionar. Se o problema reaparecer, conte por aqui o que aconteceu.";
  }


  // The simulation pipeline's similarity heuristic can flag short menu choices
  // as repetition. Only use the copy when a substantive customer report repeats.
  if (input.handoffReason === "repetition_without_resolution" && current.length > 15
    && input.history.some((turn) => turn.role === "customer" && normalize(turn.content) === current)) {
    return "Sinto muito pelo transtorno. Para não insistir em orientações que não ajudaram, um atendente precisa continuar com o histórico desta conversa.";
  }

  if (input.intent.startsWith("technical_") && /\b(?:regiao|bairro|rua|vizinhos|massiva)\b/.test(current)
    && /sem (?:internet|conexao|net)|caiu|falha|problema|volt[ae]|prazo/.test(current)) {
    return "Ainda não tenho confirmação de falha na região nem de prazo de retorno. A equipe técnica precisa verificar o que aconteceu.";
  }

  if (input.intent === "technical_no_connection" || input.intent === "technical_restart") {
    if (asksRestart(input.message)) return resolveReply("technical_restart", input.templates);
    const restarted = context.restarted;
    const lightReported = customer.some((text) => /\b(?:luz|luzes|los|pon)\b.{0,50}\b(?:vermelh\w*|apagad\w*|pisc\w*|verde\w*|norma\w*)\b/.test(normalize(text)));
    const lightAsked = agents.some((text) => /alguma luz do equipamento/.test(text));
    if (lightReported) return "Com o que você contou sobre o equipamento, a equipe técnica precisa verificar a conexão. Ainda não tenho um diagnóstico confirmado por aqui.";
    if (lightAsked) return "Para não repetir a mesma pergunta, o próximo passo é a equipe técnica verificar a conexão. Ainda não tenho um diagnóstico confirmado por aqui.";
    if (context.attemptedWithoutResult) return "Para não insistir em uma orientação que não ajudou, vamos verificar outra informação: alguma luz do equipamento está vermelha ou apagada?";
    if (restarted) return "Como você já reiniciou, não vou pedir isso de novo. Alguma luz do equipamento está vermelha ou apagada?";
  }

  if (input.intent === "technical_wifi") {
    if (agents.some((text) => text.includes("o sinal melhora perto do roteador"))) return "A equipe técnica precisa verificar o Wi-Fi com base no que você já contou. Ainda não tenho uma causa confirmada por aqui.";
    if (customer.some((text) => /\b(?:quarto|sala|cozinha|banheiro|varanda)\b/.test(normalize(text)))
      || agents.some((text) => text.includes("o problema no wi-fi acontece em qual comodo"))) return "O sinal melhora perto do roteador?";
  }

  if (input.intent === "technical_slow") {
    const prefix = context.restarted ? "Como você já reiniciou e a lentidão continua, não vamos repetir essa etapa. " : "";
    const reports = customer.map(normalize).filter((text) => !text.includes("?"));
    const combined = reports.join(". ");
    const latestCable = reports.findLast((text) => /\bcabo\b/.test(text));
    const cableReport = latestCable && /\b(?:via|pelo|no|por) cabo\b/.test(latestCable)
      && !/\b(?:nao|nem) (?:testei|usei|liguei|conectei)|\bsem cabo\b/.test(latestCable) ? latestCable : undefined;
    const cableNormal = cableReport && /\bcabo (?:esta |ta |ficou )?(?:normal|bom|boa)\b|\bcabo funciona (?:bem|normalmente)\b/.test(cableReport);
    const latestScope = reports.findLast((text) => /\btodos (?:os )?(?:aparelhos|dispositivos)\b|\bso (?:em )?(?:um|no celular|na tv)\b/.test(text));
    const scopeKnown = /\btodos (?:os )?(?:aparelhos|dispositivos)\b|\bso (?:em )?(?:um|no celular|na tv)\b/.test(latestScope ?? "");
    const scopeAsked = agents.some((text) => text.includes("todos os aparelhos ou so em um"));
    const cableAsked = agents.some((text) => text.includes("conectado por cabo ou so no wi-fi") || /usando wi-fi ou cabo/.test(text));
    const appsAsked = agents.some((text) => text.includes("todos os sites e aplicativos"));
    const appsKnown = /\b(?:todos|qualquer) (?:os )?(?:sites|aplicativos)|\bso (?:o|a|no|na) (?:youtube|netflix|whatsapp|instagram)\b|\b(?:youtube|netflix|whatsapp|instagram|partidas? online)\b.{0,30}\b(?:trava|cai|lento)/.test(combined);
    if (appsAsked || appsKnown) return "A equipe técnica precisa continuar a verificação com o que você já contou. Ainda não tenho uma causa confirmada por aqui.";
    if (cableNormal) return `${prefix}Você informou que pelo cabo está normal. No aparelho com lentidão, isso acontece em todos os sites e aplicativos ou só em algum específico?`;
    if (cableReport) return `${prefix}Considerando o uso de cabo que você informou, a lentidão acontece em todos os sites e aplicativos ou só em algum específico?`;
    if (cableAsked) return "A equipe técnica precisa continuar a verificação com o que você já contou. Ainda não tenho uma causa confirmada por aqui.";
    if (scopeKnown || scopeAsked) return `${prefix}Isso acontece também em um aparelho conectado por cabo ou só no Wi-Fi?`;
    return `${prefix}${resolveReply("technical_slow", technicalTemplates)}`;
  }

  if (input.intent === "general_information" && /\binternet|\bconexao\b/.test(current) && agents.length === 0) {
    return "Quero ajudar com a conexão. Qual problema você está percebendo na internet?";
  }
  if (input.intent === "general_information" && agents.length > 0) {
    return "Ainda não consegui identificar o que você precisa. Um atendente pode continuar a partir desta conversa, sem começar tudo de novo.";
  }
  return resolveReply(input.intent, technicalTemplates);
}

/** Identity disclosure must not erase completed tests, visit requests or refusal. */
export function resolveSupportReply(input: SupportReplyInput): string {
  const body = resolveSupportReplyContent(input);
  return asksAiIdentity(input.message) ? `Sou a assistente virtual da BBNET, uma IA. ${body}` : body;
}
