import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryIxcWriteOperationsRepository, assertReissuePolicy, requestInvoiceReissue,
  IxcWritePolicyError,
} from "../lib/platform/ixc-write-service.ts";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const request = (over = {}) => ({
  invoiceId: "inv-1", customerId: "cust-1", idempotencyKey: "key-1", correlationId: "corr-1",
  requestedBy: "vinicius@bbnet.dev", invoice: { status: "A" }, ...over,
});
const fakeIxcCall = async () => ({ raw: { linha_digitavel: "00190.00009 03384.318402", arquivo: "base64-exemplo" } });

test("política recusa fatura que não está aberta", () => {
  assert.throws(() => assertReissuePolicy({ status: "P" }, null, NOW), IxcWritePolicyError);
});

test("política recusa segunda via repetida dentro de 24h", () => {
  const doze_horas_atras = new Date(NOW.getTime() - 12 * 3_600_000).toISOString();
  assert.throws(() => assertReissuePolicy({ status: "A" }, doze_horas_atras, NOW), IxcWritePolicyError);
});

test("política aceita depois de 24h da última segunda via", () => {
  const vinte_cinco_horas_atras = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
  assert.doesNotThrow(() => assertReissuePolicy({ status: "A" }, vinte_cinco_horas_atras, NOW));
});

test("sem FEATURE_IXC_WRITE, a operação fica bloqueada e nunca chama o IXC", async () => {
  delete process.env.FEATURE_IXC_WRITE;
  const repository = new MemoryIxcWriteOperationsRepository();
  let called = false;
  const result = await requestInvoiceReissue(request(), repository, async () => { called = true; return fakeIxcCall(); });
  assert.equal(result.status, "blocked");
  assert.equal(called, false, "a fila de segurança bloqueou antes de qualquer chamada externa");
  assert.equal(repository.rows.length, 1);
  assert.equal(repository.rows[0].status, "blocked");
});

test("fatura fora de política também nunca chega a checar a flag ou chamar o IXC", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  let called = false;
  const result = await requestInvoiceReissue(request({ invoice: { status: "P" } }), repository, async () => { called = true; return fakeIxcCall(); });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /aberta/);
  assert.equal(called, false);
  delete process.env.FEATURE_IXC_WRITE;
});

test("mesma idempotencyKey duas vezes: a segunda é replay, não dispara o IXC de novo", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamadas = 0;
  const callIxc = async () => { chamadas += 1; return fakeIxcCall(); };
  const primeira = await requestInvoiceReissue(request(), repository, callIxc);
  const segunda = await requestInvoiceReissue(request(), repository, callIxc);
  assert.equal(primeira.status, "success");
  assert.equal(segunda.status, "success");
  assert.equal(segunda.replay, true);
  assert.equal(chamadas, 1, "reenviar a mesma chave não deve chamar o IXC de novo");
  assert.equal(repository.rows.length, 1);
  delete process.env.FEATURE_IXC_WRITE;
});

test("quando o IXC falha, o resultado é 'failed' e fica registrado — não derruba a chamada", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestInvoiceReissue(request(), repository, async () => { throw new Error("IXC_TIMEOUT"); });
  assert.equal(result.status, "failed");
  assert.equal(result.detail, "IXC_TIMEOUT");
  assert.equal(repository.rows[0].status, "failed");
  delete process.env.FEATURE_IXC_WRITE;
});

test("sucesso guarda a resposta crua do IXC no resultado e no ledger, sem inventar campos", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestInvoiceReissue(request(), repository, fakeIxcCall);
  assert.equal(result.status, "success");
  assert.deepEqual(result.raw, { linha_digitavel: "00190.00009 03384.318402", arquivo: "base64-exemplo" });
  assert.match(repository.rows[0].detail, /linha_digitavel/);
  delete process.env.FEATURE_IXC_WRITE;
});
