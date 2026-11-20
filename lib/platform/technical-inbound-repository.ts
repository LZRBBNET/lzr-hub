import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../../db/index.ts";
import { channelMessages } from "../../db/schema.ts";
import { DbReplyRepository } from "./attendant-reply-service.ts";
import type { ChannelMessageInput } from "./n8n-channel-service.ts";

type TechnicalInboundDb = Pick<Awaited<ReturnType<typeof getDb>>, "transaction">;

export function technicalInboundKey(wamid: string): string {
  return `technical-model:${createHash("sha256").update(wamid).digest("hex")}`;
}

export function reserveTechnicalInbound(db: TechnicalInboundDb, channel: string, input: ChannelMessageInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const conversationId = input.externalConversationId;
    const reserved = await new DbReplyRepository(tx).claim(technicalInboundKey(input.idempotencyKey), channel, conversationId);
    if (!reserved) return false;
    // A legacy process may have recorded the inbound without completing the response ledger.
    const prior = await tx.select({ id: channelMessages.id }).from(channelMessages).where(and(
      eq(channelMessages.channel, channel), eq(channelMessages.externalConversationId, conversationId),
      eq(channelMessages.role, "customer"), eq(channelMessages.externalMessageId, input.idempotencyKey),
    )).limit(1);
    if (prior.length) return false;
    const id = randomUUID();
    const rows = await tx.insert(channelMessages).values({
      id, channel, externalConversationId: conversationId, role: "customer", content: input.text,
      correlationId: input.correlationId, externalMessageId: input.idempotencyKey, createdAt: new Date().toISOString(),
    }).returning({ id: channelMessages.id });
    if (rows.length !== 1 || rows[0].id !== id) throw Error("TECHNICAL_INBOUND_UNCONFIRMED");
    return true;
  });
}

// The previous outbound can enable one AI follow-up even if the customer
// submits two different inbound messages simultaneously. No reopen on timeout.
export function claimTechnicalFollowup(
  db: unknown, channel: string, conversationId: string, anchorMessageId: string,
): Promise<boolean> {
  const key = createHash("sha256").update(JSON.stringify([channel, conversationId, anchorMessageId])).digest("hex");
  return new DbReplyRepository(db).claim(`technical-followup:${key}`, channel, conversationId);
}
