import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db/index.ts";
import { channelMessages } from "../../db/schema.ts";
import { DbReplyRepository } from "./attendant-reply-service.ts";
import type { ChannelMessageInput, ChannelMessageRow } from "./n8n-channel-service.ts";

const WAMID = /^wamid\.[A-Za-z0-9_=+\/-]{1,240}$/;
const number = /^[1-9][0-9]{9,14}$/;
const official = /^[1-9][0-9]{7,24}$/;
const MAX_INTERVAL = 2 * 60 * 60 * 1000;
type Env = Readonly<Record<string, string | undefined>>;
export type PilotMessage = { kind: string; phone: string; canonicalSender?: boolean; phoneNumberId?: string; messageId: string; sentAt?: string; text?: string; replyToMessageId?: string | null };
export type PilotConfig = { recipient: string; sender: string; startedAt: number; endsAt: number };
export type PilotTurn = "choice" | "pix" | "boleto" | "paid";
export const OWNER_FINANCE_REPLY: Record<PilotTurn, string> = {
  choice: "Você prefere pagar por Pix ou boleto?",
  pix: "Se a fatura estiver disponível na Central do Assinante da BB NET, confira o valor e o beneficiário antes de pagar por Pix. Por aqui, não foi gerado nenhum código Pix.",
  boleto: "Se a fatura estiver disponível na Central do Assinante da BB NET, procure a opção de segunda via. Por aqui, nenhum boleto foi emitido nem enviado.",
  paid: "Não consigo confirmar esse pagamento por aqui. Confira o comprovante com o financeiro antes de pagar de novo.",
};
const CURRENT = { choice: "Pedido de opções de pagamento", pix: "Escolha de pagamento por Pix", boleto: "Escolha de pagamento por boleto", paid: "Pagamento informado, sem confirmação" };

/** No general enablement; exact signed official phone, canonical test sender and
 * configured interval. Directions only; this is not customer/holder verification. */
export function ownerFinancePilotScope(env: Env, msg: PilotMessage, expectedRecipient: string | undefined, now = Date.now()): PilotConfig | undefined {
  const sender = env.META_OWNER_FINANCE_PILOT_SENDER;
  const recipient = env.META_PHONE_NUMBER_ID?.trim();
  const recipientOverride = env.META_OWNER_FINANCE_PILOT_RECIPIENT;
  const startedAt = Date.parse(env.META_OWNER_FINANCE_PILOT_STARTED_AT ?? "");
  const endsAt = Date.parse(env.META_OWNER_FINANCE_PILOT_ENDS_AT ?? "");
  const sentAt = Date.parse(msg.sentAt ?? "");
  if (env.FEATURE_META_OWNER_FINANCE_PILOT !== "true" || env.FEATURE_META_OWNER_FINANCE_PILOT_PAUSED === "true" ||
    msg.kind !== "text" || msg.canonicalSender !== true || !sender || !number.test(sender) || msg.phone !== sender ||
    !recipient || !official.test(recipient) || (recipientOverride !== undefined && recipientOverride !== recipient) ||
    recipient !== expectedRecipient || msg.phoneNumberId !== recipient ||
    !Number.isSafeInteger(now) || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endsAt) || !Number.isSafeInteger(sentAt) ||
    endsAt - startedAt > MAX_INTERVAL || endsAt <= startedAt || now < startedAt || now >= endsAt ||
    sentAt < startedAt || sentAt > now || !WAMID.test(msg.messageId)) return;
  return { recipient, sender, startedAt, endsAt };
}

/** Owner-only quarantine for money/document variants this preview cannot
 * vouch for. It is not a classifier for production customers. */
export function ownerFinancePilotTraffic(env: Env, message: PilotMessage, now = Date.now()) {
  if (env.FEATURE_META_OWNER_FINANCE_PILOT !== "true" || message.kind !== "text" ||
      !env.META_OWNER_FINANCE_PILOT_SENDER || message.phone !== env.META_OWNER_FINANCE_PILOT_SENDER || !message.text) return false;
  const ended = Date.parse(env.META_OWNER_FINANCE_PILOT_ENDS_AT ?? "");
  const sent = Date.parse(message.sentAt ?? "");
  const recipient = env.META_PHONE_NUMBER_ID?.trim();
  // An old in-window retry still belongs to this lane (and fails the send
  // cutoff). A new signed event after the cutoff belongs to existing routing.
  if (message.canonicalSender === true && WAMID.test(message.messageId) && recipient && official.test(recipient) &&
      message.phoneNumberId === recipient && Number.isSafeInteger(now) && Number.isSafeInteger(ended) && Number.isSafeInteger(sent) &&
      sent >= ended && sent <= now) return false;
  const folded = message.text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return /\b(?:pix|boleto|cpf|cnpj|faturas?|pagamento|pagar|paguei|paga|cobranca|comprovante)\b/.test(folded) ||
    /(?<!\d)(?:\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}|\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})(?!\d)/.test(folded);
}

export function planOwnerFinancePilot(text: string): { turn: PilotTurn; requiresAnchor: boolean } | undefined {
  if (!text || text.length > 105 || !/^[\p{L}\p{M} .!?,-]+$/u.test(text)) return;
  const value = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/ +/g, " ").trim()
    .replace(/^(?:oi|ola|bom dia|boa tarde|boa noite) /, "").replace(/ por favor$/, "");
  if (/^(?:(?:quero|preciso|gostaria de) pagar|(?:como|onde) (?:eu )?(?:faco para |posso |consigo )?pagar|posso pagar)(?: (?:a |o |minha |meu )?(?:conta|fatura|boleto|mensalidade|internet))?$/.test(value))
    return { turn: "choice", requiresAnchor: false };
  if (/^(?:(?:por|via|pelo) )?(?:pix|boleto)$/.test(value))
    return { turn: value.endsWith("pix") ? "pix" : "boleto", requiresAnchor: true };
  if (/^(?:quero (?:o )?|prefiro (?:o )?|(?:me )?(?:manda|mande|envia|envie) (?:o )?|quero pagar (?:pelo|por|via) )(?:pix|boleto)(?: da fatura)?$/.test(value) ||
    /^(?:quero |preciso d[eo] )?(?:a )?segunda via do boleto$/.test(value))
    return { turn: value.includes("pix") ? "pix" : "boleto", requiresAnchor: false };
  if (/^(?:(?:eu )?ja paguei|paguei (?:hoje|ontem)|(?:a )?fatura ja (?:foi paga|esta paga))$/.test(value))
    return { turn: "paid", requiresAnchor: false };
}

/** The preview never displaces an incumbent human or sensitive flow. */
export function ownerFinanceScopeMaySpeak(ticket: { stage: string | null; selfService: { step: string } | null } | undefined) {
  return !ticket || (ticket.stage !== "handoff" &&
    (!ticket.selfService || ["verified", "mismatch", "unavailable"].includes(ticket.selfService.step)));
}

export function ownerFinanceAnchor(rows: ChannelMessageRow[], message: PilotMessage, config: PilotConfig): string | undefined {
  const prior = rows.at(-1);
  const request = rows.at(-2);
  const providerAt = Date.parse(message.sentAt ?? "");
  const rowAt = Date.parse(prior?.createdAt ?? "");
  if (!request || request.role !== "customer" || request.content !== CURRENT.choice || !request.correlationId ||
    !request.externalMessageId || !WAMID.test(request.externalMessageId) || request.correlationId !== prior?.correlationId ||
    !prior || prior.role !== "agent" || prior.sentBy !== "ia" || prior.content !== OWNER_FINANCE_REPLY.choice ||
    !prior.externalMessageId || !WAMID.test(prior.externalMessageId) || rowAt < config.startedAt || Math.floor(rowAt / 1000) > Math.floor(providerAt / 1000) ||
    !Number.isFinite(rowAt) || !Number.isFinite(providerAt) || (message.replyToMessageId != null && message.replyToMessageId !== prior.externalMessageId) ||
    (message.replyToMessageId !== prior.externalMessageId && prior.deliveryStatus !== "delivered" && prior.deliveryStatus !== "read")) return;
  return prior.externalMessageId;
}

/** Only minimal normalized turns enter the canonical transcript. */
export const ownerFinanceInbound = (msg: PilotMessage, turn: PilotTurn, correlationId: string): ChannelMessageInput =>
  ({ externalConversationId: msg.phone, idempotencyKey: msg.messageId, text: CURRENT[turn], correlationId });

type Db = Awaited<ReturnType<typeof getDb>>;
const key = (domain: string, value: string) => "owner-finance-" + domain + ":" + createHash("sha256").update(value).digest("hex");
/** Both a given WAMID and a single menu answer are held in the same transaction. */
export async function reserveOwnerFinanceInbound(db: Db, channel: string, input: ChannelMessageInput, anchor?: string) {
  const conflict = Symbol("owner finance reservation conflict");
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL synchronous_commit = on`);
      const claim = new DbReplyRepository(tx);
      if (!await claim.claim(key("input", input.idempotencyKey), channel, input.externalConversationId)) return false;
      const [prior] = await tx.select({ id: channelMessages.id }).from(channelMessages)
        .where(and(eq(channelMessages.channel, channel), eq(channelMessages.role, "customer"),
          eq(channelMessages.externalConversationId, input.externalConversationId),
          eq(channelMessages.externalMessageId, input.idempotencyKey))).limit(1);
      if (prior) throw conflict;
      if (anchor && !await claim.claim(key("anchor", anchor), channel, input.externalConversationId)) throw conflict;
      const id = randomUUID();
      const [saved] = await tx.insert(channelMessages).values({
        id, channel, externalConversationId: input.externalConversationId, role: "customer", content: input.text,
        correlationId: input.correlationId, externalMessageId: input.idempotencyKey, createdAt: new Date().toISOString(),
      }).returning({ id: channelMessages.id });
      if (saved?.id !== id) throw Error("OWNER_FINANCE_INBOUND_UNCONFIRMED");
      return true;
    });
  } catch (error) {
    if (error === conflict) return false;
    throw error;
  }
}
