import test from "node:test";
import assert from "node:assert/strict";
import {
  GoalValidationError, MemorySalesGoalsRepository, MAX_TARGET_CONTRACTS,
  currentPeriod, goalProgress, parseGoalInput, periodRange,
} from "../lib/platform/sales-goals-service.ts";
import { summarizeSales } from "../lib/platform/sales-service.ts";

const goal = (over = {}) => ({
  id: "g1", period: "2026-08", targetContracts: 250, targetRevenue: null,
  note: null, createdBy: "alguem@bbnet.dev", updatedAt: "2026-08-01T00:00:00.000Z", ...over,
});

test("competência precisa ser AAAA-MM válida", () => {
  for (const period of ["2026-13", "2026-00", "26-08", "2026/08", "agosto", ""]) {
    assert.throws(() => parseGoalInput({ period, targetContracts: 10 }), GoalValidationError, `aceitou "${period}"`);
  }
  assert.equal(parseGoalInput({ period: "2026-08", targetContracts: 10 }).period, "2026-08");
});

test("meta de contratos precisa ser inteiro positivo e dentro do teto", () => {
  for (const target of [0, -5, 1.5, "abc", null]) {
    assert.throws(() => parseGoalInput({ period: "2026-08", targetContracts: target }), GoalValidationError, `aceitou ${target}`);
  }
  assert.throws(() => parseGoalInput({ period: "2026-08", targetContracts: MAX_TARGET_CONTRACTS + 1 }), GoalValidationError);
  assert.equal(parseGoalInput({ period: "2026-08", targetContracts: 250 }).targetContracts, 250);
});

test("receita em branco significa sem meta de receita, não zero", () => {
  assert.equal(parseGoalInput({ period: "2026-08", targetContracts: 10 }).targetRevenue, null);
  assert.equal(parseGoalInput({ period: "2026-08", targetContracts: 10, targetRevenue: "" }).targetRevenue, null);
  // Zero explícito é uma escolha de quem digitou e continua valendo zero.
  assert.equal(parseGoalInput({ period: "2026-08", targetContracts: 10, targetRevenue: "0" }).targetRevenue, 0);
  assert.equal(parseGoalInput({ period: "2026-08", targetContracts: 10, targetRevenue: "1234,50" }).targetRevenue, 1234.5);
  assert.throws(() => parseGoalInput({ period: "2026-08", targetContracts: 10, targetRevenue: "-1" }), GoalValidationError);
});

test("guardar e reler a meta preserva os valores", async () => {
  const repository = new MemorySalesGoalsRepository();
  await repository.upsert(parseGoalInput({ period: "2026-08", targetContracts: 250, targetRevenue: "18000,00" }), "eu@bbnet.dev");
  const saved = await repository.findByPeriod("2026-08");
  assert.equal(saved.targetContracts, 250);
  assert.equal(saved.targetRevenue, 18000);

  // Regravar a mesma competência atualiza, não duplica.
  await repository.upsert(parseGoalInput({ period: "2026-08", targetContracts: 300 }), "outro@bbnet.dev");
  assert.equal((await repository.list(10)).length, 1);
  const atualizada = await repository.findByPeriod("2026-08");
  assert.equal(atualizada.targetContracts, 300);
  assert.equal(atualizada.createdBy, "eu@bbnet.dev", "quem criou continua sendo quem criou");
});

test("progresso compara realizado com a meta", () => {
  const meio = new Date("2026-08-15T12:00:00Z"); // 15 de 31 dias
  const progress = goalProgress(goal(), 100, null, meio);
  assert.equal(progress.contractsPercent, 100 / 250);
  assert.ok(progress.elapsed > 0.48 && progress.elapsed < 0.49);
  // 100 em ~48% do mês projeta ~207, abaixo dos 250.
  assert.equal(progress.projectedContracts, 207);
  assert.equal(progress.behind, true);

  const bom = goalProgress(goal(), 130, null, meio);
  assert.equal(bom.behind, false, "130 na metade do mês projeta acima de 250");
});

test("mês fechado não é projetado", () => {
  const depois = new Date("2026-09-10T00:00:00Z");
  const progress = goalProgress(goal({ period: "2026-08" }), 240, null, depois);
  assert.equal(progress.projectedContracts, null, "projetar mês fechado seria inventar futuro para um passado conhecido");
  assert.equal(progress.elapsed, 1);
  assert.equal(progress.behind, true, "240 de 250 não bateu");
});

test("mês futuro não conta como atrasado por falta de venda", () => {
  const antes = new Date("2026-07-20T00:00:00Z");
  const progress = goalProgress(goal({ period: "2026-09" }), 0, null, antes);
  assert.equal(progress.elapsed, 0);
  assert.equal(progress.projectedContracts, null);
});

test("meta de receita só é comparada quando existe dos dois lados", () => {
  const meio = new Date("2026-08-15T12:00:00Z");
  assert.equal(goalProgress(goal(), 100, 9000, meio).revenuePercent, null, "sem meta de receita não há percentual");
  assert.equal(goalProgress(goal({ targetRevenue: 18000 }), 100, 9000, meio).revenuePercent, 0.5);
  assert.equal(goalProgress(goal({ targetRevenue: 18000 }), 100, null, meio).revenuePercent, null, "sem realizado não se inventa");
});

test("faixa da competência cobre o mês inteiro, inclusive fevereiro bissexto", () => {
  assert.deepEqual(periodRange("2026-08"), { since: "2026-08-01", until: "2026-08-31" });
  assert.deepEqual(periodRange("2026-02"), { since: "2026-02-01", until: "2026-02-28" });
  assert.deepEqual(periodRange("2028-02"), { since: "2028-02-01", until: "2028-02-29" });
});

test("competência corrente usa o fuso de São Paulo, não UTC", () => {
  // 01/09 às 00:30 UTC ainda é 31/08 em São Paulo: a competência é agosto.
  assert.equal(currentPeriod(new Date("2026-09-01T00:30:00Z")), "2026-08");
  assert.equal(currentPeriod(new Date("2026-09-01T12:00:00Z")), "2026-09");
});

test("venda que já cancelou continua contando como venda do período", () => {
  const summary = summarizeSales([
    { planName: "Fibra 500", monthlyValue: 99.9, activatedAt: "2026-06-03", status: "A" },
    { planName: "Fibra 500", monthlyValue: 99.9, activatedAt: "2026-06-11", status: "I" },
    { planName: "Fibra 300", monthlyValue: 79.9, activatedAt: "2026-06-20", status: "A" },
  ], { total: 3, truncated: false, activeContracts: 100 });

  assert.equal(summary.activations, 3, "as três foram vendidas no mês");
  assert.equal(summary.alreadyCancelled, 1, "uma já saiu, e isso é dito à parte");
  // A receita somada inclui a cancelada: ela entrou na receita do mês em que foi vendida.
  assert.equal(Math.round(summary.monthlyRecurringAdded * 100) / 100, 279.7);
});
