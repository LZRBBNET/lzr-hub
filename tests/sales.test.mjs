import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSales } from "../lib/platform/sales-service.ts";

const activation = (planName, monthlyValue, activatedAt) => ({ planName, monthlyValue, activatedAt });
const summarize = (rows, options = {}) => summarizeSales(rows, { total: rows.length, truncated: false, activeContracts: 14955, ...options });

test("ticket médio ignora contrato sem valor em vez de contá-lo como zero", () => {
  const result = summarize([
    activation("FIBRA 600MB", 100, "2026-08-01"),
    activation("FIBRA 600MB", 200, "2026-08-01"),
    activation("FIBRA 1,2GB", undefined, "2026-08-02"),
  ]);

  assert.equal(result.withoutValue, 1);
  assert.equal(result.monthlyRecurringAdded, 300);
  assert.equal(result.averageTicket, 150, "média sobre 2 contratos, não sobre 3 — zero puxaria para 100");
});

test("sem nenhum valor legível o ticket médio é nulo, nunca zero", () => {
  const result = summarize([activation("FIBRA", undefined, "2026-08-01")]);
  assert.equal(result.averageTicket, null, "zero seria lido como 'vendemos de graça'");
  assert.equal(result.monthlyRecurringAdded, 0);
});

test("mix de planos vem ordenado por volume e soma o valor de cada um", () => {
  const result = summarize([
    activation("FIBRA 600MB", 100, "2026-08-01"),
    activation("FIBRA 1,2GB", 150, "2026-08-01"),
    activation("FIBRA 600MB", 100, "2026-08-02"),
    activation("FIBRA 600MB", 100, "2026-08-03"),
  ]);
  assert.deepEqual(result.planMix, [
    { plan: "FIBRA 600MB", contracts: 3, value: 300 },
    { plan: "FIBRA 1,2GB", contracts: 1, value: 150 },
  ]);
});

test("plano sem nome não some da conta, vira 'não informado'", () => {
  const result = summarize([activation("   ", 90, "2026-08-01")]);
  assert.equal(result.planMix[0].plan, "Plano não informado");
  assert.equal(result.planMix[0].contracts, 1);
});

test("vendas por dia saem em ordem cronológica e ignoram data ausente", () => {
  const result = summarize([
    activation("A", 10, "2026-08-03"),
    activation("A", 10, "2026-08-01"),
    activation("A", 10, "2026-08-03"),
    activation("A", 10, undefined),
  ]);
  assert.deepEqual(result.byDay, [
    { day: "2026-08-01", contracts: 1 },
    { day: "2026-08-03", contracts: 2 },
  ]);
});

test("leitura truncada declara o total real e quantas foram lidas", () => {
  const result = summarize([activation("A", 10, "2026-08-01")], { total: 262, truncated: true });
  assert.equal(result.activations, 262, "o total vem do IXC");
  assert.equal(result.scanned, 1, "o ticket médio se apoia só no que foi lido");
  assert.equal(result.truncated, true, "quem lê precisa saber que o mix é parcial");
});
