import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryPaymentPromiseRepository, parsePromisedFor, evaluatePendingPromise, reviewPendingPromises,
  PaymentPromiseValidationError, reconcilePaymentPromises,
} from "../lib/platform/payment-promise-service.ts";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const promise = (over = {}) => ({ id: "p1", invoiceId: "inv-1", customerId: "cust-1", promisedFor: "2026-08-10", status: "pending", registeredBy: "vinicius@bbnet.dev", correlationId: "corr-1", createdAt: NOW.toISOString(), ...over });

test("data prometida não pode estar no passado", () => {
  assert.throws(() => parsePromisedFor("2026-08-01", NOW), PaymentPromiseValidationError);
});
test("data prometida aceita hoje", () => {
  assert.equal(parsePromisedFor("2026-08-06", NOW), "2026-08-06");
});
test("data prometida não pode passar de 60 dias", () => {
  assert.throws(() => parsePromisedFor("2026-12-01", NOW), PaymentPromiseValidationError);
});
test("formato inválido é recusado", () => {
  assert.throws(() => parsePromisedFor("06/08/2026", NOW), PaymentPromiseValidationError);
});

test("fatura recebida cumpre a promessa, mesmo antes da data prometida", () => {
  assert.equal(evaluatePendingPromise(promise({ promisedFor: "2026-08-20" }), "R", "2026-08-06"), "fulfilled");
});
test("fatura não encontrada fica sem confirmação — ausência não prova pagamento", () => {
  assert.equal(evaluatePendingPromise(promise(), undefined, "2026-08-06"), "unverified");
  assert.equal(evaluatePendingPromise(promise({ promisedFor: "2026-08-01" }), undefined, "2026-08-06"), "unverified");
});
test("só fatura recebida cumpre a promessa; cancelamento e status desconhecido não são pagamento", () => {
  for (const status of ["R", " r "]) assert.equal(evaluatePendingPromise(promise(), status, "2026-08-06"), "fulfilled");
  for (const status of ["C", "P", "X", "", "desconhecido", "recebida parcialmente", "cancelada"]) {
    assert.equal(evaluatePendingPromise(promise({ promisedFor: "2026-08-01" }), status, "2026-08-06"), "unverified", status);
  }
});
test("data vencida com fatura ainda aberta quebra a promessa", () => {
  assert.equal(evaluatePendingPromise(promise({ promisedFor: "2026-08-01" }), "A", "2026-08-06"), "broken");
});
test("data no futuro com fatura aberta continua pendente", () => {
  assert.equal(evaluatePendingPromise(promise({ promisedFor: "2026-08-10" }), "A", "2026-08-06"), "pending");
});
test("no dia exato da promessa ainda não quebra — só depois", () => {
  assert.equal(evaluatePendingPromise(promise({ promisedFor: "2026-08-06" }), "A", "2026-08-06"), "pending");
});

test("reviewPendingPromises separa cumpridas, quebradas e pendentes sem tocar o banco", () => {
  const promises = [
    promise({ id: "cumprida", invoiceId: "inv-a", promisedFor: "2026-08-01" }),
    promise({ id: "quebrada", invoiceId: "inv-b", promisedFor: "2026-08-01" }),
    promise({ id: "pendente", invoiceId: "inv-c", promisedFor: "2026-08-20" }),
  ];
  const statusPorFatura = new Map([["inv-a", "R"], ["inv-b", "A"], ["inv-c", "A"]]);
  const result = reviewPendingPromises(promises, statusPorFatura, "2026-08-06");
  assert.deepEqual(result.fulfilled, ["cumprida"]);
  assert.deepEqual(result.broken, ["quebrada"]);
  assert.deepEqual(result.stillPending, ["pendente"]);
  assert.deepEqual(result.unverified, []);
});

test("revisão pura separa ausência de evidência e ignora promessas já encerradas", () => {
  const result = reviewPendingPromises([
    promise({ id: "sem-dado", promisedFor: "2026-08-01" }),
    promise({ id: "encerrada", status: "broken" }),
  ], new Map(), "2026-08-06");
  assert.deepEqual(result, { fulfilled: [], broken: [], stillPending: [], unverified: ["sem-dado"] });
});

test("criar e listar por cliente", async () => {
  const repository = new MemoryPaymentPromiseRepository();
  await repository.create({ invoiceId: "inv-1", customerId: "cust-1", promisedFor: "2026-08-10", registeredBy: "vinicius@bbnet.dev", correlationId: "corr-1" });
  await repository.create({ invoiceId: "inv-2", customerId: "cust-2", promisedFor: "2026-08-12", registeredBy: "vinicius@bbnet.dev", correlationId: "corr-2" });
  const doCliente1 = await repository.listByCustomer("cust-1");
  assert.equal(doCliente1.length, 1);
  assert.equal(doCliente1[0].status, "pending");
});

test("updateStatus muda o status sem duplicar a linha", async () => {
  const repository = new MemoryPaymentPromiseRepository();
  const created = await repository.create({ invoiceId: "inv-1", customerId: "cust-1", promisedFor: "2026-08-10", registeredBy: "vinicius@bbnet.dev", correlationId: "corr-1" });
  await repository.updateStatus(created.id, "broken");
  const pending = await repository.listPending();
  assert.equal(pending.length, 0);
  const doCliente = await repository.listByCustomer("cust-1");
  assert.equal(doCliente.length, 1);
  assert.equal(doCliente[0].status, "broken");
});

function pendingRepository(rows = [promise({ promisedFor: "2026-08-01" })]) {
  const repository = new MemoryPaymentPromiseRepository();
  repository.rows.push(...rows.map((row) => ({ ...row })));
  const writes = [];
  const update = repository.updateStatus.bind(repository);
  repository.updateStatus = async (id, status) => { writes.push({ id, status }); await update(id, status); };
  return { repository, writes };
}
const snapshot = (invoices = [], partialSources = []) => ({ invoices, partialSources });
const invoice = (status = "A", over = {}) => ({ id: "inv-1", customerId: "cust-1", status, ...over });

for (const [label, source] of [
  ["IXC desligado", undefined],
  ["IXC indisponível", { getSnapshot: async () => { throw new Error("IXC_TIMEOUT"); } }],
  ["fonte de faturas parcial", { getSnapshot: async () => snapshot([invoice("R")], ["invoices"]) }],
  ["fatura fora da página do snapshot", { getSnapshot: async () => snapshot([invoice("R", { id: "outra" })]) }],
  ["status desconhecido", { getSnapshot: async () => snapshot([invoice("X")]) }],
  ["fatura cancelada", { getSnapshot: async () => snapshot([invoice("C")]) }],
]) test(`reconciliação preserva a promessa sem gravar: ${label}`, async () => {
  const { repository, writes } = pendingRepository();
  const result = await reconcilePaymentPromises(repository, source, "corr-review", NOW);
  assert.deepEqual(result, { fulfilled: [], broken: [], stillPending: [], unverified: ["p1"] });
  assert.equal(repository.rows[0].status, "pending");
  assert.deepEqual(writes, [], "não regrava nem marca pagamento sem evidência");
});

test("reconciliação usa uma consulta fresca por cliente, não o cache ou uma consulta por promessa", async () => {
  const { repository, writes } = pendingRepository([
    promise({ id: "paga", invoiceId: "inv-1" }),
    promise({ id: "atrasada", invoiceId: "inv-2", promisedFor: "2026-08-01" }),
    promise({ id: "futura", invoiceId: "inv-3" }),
  ]);
  const calls = [];
  const source = { async getSnapshot(...args) {
    calls.push(args);
    return snapshot([invoice("R"), invoice("A", { id: "inv-2" }), invoice("A", { id: "inv-3" })], ["connection"]);
  } };
  const result = await reconcilePaymentPromises(repository, source, "corr-fresh", NOW);
  assert.deepEqual(calls, [["cust-1", "corr-fresh", true]]);
  assert.deepEqual(result, { fulfilled: ["paga"], broken: ["atrasada"], stillPending: ["futura"], unverified: [] });
  assert.deepEqual(writes, [{ id: "paga", status: "fulfilled" }, { id: "atrasada", status: "broken" }]);
});

test("falha de um cliente não altera suas promessas nem impede conferir outro", async () => {
  const { repository, writes } = pendingRepository([
    promise({ id: "sem-dado", customerId: "cust-2" }),
    promise({ id: "paga" }),
  ]);
  const source = { async getSnapshot(customerId) {
    if (customerId === "cust-2") throw new Error("IXC_RATE_LIMITED");
    return snapshot([invoice("R")]);
  } };
  const result = await reconcilePaymentPromises(repository, source, "corr-mixed", NOW);
  assert.deepEqual(result, { fulfilled: ["paga"], broken: [], stillPending: [], unverified: ["sem-dado"] });
  assert.deepEqual(writes, [{ id: "paga", status: "fulfilled" }]);
});

test("status de fatura de outro cadastro nunca serve como evidência", async () => {
  const { repository, writes } = pendingRepository();
  const source = { getSnapshot: async () => snapshot([invoice("R", { customerId: "cust-2" })]) };
  const result = await reconcilePaymentPromises(repository, source, "corr-scope", NOW);
  assert.deepEqual(result.unverified, ["p1"]);
  assert.deepEqual(writes, []);
});

test("repetir depois de falha só cumpre quando chega confirmação real", async () => {
  const { repository, writes } = pendingRepository();
  await reconcilePaymentPromises(repository, undefined, "corr-down", NOW);
  const source = { getSnapshot: async () => snapshot([invoice("R")]) };
  const recovered = await reconcilePaymentPromises(repository, source, "corr-up", NOW);
  assert.deepEqual(recovered.fulfilled, ["p1"]);
  const repeated = await reconcilePaymentPromises(repository, source, "corr-repeat", NOW);
  assert.deepEqual(repeated, { fulfilled: [], broken: [], stillPending: [], unverified: [] });
  assert.deepEqual(writes, [{ id: "p1", status: "fulfilled" }]);
});

test("sem promessas pendentes não consulta o IXC", async () => {
  const { repository, writes } = pendingRepository([]);
  const source = { getSnapshot: async () => { assert.fail("não deveria consultar"); } };
  assert.deepEqual(await reconcilePaymentPromises(repository, source, "corr-empty", NOW), { fulfilled: [], broken: [], stillPending: [], unverified: [] });
  assert.deepEqual(writes, []);
});
