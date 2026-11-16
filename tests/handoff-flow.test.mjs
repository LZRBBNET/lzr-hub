import test from "node:test";
import assert from "node:assert/strict";
import { MemoryChannelRepository, processChannelMessage, CHANNEL_NAME } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { MemoryConversationStateRepository, changeConversationState, stateKey } from "../lib/platform/conversation-state-service.ts";
import { loadConversationSummary } from "../lib/platform/copilot-summary-service.ts";

test("pedido de humano → motivo persistido em memória → resumo → atendente assume, sem envio", async (t) => {
  // Nem classificador externo, telemetria nem transporte podem sair deste teste.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External fetch forbidden in synthetic handoff test"); });
  const prior = { FEATURE_LLM_INTENT: process.env.FEATURE_LLM_INTENT, FEATURE_LANGFUSE: process.env.FEATURE_LANGFUSE };
  process.env.FEATURE_LLM_INTENT = "false";
  process.env.FEATURE_LANGFUSE = "false";
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  const states = new MemoryConversationStateRepository();
  const id = "synthetic-handoff-flow";
  const input = { externalConversationId: id, text: "Quero falar com um atendente humano.", idempotencyKey: "synthetic-inbound-1", correlationId: "synthetic-correlation-1" };
  let sends = 0;
  const options = { autoReply: false, send: async () => { sends++; throw new Error("No real sends"); } };
  const result = await processChannelMessage(channel, input, metrics, options);
  assert.equal(result.handoff, true);
  assert.equal(result.autoReply, false);
  assert.equal(result.response, null);
  assert.equal(metrics.outcomes[0].handoffReason, "customer_requested_human");
  const history = await channel.getHistory(CHANNEL_NAME, id);
  const customerAt = history.find((message) => message.role === "customer").createdAt;
  states.conversations.set(stateKey(CHANNEL_NAME, id), customerAt);
  const conversations = {
    getMessages: async (source, conversationId, limit) => (await channel.getHistory(source, conversationId)).slice(-limit),
    getAudit: async (source, conversationId) => metrics.outcomes.findLast((item) => item.channel === source && item.externalConversationId === conversationId),
  };
  const before = await loadConversationSummary(conversations, states, CHANNEL_NAME, id);
  assert.match(before, /Cliente pediu atendente/);
  assert.match(before, /ainda não atribuído/);
  assert.match(before, /Sugestões não enviadas: 1/);
  const claimed = await changeConversationState(states, { channel: CHANNEL_NAME, conversationId: id, action: "claim", actor: { id: "synthetic-agent", name: "Ana Teste", email: "ana@example.test", role: "Atendente" } });
  assert.equal(claimed.ok, true);
  const after = await loadConversationSummary(conversations, states, CHANNEL_NAME, id);
  assert.match(after, /Responsável atual: Ana Teste/);
  assert.equal(states.audits[0].action, "conversation.claim");
  assert.deepEqual(await processChannelMessage(channel, input, metrics, options), result);
  assert.equal(metrics.outcomes.length, 1);
  assert.equal((await channel.getHistory(CHANNEL_NAME, id)).length, 2);
  assert.equal(sends, 0);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});
