import type { AutoReplySender, ChannelMessageInput, ChannelMessageRow, ChannelRepository, ChannelResponse } from "./n8n-channel-service.ts";
import type { DoubtBotInput, DoubtBotResult } from "./doubt-bot-service.ts";
import { explicitSupportDaypart, freshSupportDaypart, technicalReplyLayout, type CurrentTechnicalComplaint, type SupportDaypart } from "./current-support-tone.ts";

const folded = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
/** Match only a greeting, never a name, payload, or appended request. */
export function publicGreeting(text: string): string | undefined {
  if (text.length > 55 || !/^[\p{L}\p{M} ,.!?]+$/u.test(text)) return undefined;
  const value = folded(text).replace(/[,.!?]/g, " ").replace(/ +/g, " ").trim();
  return /^(?:(?:ola|oi)(?: (?:bom dia|boa tarde|boa noite))?|bom dia|boa tarde|boa noite)(?: tudo bem)?$/.test(value)
    ? text.trim() : undefined;
}

export function safeGreetingModelQuestion(text: string, incoming: string, requiredDaypart?: SupportDaypart): boolean {
  if (text.length > 95 || !/^[\p{L}\p{M} ,.!]+\?$/u.test(text)) return false;
  const value = folded(text).replace(/[,.!]/g, " ").replace(/ +/g, " ").replace(/ \?$/, "?");
  const response = /^(?:(?:oi|ola) )?(?:(bom dia|boa tarde|boa noite) )?(?:(?:como|em que) (?:posso|podemos) (?:ajudar|te ajudar|lhe ajudar|ajudar voce|ser util)|posso (?:(?:te|lhe) )?ajudar)(?: hoje)?\?$/.exec(value);
  const requestedDaypart = requiredDaypart ?? explicitSupportDaypart(incoming);
  return !!response && response[1] === requestedDaypart
    && (!requestedDaypart || value.startsWith(`${requestedDaypart} `));
}

export function protectedTechnicalIntent(intent?: string | null) {
  return intent?.startsWith("technical_") === true;
}
const RESTART_TRIED_REPORT = "Cliente relata que está sem internet e que já reiniciou os equipamentos, sem recuperar a conexão.";
const CURRENT_GREETING_PREFIX = "^(?:(?:oi|ola)(?: (?:bom dia|boa tarde|boa noite))? |(?:bom dia|boa tarde|boa noite) )?";
// Compose complete, bounded components rather than enumerating sentences.
const CURRENT_OUTAGE = "(?:(?:ainda )?(?:estou |to |continuo |sigo )?sem (?:internet|conexao)|(?:a |minha )?internet (?:caiu|nao funciona))";
const CURRENT_TIME = "(?: desde (?:ontem|hoje|cedo|mais cedo|esta manha))?";
const RESTART_EQUIPMENT = "(?:o modem e o roteador|o roteador e o modem|os equipamentos|meus equipamentos|os aparelhos|o modem|o roteador|a (?:onu|ont)|(?:onu|ont)|tudo|modem|roteador)";
const RESTART_ATTEMPT = "(?:ja )?(?:reiniciei|desliguei e liguei de novo)(?: " + RESTART_EQUIPMENT + ")?";
const RESTART_RESULT_LINK = "(?:e |mas )?(?:(?:mesmo|ainda) assim )?";
const CONNECTION_STILL_DOWN = "(?:(?:ainda (?:estou|to)|continuo|continua|sigo|segue) sem (?:internet|conexao)|(?:a conexao|a internet) nao voltou)";
const OFFLINE_AFTER_RESTART = new RegExp(CURRENT_GREETING_PREFIX + "(?:eu )?(?:"
  + CURRENT_OUTAGE + "(?: aqui)?" + CURRENT_TIME + " "
  + "(?:e )?" + RESTART_ATTEMPT + " " + RESTART_RESULT_LINK
  + "(?:nada de voltar|nao voltou|nao adiantou|nao resolveu|" + CONNECTION_STILL_DOWN + ")"
  + "|" + RESTART_ATTEMPT + " " + RESTART_RESULT_LINK + CONNECTION_STILL_DOWN + CURRENT_TIME
  + ")(?: por favor)?$");

export function publicTechnicalQuestion(text: string): string | undefined {
  if (text.length > 140 || !/^[\p{L}\p{M} ,.!?-]+$/u.test(text)) return undefined;
  const value = folded(text).replace(/[,.!?-]/g, " ").replace(/ +/g, " ").trim();
  // Only a complete current symptom + action already attempted + failure to
  // recover. Never forward free-form additions, names, identifiers or old data.
  if (OFFLINE_AFTER_RESTART.test(value)) return RESTART_TRIED_REPORT;
  if (text.length > 100) return undefined;
  return /^(?:(?:oi|ola)(?: (?:bom dia|boa tarde|boa noite))? |(?:bom dia|boa tarde|boa noite) )?(?:eu )?(?:ainda )?(?:estou |estamos |continuo |continuamos |sigo |to |a |minha |meu |o )?(?:sem internet|sem conexao|internet caiu|internet nao funciona|internet lenta|wifi nao conecta|wi fi nao conecta|problema de conexao|conexao continua falhando|internet continua falhando|internet continua caindo)(?:(?: de novo| novamente))?(?: por favor)?$/.test(value)
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
type TechnicalDimension = "devices" | "light";
export type TechnicalQuestionStage = "initial" | "followup";
const META_ID = /^wamid\.[A-Za-z0-9_=+\/-]{1,240}$/;
const ANCHOR_MAX_AGE_MS = 15 * 60 * 1000;

function technicalQuestionShape(text: string): { dimension: TechnicalDimension; yesIsClear: boolean; noIsClear: boolean } | undefined {
  if (text.length > 135 || !/^[\p{L}\p{M} -]+\?$/u.test(text)) return undefined;
  const value = folded(text).replace(/-/g, " ").replace(/ +/g, " ");
  const asksOtherDevice = /^(?:(?:voce consegue|pode|voce pode) (?:verificar|conferir|dizer) se )?(?:o problema|isso) (?:acontece|ocorre) (?:tambem )?em (?:outro aparelho|mais de um aparelho|todos os aparelhos|todos os aparelhos ou so em um)\?$/;
  const asksLight = /^(?:(?:voce consegue|pode|voce pode) (?:verificar|conferir|dizer) se )?(?:alguma|uma) luz do roteador (?:esta|fica) vermelha\?$/;
  if (asksOtherDevice.test(value)) return { dimension: "devices", yesIsClear: !value.endsWith("ou so em um?"), noIsClear: !value.includes("todos os aparelhos") };
  if (asksLight.test(value)) return { dimension: "light", yesIsClear: true, noIsClear: true };
}

export function safeTechnicalModelQuestion(text: string): boolean {
  const layout = technicalReplyLayout(text);
  return !!layout && !!technicalQuestionShape(layout.question);
}

const technicalAnswerTokens = {
  severalDevices: "Cliente relata que o problema acontece em mais de um aparelho.",
  oneDevice: "Cliente relata que o problema acontece em apenas um aparelho.",
  redLight: "Cliente relata que há uma luz vermelha no roteador.",
  noRedLight: "Cliente relata que não há luz vermelha no roteador.",
} as const;

function technicalAnswer(text: string, shape: NonNullable<ReturnType<typeof technicalQuestionShape>>) {
  if (text.length > 75 || !/^[\p{L}\p{M} ,.!-]+$/u.test(text)) return undefined;
  const value = folded(text).replace(/[,.!-]/g, " ").replace(/ +/g, " ").trim();
  const yes = /^(?:sim|isso|sim mesmo)$/.test(value);
  const no = /^(?:nao|nao mesmo)$/.test(value);
  if (shape.dimension === "devices") {
    if ((shape.yesIsClear && yes) || /^(?:tambem em (?:outro|outros) aparelhos?|(?:em |n?os )?(?:dois|todos)(?: (?:os )?aparelhos)?|em mais de um aparelho)$/.test(value))
      return technicalAnswerTokens.severalDevices;
    if ((shape.noIsClear && no) || /^(?:so|somente|apenas)(?: no celular| no computador| num aparelho| em um aparelho| em um| neste aparelho)$/.test(value))
      return technicalAnswerTokens.oneDevice;
  } else {
    if (yes || /^(?:(?:a|uma|alguma) )?luz(?: do roteador)? (?:esta |fica |ta |ficou )?vermelha$/.test(value))
      return technicalAnswerTokens.redLight;
    if (no || /^(?:nenhuma luz(?: do roteador)? (?:esta |fica )?vermelha|nao (?:tem|ha) luz vermelha)$/.test(value))
      return technicalAnswerTokens.noRedLight;
  }
}

export type TechnicalContinuity =
  | { action: "ask"; anchorMessageId: string; nextDimension: TechnicalDimension; report: string }
  | { action: "hold" };

/**
 * A grammar match alone is not proof the customer was asked by this path.
 * Match the immediately preceding visible question and its preceding customer
 * row to the successful protected-response ledger before interpreting an answer.
 */
export async function technicalContinuity(
  repository: Pick<ChannelRepository, "findIdempotent">,
  history: ChannelMessageRow[],
  input: ChannelMessageInput,
  sentAt: string | undefined,
  now: number = Date.now(),
  replyToMessageId?: string | null,
): Promise<TechnicalContinuity | undefined> {
  const visible = history.filter(row => row.role !== "suggestion");
  const lastQuestionIndex = visible.findLastIndex(row => row.role === "agent");
  const lastQuestion = visible[lastQuestionIndex];
  if (!lastQuestion || lastQuestion.sentBy !== "ia" || !lastQuestion.externalMessageId || !lastQuestion.correlationId
    || !META_ID.test(lastQuestion.externalMessageId)) return undefined;
  const previous = technicalReplyLayout(lastQuestion.content);
  const shape = previous && technicalQuestionShape(previous.question);
  const questionAt = Date.parse(lastQuestion.createdAt ?? "");
  if (!shape || !Number.isFinite(questionAt) || questionAt > now || now - questionAt > ANCHOR_MAX_AGE_MS) return undefined;

  // A second inbound may arrive when a first answer already owns this turn.
  // In that case retain the new inbound for review, do not open a fresh turn.
  if (visible.at(-1) !== lastQuestion || lastQuestion.deliveryStatus === "failed") return { action: "hold" };
  const exactQuote = replyToMessageId === lastQuestion.externalMessageId;
  if (replyToMessageId !== undefined && !exactQuote) return { action: "hold" };
  if (!exactQuote && lastQuestion.deliveryStatus !== "delivered" && lastQuestion.deliveryStatus !== "read")
    return { action: "hold" };
  const sentByCustomerAt = Date.parse(sentAt ?? "");
  // A verified quote provides causality even within the source's same second.
  // For unquoted text require unambiguous time as well as delivered/read proof.
  const earliest = exactQuote ? Math.floor(questionAt / 1000) * 1000 : questionAt;
  if (!Number.isFinite(sentByCustomerAt) || sentByCustomerAt > now || sentByCustomerAt < earliest)
    return { action: "hold" };
  const preceding = visible.at(-2);
  if (preceding?.role !== "customer" || preceding.correlationId !== lastQuestion.correlationId
    || !preceding.externalMessageId || !META_ID.test(preceding.externalMessageId)
    || preceding.externalMessageId === input.idempotencyKey) return { action: "hold" };
  const accepted = await repository.findIdempotent(preceding.externalMessageId).catch(() => undefined);
  if (!accepted || accepted.technicalQuestionStage !== "initial" || !accepted.autoReply || accepted.status !== "replied"
    || accepted.handoff || accepted.correlationId !== lastQuestion.correlationId
    || accepted.externalMessageId !== lastQuestion.externalMessageId || accepted.response !== lastQuestion.content)
    return { action: "hold" };
  const report = technicalAnswer(input.text, shape);
  return report ? { action: "ask", anchorMessageId: lastQuestion.externalMessageId,
    nextDimension: shape.dimension === "devices" ? "light" : "devices", report } : { action: "hold" };
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
  continuation?: { sentAt?: string; replyToMessageId?: string | null; claimAnchor: (anchorMessageId: string) => Promise<boolean> };
  replyKind?: "greeting";
  providerSentAt?: string;
  complaint?: CurrentTechnicalComplaint & { kind: "frustrated" };
  reviewReason?: "guard_unverified_os_followup" | "guard_referred_technical_claim" | "guard_operator_paused" | "guard_current_complaint_needs_review";
};

export async function processProtectedTechnicalTurn(
  repository: ChannelRepository, input: ChannelMessageInput, options: TechnicalEmergencyOptions,
  continuation?: TechnicalContinuity,
): Promise<ChannelResponse> {
  const audit = (result: string) => repository.audit({
    correlationId: input.correlationId, entity: `conversation:${input.externalConversationId}`,
    action: "whatsapp.technical_safety", result, reason: result,
  }).catch(() => undefined);
  const pending: ChannelResponse = { response: null, autoReply: false, status: "waiting_manual_review", handoff: options.humanHandoff, correlationId: input.correlationId };
  const greeting = options.replyKind === "greeting";
  const anchored = !greeting && continuation?.action === "ask" ? continuation : undefined;
  const frustrated = !greeting && !continuation ? options.complaint : undefined;
  const question = greeting ? publicGreeting(input.text) : continuation ? anchored?.report : frustrated?.report ?? publicTechnicalQuestion(input.text);
  let daypart = !continuation && question ? (frustrated?.daypart ?? explicitSupportDaypart(input.text)) : undefined;
  const inferredDaypart = !continuation && question && !daypart && options.eligible && !options.humanHandoff
    && !options.privateFlowPending && !options.reviewReason ? freshSupportDaypart(options.providerSentAt) : undefined;
  if (inferredDaypart) {
    // History serves only as a first-contact proof; the model never receives it.
    const rows = await repository.getHistory(options.channel, input.externalConversationId).catch(() => undefined);
    if (rows?.every(row => row.role === "suggestion")) daypart = inferredDaypart;
  }
  const inScope = (value: string) => {
    if (greeting) return safeGreetingModelQuestion(value, input.text, daypart);
    const layout = technicalReplyLayout(value);
    const shape = layout && technicalQuestionShape(layout.question);
    return !!shape && layout.daypart === daypart && layout.empathetic === !!frustrated
      && (!anchored || shape.dimension === anchored.nextDimension);
  };
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
  if (!mayInvoke) return stop(options.reviewReason ?? (continuation ? "guard_technical_followup_needs_review" : "guard_no_eligible_model_or_public_technical_input"));
  if (anchored && !await options.continuation?.claimAnchor(anchored.anchorMessageId).catch(() => false))
    return stop("guard_technical_followup_anchor_unavailable");
  await audit("n8n_invoked");
  let generated: DoubtBotResult;
  try {
    generated = await options.answer!({
      intent: greeting ? "general_information" : "technical_no_connection", question: question!, history: [],
      task: [
        daypart ? `Comece com a saudação “${daypart}!” no português indicado.` : "Não use saudação de período.",
        greeting
          ? "A pessoa não informou uma necessidade. Escreva somente uma pergunta breve e cordial oferecendo ajuda."
          : [
            frustrated ? "A pessoa está frustrada. Com calma e sem confronto, reconheça brevemente com uma frase: “Entendo sua frustração.”, “Sinto muito pelo transtorno.”, “Lamento o transtorno.” ou “Sei que isso é frustrante.” Não mencione linguagem ofensiva." : "Não inclua frases além da saudação permitida e da pergunta.",
            question === RESTART_TRIED_REPORT
              ? "A pessoa já reiniciou os equipamentos e continua sem internet. Não peça que reinicie novamente. Vá direto a uma pergunta sobre outros aparelhos ou luz vermelha do roteador."
              : "",
            anchored?.nextDimension === "devices" ? "Pergunte apenas se o problema acontece em outro aparelho."
              : anchored?.nextDimension === "light" ? "Pergunte apenas se alguma luz do roteador está vermelha."
                : "A pessoa já descreveu a necessidade. Vá direto à pergunta sobre outro aparelho ou luz vermelha do roteador, sem perguntar como pode ajudar.",
          ].filter(Boolean).join(" "),
        "Escreva uma única pergunta breve em português. Não dê diagnóstico, não peça dados, não afirme estado do cliente, não prometa visita, não execute ações. Use state ongoing sem ação. Se não tiver pergunta apropriada, responda NAO_SEI.",
      ].join(" "),
    });
  } catch { return stop("n8n_failed"); }
  if (generated.kind !== "answer") return stop(generated.kind === "none" ? "n8n_no_answer" : "n8n_failed");
  if (generated.action || (generated.state && generated.state !== "ongoing") || !inScope(generated.text))
    return stop("model_question_outside_allowlist");
  const delivery = await options.sender!({ conversationId: input.externalConversationId, text: generated.text, inboundMessageId: input.idempotencyKey })
    .catch(() => undefined);
  if (!delivery?.sent) return stop(delivery ? `meta_${delivery.outcome}` : "meta_outcome_unknown");
  if (delivery.text && !inScope(delivery.text)) return stop("previous_meta_receipt_requires_review");
  const sent = { response: delivery.text ?? generated.text, autoReply: true, status: "replied",
    handoff: false, correlationId: input.correlationId, externalMessageId: delivery.messageId,
    // An older receipt may prove an accepted reply but not its provenance in this model turn.
    technicalQuestionStage: greeting || (delivery.text && delivery.text !== generated.text) ? undefined : anchored ? "followup" : "initial",
  } satisfies ChannelResponse;
  await repository.saveMessages(options.channel, input.externalConversationId, [
    { role: "agent", content: sent.response, correlationId: input.correlationId, externalMessageId: delivery.messageId, sentBy: "ia" },
  ]);
  await audit("meta_accepted");
  await repository.saveIdempotency(input.idempotencyKey, options.channel, input.externalConversationId, sent);
  return sent;
}
