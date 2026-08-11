import test from "node:test";
import assert from "node:assert/strict";
import { buildCockpitSnapshot } from "../lib/platform/cockpit-service.ts";

const base = {
  period: "7d",
  since: "2026-08-01T00:00:00.000Z",
  activeContracts: 8500,
  openInvoices: 73870,
  overdueValue: 128900.5,
  support: { conversations: 18, resolutionRate: 0.5, csatAverage: 4.2, csatCount: 6 },
  incidents: [{ status: "investigating", affectedCustomers: 340 }, { status: "resolved", affectedCustomers: 120 }],
  goal: { targetContracts: 260, realizedContracts: 130 },
  audit: [{ id: "a1", action: "billing.rule.save", entity: "collection_rule:1", result: "success", createdAt: "2026-08-06T10:00:00.000Z", actorId: "vinicius@bbnet.dev" }],
};

test("com todas as fontes disponíveis, nada fica degradado", () => {
  const snapshot = buildCockpitSnapshot(base);
  assert.deepEqual(snapshot.degraded, []);
  assert.equal(snapshot.activeCustomers.value, 8500);
  assert.equal(snapshot.conversations.value, 18);
  assert.equal(snapshot.resolutionRate.value, 50);
  assert.equal(snapshot.csat.value, 4.2);
});

test("massiva resolvida não conta como aberta, e os afetados somam só as abertas", () => {
  const snapshot = buildCockpitSnapshot(base);
  assert.equal(snapshot.openIncidents.value, 1);
  assert.equal(snapshot.affectedCustomers.value, 340, "a massiva já resolvida não entra na conta");
});

test("progresso da meta é calculado do realizado real, não estimado", () => {
  const snapshot = buildCockpitSnapshot(base);
  assert.equal(snapshot.goalProgressPercent.value, 50);
  assert.match(snapshot.goalProgressPercent.detail, /130 de 260/);
});

test("IXC fora do ar não zera nada nem derruba o resto do cockpit", () => {
  const snapshot = buildCockpitSnapshot({ ...base, activeContracts: null, openInvoices: null, overdueValue: null });
  assert.equal(snapshot.activeCustomers.value, null, "nunca zero: zero seria lido como 'não há clientes'");
  assert.match(snapshot.activeCustomers.detail, /indisponível/i);
  assert.deepEqual(snapshot.degraded, ["IXC"]);
  assert.equal(snapshot.conversations.value, 18, "as conversas continuam aparecendo");
  assert.equal(snapshot.openIncidents.value, 1);
});

test("o motivo do IXC é repassado: modo allowlist não vira 'indisponível'", () => {
  const snapshot = buildCockpitSnapshot({
    ...base, activeContracts: null, openInvoices: null, overdueValue: null,
    ixcUnavailableReason: "Exige leitura da base inteira (FEATURE_IXC_FULL_BASE)",
  });
  // Sem isto, quem lê o cockpit em ambiente de allowlist procuraria defeito na
  // conexão com o ERP, quando a causa é a trava de escopo.
  assert.match(snapshot.activeCustomers.detail, /base inteira/i);
  assert.match(snapshot.openInvoices.detail, /base inteira/i);
});

test("banco fora do ar deixa conversas e massivas indisponíveis, mas o IXC segue", () => {
  const snapshot = buildCockpitSnapshot({ ...base, support: null, incidents: null, audit: null });
  assert.equal(snapshot.conversations.value, null);
  assert.equal(snapshot.openIncidents.value, null);
  assert.equal(snapshot.activeCustomers.value, 8500, "o IXC não depende do banco");
  assert.deepEqual(snapshot.degraded, ["conversas", "massivas"]);
  assert.deepEqual(snapshot.recentActivity, []);
});

test("custo de IA nasce indisponível e diz que depende do Langfuse", () => {
  const snapshot = buildCockpitSnapshot(base);
  assert.equal(snapshot.aiCost.value, null);
  assert.match(snapshot.aiCost.detail, /Langfuse/);
});

test("sem meta registrada, o progresso não vira zero por cento", () => {
  const snapshot = buildCockpitSnapshot({ ...base, goal: null });
  assert.equal(snapshot.goalProgressPercent.value, null);
  assert.match(snapshot.goalProgressPercent.detail, /Nenhuma meta/);
});

test("meta registrada mas realizado indisponível não inventa progresso", () => {
  const snapshot = buildCockpitSnapshot({ ...base, goal: { targetContracts: 260, realizedContracts: null } });
  assert.equal(snapshot.goalProgressPercent.value, null);
  assert.match(snapshot.goalProgressPercent.detail, /depende do IXC/i);
});

test("meta zerada não divide por zero", () => {
  const snapshot = buildCockpitSnapshot({ ...base, goal: { targetContracts: 0, realizedContracts: 5 } });
  assert.equal(snapshot.goalProgressPercent.value, null);
});

test("sem conversa no período, a taxa de resolução não vira 0%", () => {
  const snapshot = buildCockpitSnapshot({ ...base, support: { conversations: 0, resolutionRate: null, csatAverage: null, csatCount: 0 } });
  assert.equal(snapshot.conversations.value, 0);
  assert.equal(snapshot.resolutionRate.value, null, "0% sugeriria que a IA falhou; a verdade é que não houve conversa");
  assert.equal(snapshot.csat.value, null);
});

test("nenhuma massiva aberta é zero de verdade, não indisponível", () => {
  const snapshot = buildCockpitSnapshot({ ...base, incidents: [] });
  assert.equal(snapshot.openIncidents.value, 0);
  assert.equal(snapshot.affectedCustomers.value, 0, "zero aqui é medido, não ausência de fonte");
});
