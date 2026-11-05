import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryCollectionDispatchRepository, resolveTodayCandidates, runTodayDispatch,
} from "../lib/platform/collection-dispatch-service.ts";

// Synthetic fixtures only. No database, IXC or channel client is used.
const now = new Date("2026-11-05T15:00:00Z");
const rule = (offsetDays = 0) => ({
  id: "synthetic-rule", name: "Régua fictícia", status: "draft", version: 1,
  authorId: "synthetic-operator", updatedAt: now.toISOString(),
  steps: [{ id: "synthetic-step", offsetDays, channel: "WhatsApp", templateId: "synthetic-template", attempts: 1, active: true }],
});
const invoice = (overrides = {}) => ({
  id: "synthetic-invoice", customerId: "synthetic-customer", status: "A", dueAt: "2026-11-05", ...overrides,
});

for (const status of ["", "  ", "desconhecido", "unknown", "pendente de confirmação", "erro", "não recebida", "em análise", "R", "P", "C", "X", "recebida", "paga", "cancelada"]) {
  test(`régua não presume dívida a partir de status ${JSON.stringify(status)}`, () => {
    assert.deepEqual(resolveTodayCandidates(rule(), [invoice({ status })], now), []);
  });
}

for (const status of ["A", " a ", "Aberta", "aberto", "Em aberto"]) {
  test(`régua mantém status aberto explícito ${JSON.stringify(status)}`, () => {
    assert.equal(resolveTodayCandidates(rule(), [invoice({ status })], now).length, 1);
  });
}

for (const dueAt of ["data inválida", "2026-00-05", "2026-13-05", "2026-11-00", "2026-11-31", "2026-02-29", "2026-11-05lixo", "05/11/2026", "2026-1-5", "2026-11-05T00:00:00Z"]) {
  test(`vencimento inválido ${JSON.stringify(dueAt)} não derruba nem entra na rodada`, () => {
    const candidates = resolveTodayCandidates(rule(), [invoice({ id: "bad", dueAt }), invoice({ id: "good" })], now);
    assert.deepEqual(candidates.map((candidate) => candidate.invoiceId), ["good"]);
  });
}

test("31 de novembro não é normalizado para um contato em 1º de dezembro", () => {
  assert.deepEqual(resolveTodayCandidates(rule(), [invoice({ dueAt: "2026-11-31" })], new Date("2026-12-01T15:00:00Z")), []);
});

test("29 de fevereiro inexistente não vira contato em março", () => {
  assert.deepEqual(resolveTodayCandidates(rule(), [invoice({ dueAt: "2026-02-29" })], new Date("2026-03-01T15:00:00Z")), []);
});

test("29 de fevereiro real e mudança de ano continuam calculados pelo calendário", () => {
  assert.equal(resolveTodayCandidates(rule(1), [invoice({ dueAt: "2028-02-29" })], new Date("2028-03-01T15:00:00Z")).length, 1);
  assert.equal(resolveTodayCandidates(rule(-1), [invoice({ dueAt: "2027-01-01" })], new Date("2026-12-31T15:00:00Z")).length, 1);
});

for (const offsetDays of [NaN, Infinity, 0.5, -31, 181]) {
  test(`etapa com deslocamento inválido ${String(offsetDays)} não gera contato`, () => {
    assert.deepEqual(resolveTodayCandidates(rule(offsetDays), [invoice()], now), []);
  });
}

test("pagamento confirmado R remove candidato e não cria novo registro de cobrança", async () => {
  const repository = new MemoryCollectionDispatchRepository();
  // Outside dispatch hours: the initial open invoice is only previewed.
  const before = await runTodayDispatch(rule(), [invoice()], repository, new Date("2026-11-05T09:00:00Z"), "synthetic-before");
  assert.equal(before.candidates, 1);
  assert.equal(repository.rows.length, 0);
  const paid = await runTodayDispatch(rule(), [invoice({ status: "R" })], repository, now, "synthetic-paid");
  assert.equal(paid.candidates, 0);
  assert.equal(paid.recorded, 0);
  assert.equal(paid.enqueued, 0);
  assert.equal(repository.rows.length, 0);
});

test("rodada desconhecida não reserva ledger e não impede avaliação posterior comprovada", async () => {
  const repository = new MemoryCollectionDispatchRepository();
  const unknown = await runTodayDispatch(rule(), [invoice({ status: "desconhecido" })], repository, now, "synthetic-unknown");
  assert.equal(unknown.candidates, 0);
  assert.equal(unknown.recorded, 0);
  assert.equal(unknown.enqueued, 0);
  assert.equal(repository.rows.length, 0);
  const confirmed = await runTodayDispatch(rule(), [invoice({ status: "A" })], repository, now, "synthetic-confirmed");
  assert.equal(confirmed.candidates, 1);
  assert.equal(confirmed.recorded, 1);
  assert.equal(confirmed.duplicates, 0);
  assert.equal(repository.rows.length, 1);
});
