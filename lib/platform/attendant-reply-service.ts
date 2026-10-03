import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { auditEvents, channelIdempotencyKeys, channelMessages } from "../../db/schema.ts";
import { sanitizeHandoffText } from "../agent/handoff.ts";
import { MAX_TEXT_LENGTH, markAsRead, sendTextMessage, type MetaSendConfig } from "../integrations/meta/cloud-client.ts";
import { isNonCustomerConversation } from "./conversation-scope.ts";
import { containsHomologationText } from "./reply-templates-shared.ts";

/**
 * O atendente responde ao cliente pelo WhatsApp, pela tela de Atendimentos.
 *
 * É a primeira ação do projeto que **escreve a um cliente real**, então segue a
 * mesma régua da escrita no ERP — idempotência, política, flag, chamada — e deixa
 * rastro mesmo quando recusa: auditoria existe para provar decisão, não só sucesso.
 *
 * Só texto livre, e só dentro da janela de 24 horas da última mensagem do
 * cliente: fora dela a Meta exige modelo aprovado, que ainda não existe aqui.
 */

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[\w-]{8,100}$/;
const CLAIM_PREFIX = "reply:";

export interface ReplyActor { email: string; role: string }

export interface ReplyInput {
  channel: string;
  conversationId: string;
  text: string;
  /** Uma por clique: é o que impede o duplo clique de virar duas mensagens. */
  idempotencyKey: string;
  actor?: ReplyActor;
}

export type ReplyResult =
  | { ok: true; messageId: string; duplicate: boolean; recorded: boolean }
  | { ok: false; status: 400 | 403 | 409 | 422 | 429 | 502 | 503; reason: string };

export type ClaimState = { status: "pending" } | { status: "sent"; messageId: string } | { status: "unknown" };

export interface ReplyRepository {
  lastCustomerMessage(channel: string, conversationId: string): Promise<{ createdAt: string; externalMessageId?: string } | undefined>;
  /** Reserva a chave antes de enviar. `false` = já existe (outro clique, ou reenvio). */
  claim(key: string, channel: string, conversationId: string): Promise<boolean>;
  claimState(key: string): Promise<ClaimState | undefined>;
  setClaimState(key: string, state: ClaimState): Promise<void>;
  release(key: string): Promise<void>;
  saveSent(entry: { channel: string; conversationId: string; content: string; sentBy: string; correlationId: string; externalMessageId: string }): Promise<void>;
  audit(entry: { correlationId: string; entity: string; action: string; result: string; reason: string; actor?: ReplyActor }): Promise<void>;
}

export interface ReplyDeps {
  repository: ReplyRepository;
  /** `undefined` quando falta token ou id do número. */
  config: MetaSendConfig | undefined;
  /** `FEATURE_ATTENDANT_REPLY`. */
  enabled: boolean;
  now?: () => number;
}

export function attendantReplyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FEATURE_ATTENDANT_REPLY === "true";
}

const refusal = (status: Extract<ReplyResult, { ok: false }>["status"], reason: string): ReplyResult => ({ ok: false, status, reason });

export async function sendAttendantReply(deps: ReplyDeps, input: ReplyInput): Promise<ReplyResult> {
  const { repository } = deps;
  const now = deps.now ?? Date.now;
  const text = input.text.trim();
  const correlationId = randomUUID();
  const entity = `conversation:${input.conversationId}`;
  const claimKey = `${CLAIM_PREFIX}${input.idempotencyKey}`;
  const preview = `"${sanitizeHandoffText(text).slice(0, 180)}"`;
  const blocked = async (status: Extract<ReplyResult, { ok: false }>["status"], reason: string, result = "blocked"): Promise<ReplyResult> => {
    await repository.audit({ correlationId, entity, action: "whatsapp.reply.blocked", result, reason: `Envio recusado: ${reason} ${preview}`, actor: input.actor }).catch(() => undefined);
    return refusal(status, reason);
  };

  // 1. Entrada. Nada daqui chega ao banco ou à Meta.
  if (!KEY_PATTERN.test(input.idempotencyKey)) return refusal(400, "Identificador de envio inválido.");
  if (!text) return refusal(400, "Escreva a mensagem.");
  if (text.length > MAX_TEXT_LENGTH) return refusal(400, `A mensagem passa de ${MAX_TEXT_LENGTH} caracteres, o limite do WhatsApp.`);
  const phone = input.conversationId.trim();
  // Grupo e qualquer id que não seja telefone não são cliente: não há a quem responder.
  if (isNonCustomerConversation(phone) || !/^\d{10,15}$/.test(phone)) return refusal(400, "Esta conversa não é de um número de cliente.");

  // 2. Idempotência: o mesmo clique repetido devolve o resultado, não reenvia.
  const previous = await repository.claimState(claimKey);
  if (previous?.status === "sent") return { ok: true, messageId: previous.messageId, duplicate: true, recorded: true };
  if (previous) return refusal(409, previous.status === "pending" ? "Esse envio já está em andamento." : "Esse envio ficou sem confirmação da Meta. Confira a conversa antes de reenviar.");

  // 3. Política. Sem login não há autor, e mensagem a cliente sem autor não sai.
  if (!input.actor) return blocked(403, "O envio exige login.");
  if (!deps.enabled) return blocked(503, "O envio pela tela está desligado.");
  if (!deps.config) return blocked(503, "O envio pela Meta não está configurado.");
  // O texto de homologação do pipeline ("fictícia") nunca vai a cliente real,
  // venha de rascunho, de cópia ou de digitação.
  if (containsHomologationText(text)) return blocked(422, "O texto menciona homologação, simulação ou dado fictício — não pode ser enviado a um cliente.");

  const lastCustomer = await repository.lastCustomerMessage(input.channel, phone);
  if (!lastCustomer) return blocked(422, "Não há mensagem deste cliente nesta conversa para responder.");
  if (now() - Date.parse(lastCustomer.createdAt) > REPLY_WINDOW_MS) {
    return blocked(422, "Passaram mais de 24 horas desde a última mensagem do cliente. A Meta só aceita texto livre dentro dessa janela; fora dela é preciso um modelo aprovado.");
  }

  // 4. Reserva. É o que a restrição única do banco garante: dois cliques
  // simultâneos não passam os dois daqui.
  if (!(await repository.claim(claimKey, input.channel, phone))) return refusal(409, "Esse envio já está em andamento.");

  // Visualizar a mensagem antes de responder, como o atendente faria. Melhor
  // esforço: não marcar como lida não impede a resposta.
  const inboundId = lastCustomer.externalMessageId;
  if (inboundId?.startsWith("wamid.")) await markAsRead(deps.config, inboundId).catch(() => false);

  // 5. Chamada.
  const sent = await sendTextMessage(deps.config, { to: phone, text });
  if (!sent.ok) {
    // Em timeout a mensagem pode ter saído: soltar a reserva convidaria um
    // reenvio em dobro. Nos demais casos a Meta recusou, e liberar é seguro.
    if (sent.kind === "timeout") await repository.setClaimState(claimKey, { status: "unknown" }).catch(() => undefined);
    else await repository.release(claimKey).catch(() => undefined);
    await repository.audit({ correlationId, entity, action: "whatsapp.reply.failed", result: sent.kind === "timeout" ? "unknown" : "failed", reason: `Envio ao cliente falhou (${sent.kind}${sent.metaCode ? ` ${sent.metaCode}` : ""}): ${sanitizeHandoffText(sent.reason)} ${preview}`, actor: input.actor }).catch(() => undefined);
    const status = sent.kind === "window_closed" || sent.kind === "not_allowed" || sent.kind === "invalid_recipient" ? 422
      : sent.kind === "invalid_token" ? 503
      : sent.kind === "rate_limited" ? 429
      : 502;
    return refusal(status, sent.reason);
  }

  await repository.setClaimState(claimKey, { status: "sent", messageId: sent.messageId }).catch(() => undefined);

  // 6. Rastro. A Meta já aceitou: falha daqui em diante não desfaz o envio, então
  // é dita — "enviada, mas não gravada" — em vez de fingir que nada aconteceu.
  let recorded = true;
  try {
    await repository.saveSent({ channel: input.channel, conversationId: phone, content: text, sentBy: input.actor.email, correlationId, externalMessageId: sent.messageId });
    await repository.audit({ correlationId, entity, action: "whatsapp.reply.sent", result: "success", reason: `Resposta ENVIADA ao cliente pelo atendente: ${preview}`, actor: input.actor });
  } catch {
    recorded = false;
  }
  return { ok: true, messageId: sent.messageId, duplicate: false, recorded };
}

export class DbReplyRepository implements ReplyRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async lastCustomerMessage(channel: string, conversationId: string) {
    const rows = await this.db.select({ createdAt: channelMessages.createdAt, externalMessageId: channelMessages.externalMessageId })
      .from(channelMessages)
      .where(and(eq(channelMessages.channel, channel), eq(channelMessages.externalConversationId, conversationId), eq(channelMessages.role, "customer")))
      .orderBy(desc(channelMessages.createdAt))
      .limit(1);
    const row = rows[0] as { createdAt: string; externalMessageId: string | null } | undefined;
    return row ? { createdAt: row.createdAt, externalMessageId: row.externalMessageId ?? undefined } : undefined;
  }

  async claim(key: string, channel: string, conversationId: string): Promise<boolean> {
    const rows = await this.db.insert(channelIdempotencyKeys)
      .values({ idempotencyKey: key, channel, externalConversationId: conversationId, responseJson: { status: "pending" }, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .returning({ key: channelIdempotencyKeys.idempotencyKey });
    return rows.length > 0;
  }

  async claimState(key: string): Promise<ClaimState | undefined> {
    const rows = await this.db.select({ state: channelIdempotencyKeys.responseJson }).from(channelIdempotencyKeys).where(eq(channelIdempotencyKeys.idempotencyKey, key)).limit(1);
    return rows[0]?.state as ClaimState | undefined;
  }

  async setClaimState(key: string, state: ClaimState): Promise<void> {
    await this.db.update(channelIdempotencyKeys).set({ responseJson: state }).where(eq(channelIdempotencyKeys.idempotencyKey, key));
  }

  async release(key: string): Promise<void> {
    await this.db.delete(channelIdempotencyKeys).where(eq(channelIdempotencyKeys.idempotencyKey, key));
  }

  async saveSent(entry: { channel: string; conversationId: string; content: string; sentBy: string; correlationId: string; externalMessageId: string }): Promise<void> {
    await this.db.insert(channelMessages).values({
      id: randomUUID(), channel: entry.channel, externalConversationId: entry.conversationId, role: "agent", content: entry.content,
      correlationId: entry.correlationId, sentBy: entry.sentBy, externalMessageId: entry.externalMessageId, createdAt: new Date().toISOString(),
    });
  }

  async audit(entry: { correlationId: string; entity: string; action: string; result: string; reason: string; actor?: ReplyActor }): Promise<void> {
    await this.db.insert(auditEvents).values({
      id: randomUUID(), actorId: entry.actor?.email ?? "anônimo", role: entry.actor?.role ?? "não identificado", action: entry.action,
      entity: entry.entity, beforeMasked: null, afterMasked: null, reason: entry.reason,
      correlationId: entry.correlationId, result: entry.result, origin: entry.actor ? "humano" : "não verificado", createdAt: new Date().toISOString(),
    });
  }
}

export class MemoryReplyRepository implements ReplyRepository {
  readonly customerMessages: Array<{ channel: string; conversationId: string; createdAt: string; externalMessageId?: string }> = [];
  readonly sent: Array<{ channel: string; conversationId: string; content: string; sentBy: string; correlationId: string; externalMessageId: string }> = [];
  readonly audits: Array<{ correlationId: string; entity: string; action: string; result: string; reason: string; actor?: ReplyActor }> = [];
  private readonly claims = new Map<string, ClaimState>();
  async lastCustomerMessage(channel: string, conversationId: string) {
    return this.customerMessages.filter((m) => m.channel === channel && m.conversationId === conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  async claim(key: string) {
    if (this.claims.has(key)) return false;
    this.claims.set(key, { status: "pending" });
    return true;
  }
  async claimState(key: string) { return this.claims.get(key); }
  async setClaimState(key: string, state: ClaimState) { this.claims.set(key, state); }
  async release(key: string) { this.claims.delete(key); }
  async saveSent(entry: { channel: string; conversationId: string; content: string; sentBy: string; correlationId: string; externalMessageId: string }) { this.sent.push(entry); }
  async audit(entry: { correlationId: string; entity: string; action: string; result: string; reason: string; actor?: ReplyActor }) { this.audits.push(entry); }
}
