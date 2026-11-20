import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/pg-proxy";
import { DbTicketRepository, MemoryTicketRepository, openOrContinueTicket, recordTriage, resumeTicketForAi } from "../lib/platform/triage-service.ts";
import { MemoryConversationStateRepository, changeConversationStateWithTicket, stateKey } from "../lib/platform/conversation-state-service.ts";
import { CHANNEL_NAME, MemoryChannelRepository, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";

// Only in-memory repositories/SQL compilation. No connected database, sender, n8n or IXC.
const conversationId = "isolated-handoff-case";
const entry = { intent: "no_connection", source: "menu", confidence: 1, clarifying: false, delivered: false, protocolIncluded: false };
const input = { externalConversationId: conversationId, text: "Solicitação local", idempotencyKey: "isolated-event", correlationId: "isolated-correlation" };
async function fixture() {
  const tickets = new MemoryTicketRepository();
  const { ticket } = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId });
  return { tickets, ticket: structuredClone(ticket) };
}

test("stale routed and clarifying writes cannot overwrite a durable handoff or queue", async () => {
  for (const clarifying of [false, true]) {
    const { tickets, ticket } = await fixture();
    const stale = structuredClone(ticket);
    await recordTriage(tickets, ticket, { ...entry, handoff: true });
    const before = structuredClone(await tickets.findOpen(CHANNEL_NAME, conversationId));
    await recordTriage(tickets, stale, { ...entry, intent: "invoice", clarifying, delivered: true });
    assert.deepEqual(await tickets.findOpen(CHANNEL_NAME, conversationId), before);
  }
});

test("real channel post-send hook does not reactivate handoff after human release", async () => {
  const { tickets, ticket } = await fixture();
  const repository = new MemoryChannelRepository();
  const records = [];
  await processChannelMessage(repository, input, undefined, {
    autoReply: true,
    triage: {
      intercept: async () => ({ text: "Um atendente continua por aqui.", intent: entry.intent, status: "awaiting_human", label: "Encaminhamento", handoff: true }),
      footer: () => undefined,
      record: async value => { records.push(value); await recordTriage(tickets, ticket, value); },
    },
    send: async () => {
      assert.equal((await tickets.findOpen(CHANNEL_NAME, conversationId)).stage, "handoff");
      await resumeTicketForAi(tickets, CHANNEL_NAME, conversationId);
      return { sent: true, messageId: "local-accepted" };
    },
  });
  assert.equal(records.length, 2);
  assert.equal(records[1].deliveryOnly, true);
  assert.equal(records[1].handoff, false);
  assert.equal((await tickets.findOpen(CHANNEL_NAME, conversationId)).stage, "routed");
  assert.equal((await repository.getHistory(CHANNEL_NAME, conversationId)).filter(m => m.role === "customer").length, 1);
});

test("release resumes an already open/unassigned conversation, is repeatable and propagates failure", async () => {
  const { tickets, ticket } = await fixture();
  await recordTriage(tickets, ticket, { ...entry, handoff: true });
  const states = new MemoryConversationStateRepository();
  states.conversations.set(stateKey(CHANNEL_NAME, conversationId), new Date().toISOString());
  const change = { channel: CHANNEL_NAME, conversationId, action: "release", actor: { id: "local", name: "Local", email: "local@example.invalid", role: "admin" } };
  tickets.failUpdates = true;
  await assert.rejects(changeConversationStateWithTicket(states, tickets, change), /banco fora/);
  tickets.failUpdates = false;
  const first = await changeConversationStateWithTicket(states, tickets, change);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const again = await changeConversationStateWithTicket(states, tickets, change);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal((await tickets.findOpen(CHANNEL_NAME, conversationId)).stage, "routed");
  assert.equal(states.audits.at(-1).action, "conversation.release");
});

test("audit failure after durable handoff recovers inbound/evidence before idempotency without sending", async () => {
  const { tickets, ticket } = await fixture();
  class FailingAudit extends MemoryChannelRepository {
    fail = true;
    async audit(event) { if (this.fail) throw new Error("audit unavailable"); return super.audit(event); }
  }
  const repository = new FailingAudit();
  const options = { autoReply: true, send: async () => { throw new Error("must not send"); }, triage: {
    intercept: async () => ({ text: "Um atendente continua.", intent: entry.intent, status: "awaiting_human", label: "Encaminhamento", handoff: true }),
    footer: () => undefined, record: value => recordTriage(tickets, ticket, value),
  } };
  await assert.rejects(processChannelMessage(repository, input, undefined, options), /audit unavailable/);
  assert.equal((await tickets.findOpen(CHANNEL_NAME, conversationId)).stage, "handoff");
  assert.equal((await repository.getHistory(CHANNEL_NAME, conversationId)).length, 1);
  await assert.rejects(processChannelMessage(repository, input, undefined, { ...options, handoffRecorded: true }), /audit unavailable/);
  assert.equal(await repository.findIdempotent(input.idempotencyKey), undefined);
  repository.fail = false;
  const recovered = await processChannelMessage(repository, input, undefined, { ...options, handoffRecorded: true });
  assert.equal(recovered.status, "awaiting_human");
  assert.equal(repository.audits.at(-1).action, "whatsapp.handoff.waiting");
  assert.equal((await repository.getHistory(CHANNEL_NAME, conversationId)).length, 1);
  assert.deepEqual(await processChannelMessage(repository, input, undefined, options), recovered);
});

test("PostgreSQL statements condition routing and resume on the current persisted row", async () => {
  const statements = [];
  const db = drizzle(async (sql, params) => { statements.push({ sql, params }); return { rows: [["local-id"]] }; });
  const tickets = new DbTicketRepository(db);
  await tickets.updateTriage("local-id", { stage: "routed" });
  assert.match(statements[0].sql, /"status" = .*"stage" <>/);
  assert.deepEqual(statements[0].params, ["routed", "local-id", "open", "handoff"]);
  await tickets.resumeForAi(CHANNEL_NAME, conversationId);
  assert.match(statements[1].sql, /"channel" = .*"external_conversation_id" = .*"status" = .*"stage" =/);
  assert.deepEqual(statements[1].params, ["routed", CHANNEL_NAME, conversationId, "open", "handoff"]);
});
