import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryPaymentPromiseRepository, parsePromisedFor, evaluatePendingPromise, reviewPendingPromises,
  PaymentPromiseValidationError,
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

test("fatura fechada cumpre a promessa, mesmo antes da data prometida", () => {
  assert.equal(evaluatePendingPromise(promise({ promisedFor: "2026-08-20" }), "P", "2026-08-06"), "fulfilled");
});
test("fatura sem status conhecido (não achada) também conta como cumprida — não há dívida para cobrar", () => {
  assert.equal(evaluatePendingPromise(promise(), undefined, "2026-08-06"), "fulfilled");
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
  const statusPorFatura = new Map([["inv-a", "P"], ["inv-b", "A"], ["inv-c", "A"]]);
  const result = reviewPendingPromises(promises, statusPorFatura, "2026-08-06");
  assert.deepEqual(result.fulfilled, ["cumprida"]);
  assert.deepEqual(result.broken, ["quebrada"]);
  assert.deepEqual(result.stillPending, ["pendente"]);
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
