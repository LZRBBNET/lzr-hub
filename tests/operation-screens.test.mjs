import assert from "node:assert/strict";
import test from "node:test";
import { MemoryConversationsRepository } from "../lib/platform/conversations-service.ts";
import { MemorySupportMetricsRepository, getSupportMetrics } from "../lib/platform/support-metrics.ts";
import { Customer360Service } from "../lib/platform/customer360-service.ts";

// All customer/contact fixtures below are synthetic; DDD00 and DOC-SYNTHETIC are invalid external identifiers.
const PAST = "2000-01-01T00:00:00.000Z";

test("lista de conversas agrupa por conversa e traz a última mensagem", async () => {
  const repository = new MemoryConversationsRepository();
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"5500000910001", role:"customer", content:"tô sem internet", createdAt:"2026-08-01T10:00:00.000Z" });
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"5500000910001", role:"agent", content:"vamos verificar", createdAt:"2026-08-01T10:00:05.000Z" });
  repository.add({ channel:"n8n-whatsapp", externalConversationId:"5500000910002", role:"customer", content:"quero a fatura", createdAt:"2026-08-02T09:00:00.000Z" });

  const items = await repository.listConversations(10);
  assert.equal(items.length, 2);
  assert.equal(items[0].externalConversationId, "5500000910002", "a conversa mais recente vem primeiro");
  const older = items.find((item) => item.externalConversationId === "5500000910001");
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
  customer: { id, name:"CLIENTE SINTÉTICO QA", document:"DOC-SYNTHETIC-INVALID-001", phone:"(00) 00091-0001", email:"customer@lzr-qa.invalid", city:"Cidade Sintética", neighborhood:"Bairro Sintético", address:"Rua Sintética Inexistente, 0", status:"A" },
  contracts: [{ id:"920001", customerId:id, planName:"PLANO SINTÉTICO QA", status:"A" }],
  plan: null, invoices: [], payments: [], serviceOrders: [], connection: null,
  coverage: { contracts: {read:1,total:1,complete:true,limit:20} },
  partialSources: [], metrics:{ totalLatencyMs:10, blockLatencies:{} }, fetchedAt:new Date().toISOString(), mode:"staging-readonly", cache:"miss",
});

test("lista de clientes traz o cadastro retornado pelo provider sintético, não um rótulo genérico", async () => {
  const provider = { getSnapshot: async (id) => snapshotOf(id) };
  const service = new Customer360Service(undefined, provider, ["910001"]);
  const result = await service.list();

  assert.equal(result.mode, "staging-readonly");
  assert.equal(result.items[0].name, "CLIENTE SINTÉTICO QA");
  assert.equal(result.items[0].maskedDocument, "DOC-SYNTHETIC-INVALID-001");
  assert.equal(result.items[0].plan, "PLANO SINTÉTICO QA");
  assert.equal(result.items[0].city, "Cidade Sintética");
});

test("cadastro que falha aparece como indisponível, nunca com nome inventado", async () => {
  const provider = { getSnapshot: async () => { throw new Error("IXC_NETWORK_ERROR"); } };
  const result = await new Customer360Service(undefined, provider, ["910001"]).list();

  assert.equal(result.items[0].status, "Fonte indisponível");
  assert.equal(result.items[0].maskedDocument, "Consulta indisponível");
  assert.ok(result.items[0].tags.includes("IXC indisponível"));
});

test("busca na lista filtra o dado do provider sintético, inclusive documento inválido", async () => {
  const provider = { getSnapshot: async (id) => snapshotOf(id) };
  const service = new Customer360Service(undefined, provider, ["910001"]);

  assert.equal((await service.list("sintético qa")).items.length, 1);
  assert.equal((await service.list("DOC-SYNTHETIC")).items.length, 1);
  assert.equal((await service.list("cliente autorizado")).items.length, 0, "o rótulo genérico antigo não existe mais");
});
