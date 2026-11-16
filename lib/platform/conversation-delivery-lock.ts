import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { channelIdempotencyKeys } from "../../db/schema.ts";

export const deliveryKey = (channel: string, conversationId: string) =>
  `delivery:${createHash("sha256").update(JSON.stringify([channel, conversationId])).digest("hex")}`;

// Transaction-scoped lock serializes reservations and state mutations across replicas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lockDelivery(db: any, channel: string, conversationId: string) {
  await db.execute(sql`SET LOCAL synchronous_commit = on`);
  await db.execute(sql`SET LOCAL lock_timeout = '2s'`);
  await db.execute(sql`SET LOCAL statement_timeout = '5s'`);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${deliveryKey(channel, conversationId)}, 0))`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function hasDelivery(db: any, channel: string, conversationId: string): Promise<boolean> {
  const rows = await db.select({ key: channelIdempotencyKeys.idempotencyKey }).from(channelIdempotencyKeys)
    .where(eq(channelIdempotencyKeys.idempotencyKey, deliveryKey(channel, conversationId))).limit(1);
  return rows.length > 0;
}
