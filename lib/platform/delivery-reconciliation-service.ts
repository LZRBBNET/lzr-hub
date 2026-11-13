import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditEvents, channelIdempotencyKeys, sessions, users } from "../../db/schema.ts";
import { deliveryKey, lockDelivery } from "./conversation-delivery-lock.ts";
import { hashToken } from "./auth.ts";
import { can, roles, type Role } from "./rbac.ts";
import type { StateActor } from "./conversation-state-service.ts";

export class ReconciliationError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type DeliveryStatus = { reservationId: string; status: "pending" | "uncertain"; kind: string; createdAt: string; acceptedMessageId: string | null; eligible: boolean };
export class DbDeliveryReconciliation {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  private async row(key: string) {
    const rows = await this.db.select().from(channelIdempotencyKeys).where(eq(channelIdempotencyKeys.idempotencyKey, key)).limit(1);
    return rows[0];
  }
  async status(channel: string, conversationId: string): Promise<DeliveryStatus | null> {
    const row = await this.row(deliveryKey(channel, conversationId));
    if (!row) return null;
    const value = row.responseJson;
    return { reservationId: value.token, status: value.status === "uncertain" ? "uncertain" : "pending", kind: value.kind, createdAt: row.createdAt,
      acceptedMessageId: value.acceptedMessageId ?? null, eligible: value.status === "uncertain" && value.workerSettled === true && typeof value.operationKey === "string" };
  }
  async reconcile(input: { channel: string; conversationId: string; reservationId: string; outcome: string; evidence: string; messageId?: string; sessionToken: string; actor: StateActor }) {
    const { channel, conversationId, reservationId, actor: admittedActor, outcome } = input;
    let actor = admittedActor;
    if (!actor?.id || !roles.includes(actor.role as Role) || !can(actor.role as Role, "support.reconcile")) throw new ReconciliationError(403, "Seu perfil não permite reconciliar envios.");
    const evidence = input.evidence.trim(), messageId = input.messageId?.trim() || null;
    if (!/^[a-f0-9-]{36}$/i.test(reservationId) || !["accepted", "not_sent"].includes(outcome) || evidence.length < 20 || evidence.length > 500 || /[\r\n\x00-\x1f]/.test(evidence) || (outcome === "accepted" && (!messageId || !/^[\w.:-]{1,200}$/.test(messageId))) || (outcome === "not_sent" && messageId)) {
      throw new ReconciliationError(400, "Informe uma conclusão, a referência da evidência (20–500 caracteres) e o ID da mensagem quando aceita.");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([channel, conversationId, reservationId, outcome, evidence, messageId, actor.id])).digest("hex");
    const resolutionKey = `delivery-resolution:${reservationId}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.db.transaction(async (tx: any) => {
      await lockDelivery(tx, channel, conversationId);
      // Serialize this decision with logout, account disable and role changes.
      // Never trust the actor captured before body parsing / pool / lock waits.
      if (!input.sessionToken) throw new ReconciliationError(401, "Sessão inválida ou expirada");
      const identities = await tx.select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active, expiresAt: sessions.expiresAt })
        .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, hashToken(input.sessionToken))).for("share");
      const identity = identities[0];
      if (!identity || identity.id !== admittedActor.id || !identity.active || !Number.isFinite(Date.parse(identity.expiresAt)) || Date.parse(identity.expiresAt) <= Date.now()) throw new ReconciliationError(401, "Sessão inválida ou expirada");
      if (!roles.includes(identity.role as Role) || !can(identity.role as Role, "support.reconcile")) throw new ReconciliationError(403, "Seu perfil não permite reconciliar envios.");
      actor = { id: identity.id, email: identity.email, name: identity.name, role: identity.role };

      const repository = new DbDeliveryReconciliation(tx), prior = await repository.row(resolutionKey);
      if (prior) {
        if (prior.responseJson.fingerprint !== fingerprint) throw new ReconciliationError(409, "A reserva já foi reconciliada por outra decisão. Atualize a conversa.");
        return { auditId: prior.responseJson.auditId as string, duplicate: true };
      }
      const key = deliveryKey(channel, conversationId), row = await repository.row(key), value = row?.responseJson;
      if (!row || value.token !== reservationId) throw new ReconciliationError(409, "A reserva mudou. Atualize a conversa.");
      if (value.status !== "uncertain" || value.workerSettled !== true || typeof value.operationKey !== "string") throw new ReconciliationError(409, "Encerramento da tentativa não comprovado. Mantenha o bloqueio; não reenvie.");
      if (value.acceptedMessageId && (outcome !== "accepted" || messageId !== value.acceptedMessageId)) throw new ReconciliationError(409, "A aceitação registrada pelo servidor não corresponde à decisão.");
      const operation = await repository.row(value.operationKey);
      if (!operation || operation.channel !== channel || operation.externalConversationId !== conversationId || !/^(reply:|autoreply:)/.test(value.operationKey)) throw new ReconciliationError(409, "Vínculo da operação indisponível. Mantenha o bloqueio.");
      const auditId = randomUUID(), at = new Date().toISOString();
      const inserted = await tx.insert(auditEvents).values({ id: auditId, actorId: actor.email, role: actor.role, action: "conversation.delivery.reconciled",
        entity: `conversation:${encodeURIComponent(channel)}:${encodeURIComponent(conversationId)}`, beforeMasked: "blocked", afterMasked: outcome,
        reason: `Conferência manual: ${evidence}. Conclusão: ${outcome}. ID de aceitação: ${messageId ?? "não aplicável"}. Nenhum reenvio.`, correlationId: reservationId, result: "success", origin: "humano", createdAt: at }).returning({ id: auditEvents.id });
      if (inserted.length !== 1 || inserted[0].id !== auditId) throw Error("RECONCILIATION_AUDIT_UNCONFIRMED");
      const closed = await tx.update(channelIdempotencyKeys).set({ responseJson: { ...operation.responseJson, status: "reconciled", resolution: outcome, auditId } })
        .where(eq(channelIdempotencyKeys.idempotencyKey, value.operationKey)).returning({ key: channelIdempotencyKeys.idempotencyKey });
      if (closed.length !== 1) throw Error("RECONCILIATION_OPERATION_UNCONFIRMED");
      const ledger = await tx.insert(channelIdempotencyKeys).values({ idempotencyKey: resolutionKey, channel, externalConversationId: conversationId,
        responseJson: { status: "reconciled", fingerprint, auditId }, createdAt: at }).returning({ key: channelIdempotencyKeys.idempotencyKey });
      if (ledger.length !== 1) throw Error("RECONCILIATION_RESULT_UNCONFIRMED");
      const removed = await tx.delete(channelIdempotencyKeys).where(and(eq(channelIdempotencyKeys.idempotencyKey, key),eq(channelIdempotencyKeys.channel, channel))).returning({ key: channelIdempotencyKeys.idempotencyKey });
      if (removed.length !== 1) throw Error("RECONCILIATION_RELEASE_UNCONFIRMED");
      return { auditId, duplicate: false };
    });
  }
}
