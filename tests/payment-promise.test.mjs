import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  MemoryPaymentPromiseRepository, parsePromisedFor, evaluatePendingPromise, reviewPendingPromises,
  PaymentPromiseValidationError, reconcilePaymentPromises, parsePromiseReviewCursor, PROMISE_REVIEW_BATCH_SIZE, DbPaymentPromiseRepository,
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

const billPromise = (over = {}) => promise({ customerId: "10", invoiceId: "101", promisedFor: "2026-08-01", ...over });
function pendingRepository(rows = [billPromise()]) {
  const repository = new MemoryPaymentPromiseRepository();
  repository.rows.push(...rows.map((row) => ({ ...row })));
  const writes = [];
  const update = repository.updateStatus.bind(repository);
  repository.updateStatus = async (id, status) => { writes.push({ id, status }); return update(id, status); };
  return { repository, writes };
}
const invoice = (status = "A", over = {}) => ({ id: "101", customerId: "10", status, ...over });
const expected = (over = {}) => ({ fulfilled: [], broken: [], stillPending: [], unverified: [], examined: 1, lookupCount: 1, batchLimit: PROMISE_REVIEW_BATCH_SIZE, hasMore: false, nextCursor: null, ...over });

for (const [label, source] of [
  ["IXC desligado", undefined],
  ["IXC indisponível", { getInvoiceForCustomer: async () => { throw new Error("IXC_TIMEOUT"); } }],
  ["resposta de faturas parcial", { getInvoiceForCustomer: async () => { throw new Error("IXC_INCOMPLETE_INVOICE_RESPONSE"); } }],
  ["fatura ausente", { getInvoiceForCustomer: async () => undefined }],
  ["status desconhecido", { getInvoiceForCustomer: async () => invoice("X") }],
  ["fatura cancelada", { getInvoiceForCustomer: async () => invoice("C") }],
  ["outro cliente", { getInvoiceForCustomer: async () => invoice("R", { customerId: "20" }) }],
  ["outra fatura", { getInvoiceForCustomer: async () => invoice("R", { id: "102" }) }],
  ["status malformado", { getInvoiceForCustomer: async () => invoice(7) }],
]) test(`reconciliação preserva a promessa sem gravar: ${label}`, async () => {
  const { repository, writes } = pendingRepository();
  const result = await reconcilePaymentPromises(repository, source, "corr-review", NOW);
  assert.deepEqual(result, expected({ unverified: ["p1"], lookupCount: source ? 1 : 0 }));
  assert.equal(repository.rows[0].status, "pending");
  assert.deepEqual(writes, []);
});

test("reconciliação usa consulta pontual fresca por cliente/fatura, nunca o snapshot limitado", async () => {
  const { repository, writes } = pendingRepository([
    billPromise({ id: "p1" }), billPromise({ id: "p2", invoiceId: "102" }),
    billPromise({ id: "p3", invoiceId: "103", promisedFor: "2026-08-10" }),
  ]);
  const calls = [];
  const source = {
    getSnapshot() { assert.fail("snapshot de 20 faturas não é usado"); },
    async getInvoiceForCustomer(customerId, invoiceId, correlationId) {
      calls.push([customerId, invoiceId, correlationId]);
      return invoice(invoiceId === "101" ? "R" : "A", { id: invoiceId });
    },
  };
  const result = await reconcilePaymentPromises(repository, source, "corr-exact", NOW);
  assert.deepEqual(calls, [["10", "101", "corr-exact"], ["10", "102", "corr-exact"], ["10", "103", "corr-exact"]]);
  assert.deepEqual(result, expected({ fulfilled: ["p1"], broken: ["p2"], stillPending: ["p3"], examined: 3, lookupCount: 3 }));
  assert.deepEqual(writes, [{ id: "p1", status: "fulfilled" }, { id: "p2", status: "broken" }]);
});

test("falha de um cliente não altera sua promessa nem impede conferir outro", async () => {
  const { repository, writes } = pendingRepository([billPromise({ id: "p1", customerId: "20" }), billPromise({ id: "p2" })]);
  const source = { async getInvoiceForCustomer(customerId) {
    if (customerId === "20") throw new Error("IXC_RATE_LIMITED");
    return invoice("R");
  } };
  const result = await reconcilePaymentPromises(repository, source, "corr-mixed", NOW);
  assert.deepEqual(result, expected({ fulfilled: ["p2"], unverified: ["p1"], examined: 2, lookupCount: 2 }));
  assert.deepEqual(writes, [{ id: "p2", status: "fulfilled" }]);
});

test("promessas duplicadas da mesma fatura compartilham leitura só dentro do lote", async () => {
  const { repository, writes } = pendingRepository([billPromise({ id: "p1" }), billPromise({ id: "p2", promisedFor: "2026-08-10" })]);
  let calls = 0;
  const source = { async getInvoiceForCustomer() { calls++; return invoice("A"); } };
  const first = await reconcilePaymentPromises(repository, source, "corr-duplicate", NOW);
  assert.equal(first.lookupCount, 1);
  assert.equal(calls, 1);
  assert.deepEqual(first.broken, ["p1"]);
  assert.deepEqual(first.stillPending, ["p2"]);
  await reconcilePaymentPromises(repository, source, "corr-fresh-again", NOW);
  assert.equal(calls, 2, "nova revisão é nova leitura, não cache");
  assert.deepEqual(writes, [{ id: "p1", status: "broken" }]);
});

test("deduplicação não mistura a mesma referência de fatura em clientes diferentes", async () => {
  const { repository } = pendingRepository([billPromise({ id: "p1" }), billPromise({ id: "p2", customerId: "20" })]);
  const calls = [];
  const result = await reconcilePaymentPromises(repository, { async getInvoiceForCustomer(customerId) { calls.push(customerId); return invoice("R"); } }, "corr-scope", NOW);
  assert.deepEqual(calls, ["10", "20"]);
  assert.deepEqual(result.fulfilled, ["p1"]);
  assert.deepEqual(result.unverified, ["p2"]);
});

test("repetir depois de falha só cumpre quando chega confirmação real", async () => {
  const { repository, writes } = pendingRepository();
  await reconcilePaymentPromises(repository, undefined, "corr-down", NOW);
  const source = { getInvoiceForCustomer: async () => invoice("R") };
  const recovered = await reconcilePaymentPromises(repository, source, "corr-up", NOW);
  assert.deepEqual(recovered.fulfilled, ["p1"]);
  assert.deepEqual(await reconcilePaymentPromises(repository, source, "corr-repeat", NOW), expected({ examined: 0, lookupCount: 0 }));
  assert.deepEqual(writes, [{ id: "p1", status: "fulfilled" }]);
});

test("sem pendentes não consulta o IXC nem carrega a listagem completa", async () => {
  const { repository, writes } = pendingRepository([]);
  repository.listPending = () => assert.fail("listagem ilimitada não é usada na revisão");
  const source = { getInvoiceForCustomer: async () => assert.fail("não deveria consultar") };
  assert.deepEqual(await reconcilePaymentPromises(repository, source, "corr-empty", NOW), expected({ examined: 0, lookupCount: 0 }));
  assert.deepEqual(writes, []);
});

test("lote tem teto de 20 leituras e cursor alcança pendentes posteriores mesmo quando anteriores são desconhecidas", async () => {
  const rows = Array.from({ length: 23 }, (_, i) => billPromise({ id: `p${String(i).padStart(2, "0")}`, invoiceId: String(1000 + i) }));
  const { repository, writes } = pendingRepository(rows);
  let calls = 0;
  const source = { async getInvoiceForCustomer() { calls++; return undefined; } };
  const first = await reconcilePaymentPromises(repository, source, "corr-first", NOW);
  assert.equal(first.lookupCount, 20); assert.equal(first.examined, 20); assert.equal(first.hasMore, true); assert.equal(first.nextCursor, "p19");
  const second = await reconcilePaymentPromises(repository, source, "corr-next", NOW, first.nextCursor);
  assert.equal(second.lookupCount, 3); assert.equal(second.hasMore, false); assert.equal(second.nextCursor, null);
  assert.deepEqual(second.unverified, ["p20", "p21", "p22"]); assert.equal(calls, 23); assert.deepEqual(writes, []);
  const restart = await reconcilePaymentPromises(repository, source, "corr-restart", NOW);
  assert.deepEqual(restart.unverified, first.unverified);
});

test("cursor não depende de offset: encerrar registros anteriores não pula o próximo lote", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => billPromise({ id: `p${String(i).padStart(2, "0")}`, invoiceId: String(1000 + i) }));
  const { repository } = pendingRepository(rows);
  const source = { async getInvoiceForCustomer(customerId, id) { return { id, customerId, status: "R" }; } };
  const first = await reconcilePaymentPromises(repository, source, "corr-first", NOW);
  const second = await reconcilePaymentPromises(repository, source, "corr-next", NOW, first.nextCursor);
  assert.equal(first.fulfilled.length, 20); assert.deepEqual(second.fulfilled, ["p20"]);
});

test("referências inválidas preservam a promessa antes de qualquer consulta", async () => {
  for (const over of [{ customerId: "abc" }, { invoiceId: "0" }, { invoiceId: "1 OR 1=1" }, { invoiceId: "9".repeat(33) }]) {
    const { repository, writes } = pendingRepository([billPromise(over)]);
    const result = await reconcilePaymentPromises(repository, { getInvoiceForCustomer() { assert.fail("sem leitura para referência inválida"); } }, "corr-invalid", NOW);
    assert.deepEqual(result.unverified, ["p1"]); assert.equal(result.lookupCount, 0); assert.deepEqual(writes, []);
  }
});

test("cursor inválido é rejeitado antes de consultar repositório ou IXC", async () => {
  assert.equal(parsePromiseReviewCursor(undefined), null);
  assert.equal(parsePromiseReviewCursor("p19"), "p19");
  const { repository } = pendingRepository();
  repository.listPendingForReview = () => assert.fail("cursor inválido não consulta banco");
  for (const value of ["", 1, {}, "../id", " ", "x".repeat(129)]) {
    assert.throws(() => parsePromiseReviewCursor(value), PaymentPromiseValidationError);
    await assert.rejects(reconcilePaymentPromises(repository, undefined, "corr-cursor", NOW, value), PaymentPromiseValidationError);
  }
});

test("resposta atrasada não sobrescreve promessa encerrada por revisão concorrente", async () => {
  const { repository } = pendingRepository();
  const source = { async getInvoiceForCustomer() { repository.rows[0].status = "fulfilled"; return invoice("A"); } };
  const result = await reconcilePaymentPromises(repository, source, "corr-race", NOW);
  assert.equal(repository.rows[0].status, "fulfilled"); assert.deepEqual(result.broken, []); assert.deepEqual(result.unverified, ["p1"]);
});

test("SQL da revisão é paginado por chave e atualização exige estado pendente", async () => {
  const calls = [];
  const db = drizzle({ client: { async query(config, parameters) { calls.push({ sql: config.text, parameters }); return { rows: [] }; } } });
  const repository = new DbPaymentPromiseRepository(db);
  await repository.listPendingForReview("p19", 999);
  assert.match(calls[0].sql, /"status" = \$1/); assert.match(calls[0].sql, /"id" > \$2/);
  assert.match(calls[0].sql, /order by .*"id" asc limit \$3/); assert.deepEqual(calls[0].parameters, ["pending", "p19", 21]);
  assert.equal(await repository.updateStatus("p20", "fulfilled"), false);
  assert.match(calls[1].sql, /where .*"id" = \$3 and .*"status" = \$4/);
  assert.deepEqual(calls[1].parameters.slice(2), ["p20", "pending"]);
});
