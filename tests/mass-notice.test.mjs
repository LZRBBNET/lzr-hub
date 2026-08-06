import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryMassNoticeRepository, matchesArea, resolveAffectedCustomers, runNoticeDispatch,
} from "../lib/platform/mass-notice-service.ts";

const incident = (over = {}) => ({ id: "inc-1", city: "Itabaiana", neighborhood: "Centro", severity: "high", ...over });
const customer = (over = {}) => ({ customerId: "cust-1", city: "Itabaiana", neighborhood: "Centro", ...over });

test("bate cidade e bairro ignorando maiúscula e acento", () => {
  assert.equal(matchesArea(incident(), customer({ city: "ITABAIANA", neighborhood: "centro" })), true);
  assert.equal(matchesArea(incident({ city: "São Paulo" }), customer({ city: "sao paulo" })), true);
});

test("bairro diferente não bate mesmo na mesma cidade", () => {
  assert.equal(matchesArea(incident(), customer({ neighborhood: "Bairro Industrial" })), false);
});

test("cadastro sem cidade ou bairro nunca bate, mesmo com string vazia dos dois lados", () => {
  assert.equal(matchesArea(incident({ city: "", neighborhood: "" }), customer({ city: "", neighborhood: "" })), false);
});

test("resolveAffectedCustomers filtra só quem está na área, preservando outros clientes", () => {
  const customers = [customer({ customerId: "a" }), customer({ customerId: "b", neighborhood: "Outro bairro" }), customer({ customerId: "c" })];
  assert.deepEqual(resolveAffectedCustomers(incident(), customers).sort(), ["a", "c"]);
});

test("disparo de abertura registra cada cliente afetado uma vez", async () => {
  const repository = new MemoryMassNoticeRepository();
  const customers = [customer({ customerId: "a" }), customer({ customerId: "b" })];
  const result = await runNoticeDispatch(incident(), "opened", customers, repository, "corr-1");
  assert.equal(result.matched, 2);
  assert.equal(result.recorded, 2);
  assert.equal(result.duplicates, 0);
  assert.equal(result.queueEnabled, false, "FEATURE_QUEUES está desligada neste teste");
  assert.equal(repository.rows.length, 2);
});

test("rodar o mesmo aviso duas vezes não duplica — ninguém recebe o aviso repetido", async () => {
  const repository = new MemoryMassNoticeRepository();
  const customers = [customer({ customerId: "a" })];
  const primeira = await runNoticeDispatch(incident(), "opened", customers, repository, "corr-1");
  const segunda = await runNoticeDispatch(incident(), "opened", customers, repository, "corr-2");
  assert.equal(primeira.recorded, 1);
  assert.equal(segunda.recorded, 0);
  assert.equal(segunda.duplicates, 1);
  assert.equal(repository.rows.length, 1);
});

test("aviso de abertura e de normalização são registros distintos para o mesmo cliente", async () => {
  const repository = new MemoryMassNoticeRepository();
  const customers = [customer({ customerId: "a" })];
  await runNoticeDispatch(incident(), "opened", customers, repository, "corr-1");
  const fechamento = await runNoticeDispatch(incident(), "closed", customers, repository, "corr-2");
  assert.equal(fechamento.recorded, 1, "normalização não é bloqueada pelo aviso de abertura já registrado");
  assert.equal(repository.rows.length, 2);
  assert.deepEqual(repository.rows.map((r) => r.kind).sort(), ["closed", "opened"]);
});

test("cliente que sai da área entre duas rodadas não recebe o segundo aviso", async () => {
  const repository = new MemoryMassNoticeRepository();
  const primeira = await runNoticeDispatch(incident(), "opened", [customer({ customerId: "a" })], repository, "corr-1");
  assert.equal(primeira.matched, 1);
  const semNinguemNaArea = await runNoticeDispatch(incident(), "closed", [customer({ customerId: "a", neighborhood: "Outro bairro" })], repository, "corr-2");
  assert.equal(semNinguemNaArea.matched, 0);
  assert.equal(semNinguemNaArea.recorded, 0);
});
