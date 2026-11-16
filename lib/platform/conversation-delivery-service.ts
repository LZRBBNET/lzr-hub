import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { channelIdempotencyKeys } from "../../db/schema.ts";
import { DbConversationStateRepository, changeConversationState, type StateActor } from "./conversation-state-service.ts";
import { botMayReply } from "./conversation-state-shared.ts";
import { deliveryKey, hasDelivery, lockDelivery } from "./conversation-delivery-lock.ts";

export interface ConversationDelivery {
  begin(channel: string, conversationId: string, actor?: StateActor, operationKey?: string): Promise<string>;
  settleUncertain(channel: string, conversationId: string, token: string, acceptedMessageId?: string): Promise<void>;
  finish(channel: string, conversationId: string, token: string): Promise<void>;
}

/** No expiry: an interrupted or uncertain external send needs reconciliation, not automatic retry. */
export class DbConversationDelivery implements ConversationDelivery {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async begin(channel: string, conversationId: string, actor?: StateActor, operationKey?: string): Promise<string> {
    const token = randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.db.transaction(async (tx: any) => {
      await lockDelivery(tx, channel, conversationId);
      if (await hasDelivery(tx, channel, conversationId)) throw Error("DELIVERY_PENDING");
      const states = new DbConversationStateRepository(tx);
      if (actor) {
        const claim = await changeConversationState(states, { channel, conversationId, actor, action: "claim" });
        if (!claim.ok) throw Error("DELIVERY_OWNER_CONFLICT");
      } else if (!botMayReply(await states.get(channel, conversationId))) {
        throw Error("DELIVERY_HUMAN_ASSIGNED");
      }
      const inserted = await tx.insert(channelIdempotencyKeys).values({
        idempotencyKey: deliveryKey(channel, conversationId), channel, externalConversationId: conversationId,
        responseJson: { status: "pending", token, operationKey, kind: actor ? "human" : "bot" }, createdAt: new Date().toISOString(),
      }).returning({ key: channelIdempotencyKeys.idempotencyKey });
      if (inserted.length !== 1) throw Error("DELIVERY_UNCONFIRMED");
    });
    return token;
  }
  async settleUncertain(channel: string, conversationId: string, token: string, acceptedMessageId?: string): Promise<void> {
    // Written only after the one transport attempt has returned. No later send is scheduled.
    const updated = await this.db.update(channelIdempotencyKeys).set({ responseJson: sql`${channelIdempotencyKeys.responseJson} || ${JSON.stringify({ status: "uncertain", workerSettled: true, acceptedMessageId: acceptedMessageId ?? null })}::jsonb` })
      .where(and(eq(channelIdempotencyKeys.idempotencyKey, deliveryKey(channel, conversationId)), sql`${channelIdempotencyKeys.responseJson}->>'token' = ${token}`, sql`${channelIdempotencyKeys.responseJson}->>'status' = 'pending'`))
      .returning({ key: channelIdempotencyKeys.idempotencyKey });
    if (updated.length !== 1) throw Error("DELIVERY_SETTLEMENT_UNCONFIRMED");
  }
  async finish(channel: string, conversationId: string, token: string): Promise<void> {
    // A late completion cannot clear a newer operation's reservation.
    await this.db.delete(channelIdempotencyKeys).where(and(
      eq(channelIdempotencyKeys.idempotencyKey, deliveryKey(channel, conversationId)),
      sql`${channelIdempotencyKeys.responseJson}->>'token' = ${token}`,
      sql`${channelIdempotencyKeys.responseJson}->>'status' = 'pending'`,
    ));
  }
}
