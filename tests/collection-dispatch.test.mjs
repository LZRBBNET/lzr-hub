import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryCollectionDispatchRepository, isBusinessHour, resolveTodayCandidates, runTodayDispatch,
} from "../lib/platform/collection-dispatch-service.ts";

const rule = (steps) => ({ id: "rule-1", name: "Régua padrão", status: "draft", version: 1, authorId: "a", updatedAt: "", steps });
const step = (over = {}) => ({ id: "step-1", offsetDays: 0, channel: "WhatsApp", templateId: "tpl-vencimento", attempts: 1, active: true, ...over });
const invoice = (over = {}) => ({ id: "inv-1", customerId: "cust-1", status: "A", dueAt: "2026-08-10", ...over });

test("horário comercial: dentro do expediente em dia de semana", () => {
  // 06/08/2026 é quinta-feira, 14h em Brasília = 17h UTC.
  assert.equal(isBusinessHour(new Date("2026-08-06T17:00:00Z")), true);
});
test("horário comercial: recusa antes das 8h e depois das 20h de Brasília", () => {
  assert.equal(isBusinessHour(new Date("2026-08-06T08:00:00Z")), false); // 05h em Brasília
  assert.equal(isBusinessHour(new Date("2026-08-06T23:30:00Z")), false); // 20h30 em Brasília
});
test("horário comercial: recusa fim de semana mesmo em horário comercial", () => {
  // 08/08/2026 é sábado.
  assert.equal(isBusinessHour(new Date("2026-08-08T17:00:00Z")), false);
});

test("etapa no dia do vencimento casa quando hoje é a data exata", () => {
  const candidates = resolveTodayCandidates(rule([step({ offsetDays: 0 })]), [invoice()], new Date("2026-08-10T14:00:00Z"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].invoiceId, "inv-1");
  assert.equal(candidates[0].scheduledFor, "2026-08-10");
});

test("etapa antes do vencimento casa 3 dias antes, não em outro dia", () => {
  const etapa = rule([step({ offsetDays: -3 })]);
  assert.equal(resolveTodayCandidates(etapa, [invoice()], new Date("2026-08-07T14:00:00Z")).length, 1);
  assert.equal(resolveTodayCandidates(etapa, [invoice()], new Date("2026-08-08T14:00:00Z")).length, 0);
});

test("fatura paga nunca entra, mesmo na data certa da etapa", () => {
  const candidates = resolveTodayCandidates(rule([step({ offsetDays: 0 })]), [invoice({ status: "P" })], new Date("2026-08-10T14:00:00Z"));
  assert.equal(candidates.length, 0);
});

test("etapa desativada não gera candidato", () => {
  const candidates = resolveTodayCandidates(rule([step({ offsetDays: 0, active: false })]), [invoice()], new Date("2026-08-10T14:00:00Z"));
  assert.equal(candidates.length, 0);
});

test("fatura sem data de vencimento não quebra e não entra", () => {
  const candidates = resolveTodayCandidates(rule([step({ offsetDays: 0 })]), [invoice({ dueAt: undefined })], new Date("2026-08-10T14:00:00Z"));
  assert.equal(candidates.length, 0);
});

test("duas etapas na mesma régua podem casar no mesmo dia para faturas diferentes", () => {
  const etapas = rule([step({ id: "s-antes", offsetDays: -3 }), step({ id: "s-vencimento", offsetDays: 0 })]);
  const faturas = [invoice({ id: "inv-a", dueAt: "2026-08-13" }), invoice({ id: "inv-b", dueAt: "2026-08-10" })];
  const candidates = resolveTodayCandidates(etapas, faturas, new Date("2026-08-10T14:00:00Z"));
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.stepId).sort(), ["s-antes", "s-vencimento"]);
});

test("fora do horário comercial não grava no ledger, só informa quantos candidatos existem", async () => {
  const repository = new MemoryCollectionDispatchRepository();
  const result = await runTodayDispatch(rule([step({ offsetDays: 0 })]), [invoice()], repository, new Date("2026-08-10T08:00:00Z"), "corr-1");
  assert.equal(result.businessHour, false);
  assert.equal(result.candidates, 1);
  assert.equal(result.recorded, 0);
  assert.equal(repository.rows.length, 0);
});

test("dentro do horário comercial grava e enfileira (fila desligada, mas registrado)", async () => {
  const repository = new MemoryCollectionDispatchRepository();
  const result = await runTodayDispatch(rule([step({ offsetDays: 0 })]), [invoice()], repository, new Date("2026-08-10T14:00:00Z"), "corr-1");
  assert.equal(result.businessHour, true);
  assert.equal(result.candidates, 1);
  assert.equal(result.recorded, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(result.queueEnabled, false, "FEATURE_QUEUES está desligada neste teste");
  assert.equal(repository.rows.length, 1);
  assert.equal(repository.rows[0].status, "queued");
});

test("rodar o disparo duas vezes no mesmo dia nunca duplica — zero cobrança repetida", async () => {
  const repository = new MemoryCollectionDispatchRepository();
  const primeira = await runTodayDispatch(rule([step({ offsetDays: 0 })]), [invoice()], repository, new Date("2026-08-10T14:00:00Z"), "corr-1");
  const segunda = await runTodayDispatch(rule([step({ offsetDays: 0 })]), [invoice()], repository, new Date("2026-08-10T15:00:00Z"), "corr-2");
  assert.equal(primeira.recorded, 1);
  assert.equal(segunda.recorded, 0);
  assert.equal(segunda.duplicates, 1);
  assert.equal(repository.rows.length, 1, "só existe uma linha no ledger para esta fatura+etapa+data");
});

test("cliente que pagou entre a primeira e a segunda rodada some da lista", async () => {
  const repository = new MemoryCollectionDispatchRepository();
  const antesDoPagamento = await runTodayDispatch(rule([step({ offsetDays: 0 })]), [invoice({ status: "A" })], repository, new Date("2026-08-10T14:00:00Z"), "corr-1");
  assert.equal(antesDoPagamento.recorded, 1);

  const repository2 = new MemoryCollectionDispatchRepository();
  const depoisDoPagamento = await runTodayDispatch(rule([step({ offsetDays: 0 })]), [invoice({ status: "P" })], repository2, new Date("2026-08-10T16:00:00Z"), "corr-2");
  assert.equal(depoisDoPagamento.recorded, 0);
  assert.equal(depoisDoPagamento.candidates, 0);
});
