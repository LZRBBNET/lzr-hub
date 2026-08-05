import test from "node:test";
import assert from "node:assert/strict";
import { summarizeChurn } from "../lib/platform/churn-service.ts";
import { KnowledgeValidationError, MemoryKnowledgeRepository, parseKnowledgeInput, searchDocuments } from "../lib/platform/knowledge-service.ts";

const cancellation = (reasonCode, cancelledAt, monthlyValue) => ({ reasonCode, cancelledAt, monthlyValue });
const summarize = (rows, options = {}) => summarizeChurn(rows, { total: rows.length, truncated: false, activeContracts: 14955, inactiveContracts: 21949, ...options });

test("taxa de churn é sobre a base ativa, e saldo compara com as ativações", () => {
  const result = summarize(
    [cancellation("40", "2026-08-01", 100), cancellation("40", "2026-08-02", 50)],
    { total: 242, activationsInPeriod: 262 },
  );
  assert.equal(result.cancellations, 242);
  assert.equal(result.netContracts, 20, "262 vendas contra 242 perdas");
  assert.ok(Math.abs(result.churnRate - 242 / 14955) < 1e-9);
});

test("sem base ativa a taxa é nula, e sem ativações o saldo não é inventado", () => {
  const semBase = summarize([], { total: 0, activeContracts: 0 });
  assert.equal(semBase.churnRate, null, "dividir por zero não vira 0%");
  assert.equal(semBase.netContracts, null, "sem saber quanto entrou, não dá para dizer o saldo");
});

test("motivos saem por código, do mais frequente ao menos", () => {
  const result = summarize([
    cancellation("40", "2026-08-01", 10),
    cancellation("12", "2026-08-01", 10),
    cancellation("40", "2026-08-02", 10),
  ]);
  assert.deepEqual(result.reasonCodes, [{ code: "40", contracts: 2 }, { code: "12", contracts: 1 }]);
});

test("cancelamento sem valor legível fica fora da receita perdida", () => {
  const result = summarize([cancellation("40", "2026-08-01", 100), cancellation("40", "2026-08-01", undefined)]);
  assert.equal(result.monthlyRecurringLost, 100);
  assert.equal(result.withoutValue, 1);
});

test("documento sem conteúdo é recusado: a IA não pode citar fonte vazia", () => {
  assert.throws(() => parseKnowledgeInput({ title: "Procedimento de PIX", content: "curto" }), KnowledgeValidationError);
  assert.throws(() => parseKnowledgeInput({ title: "ab", content: "Conteúdo longo o suficiente para passar." }), KnowledgeValidationError);
  const parsed = parseKnowledgeInput({ title: "Procedimento de PIX", content: "Como gerar a segunda via do boleto pelo portal." });
  assert.equal(parsed.category, "Geral", "categoria ausente cai num padrão, não quebra");
});

test("rascunho não é fonte: só documento publicado aparece na busca", async () => {
  const repository = new MemoryKnowledgeRepository();
  const draft = await repository.create({ title: "Potência óptica", category: "Suporte", content: "Faixa aceitável de potência óptica em dBm." });

  assert.deepEqual(searchDocuments(await repository.list(50), "potência óptica"), [], "rascunho fica de fora");

  await repository.publish(draft.id);
  const hits = searchDocuments(await repository.list(50), "potência óptica");
  assert.equal(hits.length, 1);
  assert.match(hits[0].evidence, /Fonte interna/);
  assert.equal(hits[0].document.version, 2, "publicar cria versão nova");
});

test("busca ignora termo curto demais e não devolve tudo por engano", async () => {
  const repository = new MemoryKnowledgeRepository();
  const doc = await repository.create({ title: "Boleto", category: "Financeiro", content: "Procedimento de segunda via do boleto." });
  await repository.publish(doc.id);
  assert.deepEqual(searchDocuments(await repository.list(50), "de"), [], "termo de 2 letras casaria com quase tudo");
  assert.equal(searchDocuments(await repository.list(50), "boleto").length, 1);
});
