import assert from "node:assert/strict";
import test from "node:test";
import { MemoryConversationsRepository } from "../lib/platform/conversations-service.ts";
import { MemorySupportMetricsRepository, getSupportMetrics } from "../lib/platform/support-metrics.ts";
import { Customer360Service } from "../lib/platform/customer360-service.ts";

const PAST = "2000-01-01T00:00:00.000Z";

test("lista de conversas agrupa por conversa e traz a última mensagem", async () => {
  const repository = new MemoryConversationsRepository();
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"5579999990000", role:"customer", content:"tô sem internet", createdAt:"2026-08-01T10:00:00.000Z" });
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"5579999990000", role:"agent", content:"vamos verificar", createdAt:"2026-08-01T10:00:05.000Z" });
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"5579999990001", role:"customer", content:"quero a fatura", createdAt:"2026-08-02T09:00:00.000Z" });

  const items = await repository.listConversations(10);
  assert.equal(items.length, 2);
  assert.equal(items[0].externalConversationId, "5579999990001", "a conversa mais recente vem primeiro");
  const older = items.find((item) => item.externalConversationId === "5579999990000");
  assert.equal(older.messages, 2);
  assert.equal(older.lastMessage, "vamos verificar");
  assert.equal(older.lastRole, "agent");
});

test("mensagens de uma conversa saem em ordem cronológica", async () => {
  const repository = new MemoryConversationsRepository();
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"c1", role:"agent", content:"segunda", createdAt:"2026-08-01T10:00:05.000Z" });
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"c1", role:"customer", content:"primeira", createdAt:"2026-08-01T10:00:00.000Z" });
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"outra", role:"customer", content:"não é dessa conversa", createdAt:"2026-08-01T10:00:01.000Z" });

  const messages = await repository.getMessages("n8n-whatsapp", "c1", 100);
  assert.deepEqual(messages.map((item) => item.content), ["primeira", "segunda"]);
});

test("sem conversa gravada a lista volta vazia, nunca com exemplo", async () => {
  assert.deepEqual(await new MemoryConversationsRepository().listConversations(10), []);
});

test("métricas contam conversas por intenção detectada", async () => {
  const repository = new MemorySupportMetricsRepository();
  const outcome = (intent) => ({ channel:"n8n-whatsapp", externalConversationId:`c-${Math.random()}`, intent, finalStatus:"handoff", handoff:true, handoffReason:"low_intent_confidence", correlationId:"corr" });
  await repository.saveOutcome(outcome("financial_invoice"));
  await repository.saveOutcome(outcome("financial_invoice"));
  await repository.saveOutcome(outcome("technical_slow"));

  const metrics = await getSupportMetrics(repository, PAST);
  assert.deepEqual(metrics.intents, { financial_invoice: 2, technical_slow: 1 });
});

const snapshotOf = (id) => ({
  customer: { id, name:"WENDEL MENDONCA SANTOS", document:"123.456.789-00", phone:"(79) 90000-0000", email:"não informado", city:"Campo do Brito", neighborhood:"Centro", address:"Rua A, 10", status:"A" },
  contracts: [{ id:"48882", customerId:id, planName:"FIBRA 1,2GB", status:"A" }],
  plan: null, invoices: [], payments: [], serviceOrders: [], connection: null,
  partialSources: [], metrics:{ totalLatencyMs:10, blockLatencies:{} }, fetchedAt:new Date().toISOString(), mode:"staging-readonly", cache:"miss",
});

test("lista de clientes traz o cadastro real do IXC, não um rótulo genérico", async () => {
  const provider = { getSnapshot: async (id) => snapshotOf(id) };
  const service = new Customer360Service(undefined, provider, ["21857"]);
  const result = await service.list();

  assert.equal(result.mode, "staging-readonly");
  assert.equal(result.items[0].name, "WENDEL MENDONCA SANTOS");
  assert.equal(result.items[0].maskedDocument, "123.456.789-00");
  assert.equal(result.items[0].plan, "FIBRA 1,2GB");
  assert.equal(result.items[0].city, "Campo do Brito");
});

test("cadastro que falha aparece como indisponível, nunca com nome inventado", async () => {
  const provider = { getSnapshot: async () => { throw new Error("IXC_NETWORK_ERROR"); } };
  const result = await new Customer360Service(undefined, provider, ["21857"]).list();

  assert.equal(result.items[0].status, "Fonte indisponível");
  assert.equal(result.items[0].maskedDocument, "Consulta indisponível");
  assert.ok(result.items[0].tags.includes("IXC indisponível"));
});

test("busca na lista do IXC filtra pelo dado real, inclusive por CPF", async () => {
  const provider = { getSnapshot: async (id) => snapshotOf(id) };
  const service = new Customer360Service(undefined, provider, ["21857"]);

  assert.equal((await service.list("wendel")).items.length, 1);
  assert.equal((await service.list("123.456")).items.length, 1);
  assert.equal((await service.list("cliente autorizado")).items.length, 0, "o rótulo genérico antigo não existe mais");
});
