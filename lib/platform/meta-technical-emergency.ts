import type { AutoReplySender, ChannelMessageInput, ChannelRepository, ChannelResponse } from "./n8n-channel-service.ts";
import type { DoubtBotInput, DoubtBotResult } from "./doubt-bot-service.ts";

const folded = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
export function protectedTechnicalIntent(intent?: string | null) {
  return intent?.startsWith("technical_") === true;
}
export function publicTechnicalQuestion(text: string): string | undefined {
  if (text.length > 100 || !/^[\p{L}\p{M} ,.!?-]+$/u.test(text)) return undefined;
  const value = folded(text).replace(/[,.!?-]/g, " ").replace(/ +/g, " ").trim();
  return /^(?:(?:oi|ola|bom dia|boa tarde|boa noite) )?(?:ainda )?(?:estou |estamos |continuo |continuamos |sigo |to |a |minha |meu |o )?(?:sem internet|sem conexao|internet caiu|internet nao funciona|internet lenta|wifi nao conecta|wi fi nao conecta|problema de conexao|conexao continua falhando|internet continua falhando|internet continua caindo)(?: por favor)?$/.test(value)
    ? text.trim() : undefined;
}

const orderReference = (text: string) =>
  /\b(?:chamado|ordem de servico)\b/.test(folded(text))
  || /\bo\s*\.\s*s(?:\.|\b)/i.test(text)
  || /\b(?:da|dessa|desta|daquela|esta|essa|aquela|uma|qual)\s+os\b|\bos\s+(?:n[°º]|\d|aberta|em andamento|em curso)\b/.test(folded(text));

/** Explicit requests for identifiers or status are not basic troubleshooting. */
export function explicitUnverifiedOrderFollowup(text: string): boolean {
  return orderReference(text) && (text.includes("?")
    || /\b(?:qual|numero|protocolo|estado|status|andamento|confirma|confirme|informe|mostre|diga|me passa|quero saber)\b/.test(folded(text)));
}

export function ambiguousTechnicalReference(text: string): boolean {
  const value = folded(text).replace(/[,.!?]/g, " ").replace(/ +/g, " ").trim();
  return /^(?:qual(?: e| era| foi)? (?:o numero|a referencia)(?: (?:dela|dele|dessa|desse|disso))?|qual (?:dela|dele|dessa|desse|foi essa|foi esse)|(?:e|era|foi) (?:essa|esse|aquela|aquele)(?: que (?:voce|voces) (?:falou|falaram|mencionou|mencionaram))?)$/.test(value);
}

export function previousTechnicalAssertion(text: string): boolean {
  const value = folded(text).replace(/\s+/g, " ");
  return (orderReference(text) && /\b(?:em andamento|em curso|em atendimento|ja existe|ja tem|abert[ao]|em acompanhamento|pendente|finalizad[ao]|encerrad[ao])\b/.test(value))
    || /\b(?:potencia optica|sinal optico|(?:sinal|medicao|leitura|potencia) (?:da|de) fibra)\b[^!?;]{0,100}\b(?:no limite|perto do limite|limitrofe|fraco|critico|instavel|alto|baixo|bom|normal)\b/.test(value)
    || /(?:-|−)\d{1,3}(?:[.,]\d+)?\s*dbm\b/.test(value);
}

/** A strict language for one neutral diagnostic question, not a denylist of
 * paraphrases. The model chooses and writes the question; there is no template fallback. */
export function safeTechnicalModelQuestion(text: string): boolean {
  if (text.length > 135 || !/^[\p{L}\p{M} -]+\?$/u.test(text)) return false;
  const value = folded(text).replace(/-/g, " ").replace(/ +/g, " ");
  const asksOtherDevice = /^(?:(?:voce consegue|pode|voce pode) (?:verificar|conferir|dizer) se )?(?:o problema|isso) (?:acontece|ocorre) (?:tambem )?em (?:outro aparelho|mais de um aparelho|todos os aparelhos|todos os aparelhos ou so em um)\?$/;
  const asksLight = /^(?:(?:voce consegue|pode|voce pode) (?:verificar|conferir|dizer) se )?(?:alguma|uma) luz do roteador (?:esta|fica) vermelha\?$/;
  return asksOtherDevice.test(value) || asksLight.test(value);
}

export type TechnicalEmergencyOptions = {
  channel: string;
  priorIntent?: string | null;
  humanHandoff: boolean;
  privateFlowPending: boolean;
  eligible: boolean;
  answer?: (input: DoubtBotInput) => Promise<DoubtBotResult>;
  sender?: AutoReplySender;
  reserveInbound: (input: ChannelMessageInput) => Promise<boolean>;
  reviewReason?: "guard_unverified_os_followup" | "guard_referred_technical_claim" | "guard_operator_paused";
};

export async function processProtectedTechnicalTurn(
  repository: ChannelRepository, input: ChannelMessageInput, options: TechnicalEmergencyOptions,
): Promise<ChannelResponse> {
  const audit = (result: string) => repository.audit({
    correlationId: input.correlationId, entity: `conversation:${input.externalConversationId}`,
    action: "whatsapp.technical_safety", result, reason: result,
  }).catch(() => undefined);
  const pending: ChannelResponse = { response: null, autoReply: false, status: "waiting_manual_review", handoff: options.humanHandoff, correlationId: input.correlationId };
  const question = publicTechnicalQuestion(input.text);
  const mayInvoke = !options.reviewReason && options.eligible && !options.humanHandoff && !options.privateFlowPending && !!question && !!options.answer && !!options.sender;
  // The inbound and WAMID claim commit together before any external call.
  // An interrupted or ambiguous attempt stays visible for human review; no retry.
  if (!await options.reserveInbound(input)) {
    await audit("duplicate_or_interrupted");
    return pending;
  }
  const stop = async (reason: string) => {
    await audit(reason);
    await repository.saveIdempotency(input.idempotencyKey, options.channel, input.externalConversationId, pending);
    return pending;
  };
  if (!mayInvoke) return stop(options.reviewReason ?? "guard_no_eligible_model_or_public_technical_input");
  await audit("n8n_invoked");
  let generated: DoubtBotResult;
  try {
    generated = await options.answer!({
      intent: "technical_no_connection", question: question!, history: [],
      task: "Escreva uma única pergunta breve em português, sobre se o problema acontece em outro aparelho ou se alguma luz do roteador está vermelha. Não dê diagnóstico, não peça dados, não afirme estado do cliente, não prometa visita, não execute ações. Se não tiver pergunta apropriada, responda NAO_SEI.",
    });
  } catch { return stop("n8n_failed"); }
  if (generated.kind !== "answer") return stop(generated.kind === "none" ? "n8n_no_answer" : "n8n_failed");
  if (generated.action || (generated.state && generated.state !== "ongoing") || !safeTechnicalModelQuestion(generated.text))
    return stop("model_question_outside_allowlist");
  const delivery = await options.sender!({ conversationId: input.externalConversationId, text: generated.text, inboundMessageId: input.idempotencyKey })
    .catch(() => undefined);
  if (!delivery?.sent) return stop(delivery ? `meta_${delivery.outcome}` : "meta_outcome_unknown");
  if (delivery.text && !safeTechnicalModelQuestion(delivery.text)) return stop("previous_meta_receipt_requires_review");
  const sent = { response: delivery.text ?? generated.text, autoReply: true, status: "replied",
    handoff: false, correlationId: input.correlationId, externalMessageId: delivery.messageId };
  await repository.saveMessages(options.channel, input.externalConversationId, [
    { role: "agent", content: sent.response, correlationId: input.correlationId, externalMessageId: delivery.messageId, sentBy: "ia" },
  ]);
  await audit("meta_accepted");
  await repository.saveIdempotency(input.idempotencyKey, options.channel, input.externalConversationId, sent);
  return sent;
}
