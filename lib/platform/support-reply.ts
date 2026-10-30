import { asksRestart, troubleshootingContext } from "../agent/troubleshooting-context.ts";
import type { ChatMessage, Intent } from "../agent/types.ts";
import { resolveReply, validateReplyText, type ReplyOverrides } from "./reply-templates-shared.ts";

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

export function resolveSupportReply(input: SupportReplyInput): string {
  if (asksAiIdentity(input.message)) {
    const identity = "Sou a assistente virtual da BBNET, uma IA.";
    // Identity does not erase an explicit request or an unsafe request's refusal.
    return input.intent === "general_information"
      ? `${identity} Posso ajudar com as primeiras orientações; quando for preciso, o atendimento deve continuar com uma pessoa da equipe.`
      : `${identity} ${resolveReply(input.intent)}`;
  }

  // Explicitly published copy stays under the operator's control. It needs its
  // own review before rollout; changing defaults must not silently rewrite it.
  const context = troubleshootingContext(input.message, input.history);
  // A published instruction must not re-request a step already reported done.
  // Other operator text stays intact; this is a narrow anti-repeat guard.
  const continuingRestart = (context.restarted || context.attemptedWithoutResult)
    && input.intent.startsWith("technical_") && !asksRestart(input.message)
    && /^(?:por favor[, ]+)?(?:para reiniciar|reinicie|reinicia|tire da tomada|desligue)\b/i.test(input.templates?.[input.intent]?.trim() ?? "");
  const edited = input.templates?.[input.intent]?.trim();
  if (edited && validateReplyText(edited) === null && !continuingRestart) return edited;

  const current = normalize(input.message);
  const customer = [...context.recent.filter((turn) => turn.role === "customer").map((turn) => turn.content), input.message];
  const agents = context.recent.filter((turn) => turn.role === "agent").map((turn) => normalize(turn.content));

  if (input.intent === "unauthorized_request" || input.intent === "out_of_scope"
    || input.intent === "human_handoff" || input.intent === "cancellation_risk"
    || input.intent.startsWith("financial_")) return resolveReply(input.intent);

  if ((input.intent.startsWith("technical_") || input.intent === "general_information") && context.resolved) {
    return "Que bom que você relata que a conexão voltou a funcionar. Se o problema reaparecer, conte por aqui o que aconteceu.";
  }

  if (input.handoffReason === "customer_irritated" || expressesFrustration(input.message)) {
    return "Entendo sua frustração. Esse caso precisa da atenção de um atendente, usando o que você já contou aqui.";
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
    const cableReport = reports.findLast((text) => /\b(?:via|pelo|no|por) cabo\b/.test(text)
      && !/\b(?:nao|nem) (?:testei|usei|liguei|conectei)|\bsem cabo\b/.test(text));
    const cableNormal = cableReport && /\bcabo (?:esta |ta |ficou )?(?:normal|bom|boa)\b|\bcabo funciona (?:bem|normalmente)\b/.test(cableReport);
    const scopeKnown = /\btodos (?:os )?(?:aparelhos|dispositivos)\b|\bso (?:em )?(?:um|no celular|na tv)\b/.test(combined);
    const scopeAsked = agents.some((text) => text.includes("todos os aparelhos ou so em um"));
    const cableAsked = agents.some((text) => text.includes("conectado por cabo ou so no wi-fi") || /usando wi-fi ou cabo/.test(text));
    const appsAsked = agents.some((text) => text.includes("todos os sites e aplicativos"));
    const appsKnown = /\b(?:todos|qualquer) (?:os )?(?:sites|aplicativos)|\bso (?:o|a|no|na) (?:youtube|netflix|whatsapp|instagram)\b|\b(?:youtube|netflix|whatsapp|instagram|partidas? online)\b.{0,30}\b(?:trava|cai|lento)/.test(combined);
    if (appsAsked || appsKnown) return "A equipe técnica precisa continuar a verificação com o que você já contou. Ainda não tenho uma causa confirmada por aqui.";
    if (cableNormal) return `${prefix}Você informou que pelo cabo está normal. No aparelho com lentidão, isso acontece em todos os sites e aplicativos ou só em algum específico?`;
    if (cableReport) return `${prefix}Considerando o uso de cabo que você informou, a lentidão acontece em todos os sites e aplicativos ou só em algum específico?`;
    if (cableAsked) return "A equipe técnica precisa continuar a verificação com o que você já contou. Ainda não tenho uma causa confirmada por aqui.";
    if (scopeKnown || scopeAsked) return `${prefix}Isso acontece também em um aparelho conectado por cabo ou só no Wi-Fi?`;
    return `${prefix}${resolveReply("technical_slow")}`;
  }

  if (input.intent === "general_information" && agents.length > 0) {
    return "Ainda não consegui identificar o que você precisa. Um atendente pode continuar a partir desta conversa, sem começar tudo de novo.";
  }
  return resolveReply(input.intent, input.templates);
}
