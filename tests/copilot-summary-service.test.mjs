import test from "node:test";
import assert from "node:assert/strict";
import { loadConversationSummary, SUMMARY_MESSAGE_LIMIT } from "../lib/platform/copilot-summary-service.ts";

const channel = "synthetic-whatsapp";
const id = "synthetic-handoff-1";
const at = "2026-11-05T10:00:00.000Z";
const row = { status: "open", assigneeId: "synthetic-agent-1", assigneeName: "Ana Teste", assignedAt: at, resolvedAt: null, resolvedBy: null };
const message = { role: "customer", content: "Quero falar com atendente após falha da conexão.", createdAt: at };
const outcome = { intent: "human_handoff", finalStatus: "handoff", handoff: true, handoffReason: "customer_requested_human" };

function fixtures(overrides = {}) {
  const calls = [];
  const remember = (method, value) => async (...args) => { calls.push([method, ...args]); return value; };
  return {
    calls,
    conversations: {
      getMessages: remember("messages", overrides.messages ?? [message]),
      getAudit: remember("audit", overrides.outcome ?? outcome),
    },
    states: {
      get: remember("state", Object.hasOwn(overrides, "state") ? overrides.state : row),
      lastCustomerAt: remember("lastCustomer", overrides.lastCustomerAt ?? at),
    },
  };
}

test("carrega motivo, contexto e responsável dos repositórios da mesma conversa", async () => {
  const f = fixtures();
  const text = await loadConversationSummary(f.conversations, f.states, channel, id);
  assert.match(text, /Cliente pediu atendente/);
  assert.match(text, /falha da conexão/);
  assert.match(text, /Responsável atual: Ana Teste/);
  assert.deepEqual(f.calls, [["messages", channel, id, SUMMARY_MESSAGE_LIMIT + 1], ["audit", channel, id], ["state", channel, id], ["lastCustomer", channel, id]]);
});

test("sem atribuição persistida deixa a responsabilidade pendente", async () => {
  const f = fixtures({ state: undefined });
  const text = await loadConversationSummary(f.conversations, f.states, channel, id);
  assert.match(text, /ainda não atribuído/);
  assert.doesNotMatch(text, /Ana Teste/);
});

test("nova fala após resolução reabre sem herdar o responsável antigo", async () => {
  const f = fixtures({ state: { ...row, status: "resolved", resolvedAt: "2026-11-05T09:00:00.000Z", resolvedBy: "Ana Teste" } });
  const text = await loadConversationSummary(f.conversations, f.states, channel, id);
  assert.match(text, /reaberta pelo cliente/);
  assert.match(text, /ainda não atribuído/);
  assert.doesNotMatch(text, /Responsável atual: Ana Teste/);
});

test("fala anterior à resolução mantém estado resolvido", async () => {
  const f = fixtures({ state: { ...row, status: "resolved", resolvedAt: "2026-11-05T11:00:00.000Z" } });
  const text = await loadConversationSummary(f.conversations, f.states, channel, id);
  assert.match(text, /Situação atual: resolvida/);
  assert.doesNotMatch(text, /Responsável atual: Ana Teste/);
});

test("201 linhas viram trecho limitado a 200, sem alegar o início original", async () => {
  const messages = Array.from({ length: SUMMARY_MESSAGE_LIMIT + 1 }, (_, n) => ({ ...message, content: `Fala sintética ${n}` }));
  const f = fixtures({ messages });
  const text = await loadConversationSummary(f.conversations, f.states, channel, id);
  assert.match(text, /200 mensagem/);
  assert.match(text, /Histórico parcial/);
  assert.match(text, /Primeira fala do cliente neste trecho: "Fala sintética 1"/);
  assert.match(text, /Última fala do cliente: "Fala sintética 200"/);
});

test("exatamente 200 linhas não recebem aviso indevido de truncamento", async () => {
  const f = fixtures({ messages: Array.from({ length: SUMMARY_MESSAGE_LIMIT }, () => message) });
  const text = await loadConversationSummary(f.conversations, f.states, channel, id);
  assert.match(text, /200 mensagem/);
  assert.doesNotMatch(text, /Histórico parcial/);
});

for (const [repository, method] of [["conversations", "getMessages"], ["conversations", "getAudit"], ["states", "get"], ["states", "lastCustomerAt"]]) {
  test(`falha de ${method} não vira resumo aparentemente completo`, async () => {
    const f = fixtures();
    f[repository][method] = async () => { throw new Error("synthetic read failure"); };
    await assert.rejects(loadConversationSummary(f.conversations, f.states, channel, id), /synthetic read failure/);
  });
}

test("conversa sem mensagens não ganha narrativa a partir de estado residual", async () => {
  const f = fixtures({ messages: [] });
  const text = await loadConversationSummary(f.conversations, f.states, channel, id);
  assert.match(text, /não há o que resumir/);
  assert.doesNotMatch(text, /Ana Teste/);
});
