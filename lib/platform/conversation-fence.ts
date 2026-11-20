import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditEvents, channelIdempotencyKeys, conversationStates, supportTickets } from "../../db/schema.ts";
import { deliveryKey, lockDelivery } from "./conversation-delivery-lock.ts";

export type TurnFence = { channel: string; conversationId: string; operation: string; sendKey: string; generation: string; kind: "reply" | "confirmation" };
type FenceState = { generation: string; mode: "ai" | "human" | "resolved"; confirmation?: string };
const key = (prefix: string, parts: string[]) => `${prefix}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
export const fenceKey = (channel: string, id: string) => key("conversation-fence", [channel, id]);
export const turnKey = (channel: string, id: string, inbound: string) => key("conversation-turn", [channel, id, inbound]);
// All helpers below require the caller's lockDelivery transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readLedger(db: any, id: string) {
  const rows = await db.select({ value: channelIdempotencyKeys.responseJson }).from(channelIdempotencyKeys).where(eq(channelIdempotencyKeys.idempotencyKey, id)).limit(1);
  return rows[0]?.value;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function putLedger(db: any, id: string, channel: string, conversationId: string, value: unknown) {
  await db.insert(channelIdempotencyKeys).values({ idempotencyKey:id, channel, externalConversationId:conversationId, responseJson:value, createdAt:new Date().toISOString() })
    .onConflictDoUpdate({target:channelIdempotencyKeys.idempotencyKey,set:{responseJson:value}});
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function auditFence(db: any, channel: string, id: string, action: string, result: string) {
  await db.insert(auditEvents).values({id:randomUUID(),actorId:"conversation-fence",role:"system",action:`whatsapp.fence.${action}`,
    entity:fenceKey(channel,id),correlationId:randomUUID(),result,origin:"ia",reason:`Dispatch fence: ${action}; ${result}. Reservation is not proof of provider delivery.`,createdAt:new Date().toISOString()});
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function allowTransition(db: any, channel: string, id: string): Promise<boolean> {
  const delivery = await readLedger(db, deliveryKey(channel,id));
  if (!delivery) return true;
  if (delivery.kind === "bot" && delivery.status === "pending" && delivery.phase === "prepared") {
    await db.delete(channelIdempotencyKeys).where(eq(channelIdempotencyKeys.idempotencyKey,deliveryKey(channel,id)));
    await auditFence(db,channel,id,"prepared_revoked","obsolete");
    return true;
  }
  // Authorized/uncertain/legacy sends must settle before ownership can change.
  await auditFence(db,channel,id,"transition_blocked","dispatch_outstanding");
  return false;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rotateFence(db: any, channel: string, id: string, mode: FenceState["mode"], confirmation?: string): Promise<FenceState> {
  const state: FenceState = {generation:randomUUID(),mode,...(confirmation ? {confirmation} : {})};
  await putLedger(db,fenceKey(channel,id),channel,id,state);
  await auditFence(db,channel,id,"generation_rotated",mode);
  return state;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function validTurn(db: any, channel: string, id: string, turn?: TurnFence, allowConsumed = false): Promise<boolean> {
  if (!turn || turn.channel!==channel || turn.conversationId!==id) return false;
  const state = await readLedger(db,fenceKey(channel,id)) as FenceState | undefined;
  const saved = await readLedger(db,turn.operation) as TurnFence | undefined;
  return !!state && !!saved && (allowConsumed || !(saved as TurnFence & {dispatchToken?: string}).dispatchToken) && saved.generation===turn.generation && saved.kind===turn.kind && state.generation===turn.generation
    && (turn.kind==="reply" ? state.mode==="ai" : state.mode==="human" && state.confirmation===turn.operation);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function consumeTurn(db: any, turn: TurnFence, token: string) {
  await putLedger(db,turn.operation,turn.channel,turn.conversationId,{...turn,dispatchToken:token});
}

export class DbConversationFence {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db=db; }
  async capture(channel: string, conversationId: string, inbound: string, sentAt?: string): Promise<TurnFence> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.db.transaction(async (tx: any) => {
      await lockDelivery(tx,channel,conversationId);
      const operation=turnKey(channel,conversationId,inbound);
      const previous=await readLedger(tx,operation);
      if (previous) return previous; // Retry never acquires a newer generation.
      let state=await readLedger(tx,fenceKey(channel,conversationId)) as FenceState | undefined;
      const rows=await tx.select().from(conversationStates).where(and(eq(conversationStates.channel,channel),eq(conversationStates.externalConversationId,conversationId))).limit(1);
      const owner=rows[0];
      const newInbound=owner?.status==="resolved" && !!sentAt && Number.isFinite(Date.parse(sentAt)) && Date.parse(sentAt)>Date.parse(owner.resolvedAt ?? "");
      if (!state || (state.mode==="resolved" && newInbound)) {
        const tickets=await tx.select({stage:supportTickets.stage}).from(supportTickets).where(and(eq(supportTickets.channel,channel),eq(supportTickets.externalConversationId,conversationId),eq(supportTickets.status,"open"))).limit(1);
        const mode=owner?.status==="resolved" && !newInbound ? "resolved" : owner?.status==="open" && owner.assigneeId || tickets[0]?.stage==="handoff" ? "human" : "ai";
        state=await rotateFence(tx,channel,conversationId,mode);
      }
      const turn:TurnFence={channel,conversationId,operation,sendKey:`autoreply:${inbound}`,generation:state.generation,kind:"reply"};
      await putLedger(tx,operation,channel,conversationId,turn);
      return turn;
    });
  }
  // Atomic ticket transition + generation change + confirmation permission.
  async handoff(turn: TurnFence, apply: (tx: unknown) => Promise<boolean>): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result=await this.db.transaction(async(tx:any)=>{
      await lockDelivery(tx,turn.channel,turn.conversationId);
      if (!await validTurn(tx,turn.channel,turn.conversationId,turn) || turn.kind!=="reply") {
        await auditFence(tx,turn.channel,turn.conversationId,"handoff_rejected","obsolete");return undefined;
      }
      if (!await allowTransition(tx,turn.channel,turn.conversationId)) return undefined;
      if (!await apply(tx)) return undefined;
      const state=await rotateFence(tx,turn.channel,turn.conversationId,"human",turn.operation);
      const confirmed:TurnFence={...turn,generation:state.generation,kind:"confirmation"};
      await putLedger(tx,turn.operation,turn.channel,turn.conversationId,confirmed);
      return confirmed;
    });
    if (!result) return false;
    Object.assign(turn,result); // Only after confirmed COMMIT.
    return true;
  }
}
