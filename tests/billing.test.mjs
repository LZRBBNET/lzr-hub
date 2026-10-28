import test from "node:test";
import assert from "node:assert/strict";
import { daysOverdue, isOpenInvoice, summarizeBilling, summarizeFullBase } from "../lib/platform/billing-service.ts";
import { MemoryCollectionRulesRepository, RuleValidationError, parseRuleInput } from "../lib/platform/collection-rules-service.ts";

const NOW = new Date("2026-08-04T15:00:00.000Z");
const snapshot = (invoices, payments = []) => ({
  customer: { id: "1", name: "Cliente sintético", document: "", phone: "", email: "", city: "", neighborhood: "", address: "", status: "A" },
  contracts: [], plan: null, invoices, payments, serviceOrders: [], connection: null,
  coverage: { invoices: { read: invoices.length, total: invoices.length, complete: true, limit: 20 }, payments: { read: payments.length, total: payments.length, complete: true, limit: 100 } },
  partialSources: [], metrics: { totalLatencyMs: 0, blockLatencies: {} },
  fetchedAt: NOW.toISOString(), mode: "staging-readonly", cache: "miss",
});
const invoice = (id, status, dueAt, value) => ({ id, customerId: "1", status, dueAt, value, valueSource: "open-balance" });
const summarize = (snapshots, unavailable = 0) => summarizeBilling(snapshots, { now: NOW, unavailable, paymentsSinceIso: "2026-07-05T00:00:00.000Z" });

test("fatura recebida ou paga não conta como em aberto", () => {
  assert.equal(isOpenInvoice("A"), true, "aberta");
  assert.equal(isOpenInvoice("R"), false, "recebida");
  assert.equal(isOpenInvoice("P"), false, "paga");
  assert.equal(isOpenInvoice("pago"), false);
  assert.equal(isOpenInvoice("cancelada"), false);
});

test("dias de atraso vêm da data real, e data ilegível não vira zero", () => {
  assert.equal(daysOverdue("2026-08-01", NOW), 3);
  assert.equal(daysOverdue("2026-08-04", NOW), 0, "vence hoje: não está atrasada");
  assert.equal(daysOverdue("2026-08-10", NOW), -6, "ainda vai vencer");
  assert.equal(daysOverdue(undefined, NOW), undefined);
  assert.equal(daysOverdue("data errada", NOW), undefined, "melhor não saber do que inventar 0 dias");
});

test("separa vencido de a vencer e distribui nas faixas certas", () => {
  const result = summarize([snapshot([
    invoice("1", "A", "2026-08-01", 100),   // 3 dias -> 1-5
    invoice("2", "A", "2026-07-25", 200),   // 10 dias -> 6-15
    invoice("3", "A", "2026-07-10", 300),   // 25 dias -> 16-30
    invoice("4", "A", "2026-05-01", 400),   // 95 dias -> 31+
    invoice("5", "A", "2026-08-20", 500),   // ainda vai vencer
    invoice("6", "R", "2026-06-01", 999),   // recebida: fora de tudo
  ])]);

  assert.equal(result.openInvoices, 5, "a recebida não entra");
  assert.equal(result.overdueInvoices, 4);
  assert.equal(result.overdueValue, 1000);
  assert.equal(result.upcomingInvoices, 1);
  assert.equal(result.upcomingValue, 500);
  assert.deepEqual(result.aging.map((b) => [b.label, b.invoices, b.value]), [
    ["1–5 dias", 1, 100], ["6–15 dias", 1, 200], ["16–30 dias", 1, 300], ["31+ dias", 1, 400],
  ]);
});

test("fatura sem data de vencimento é contada à parte, nunca jogada numa faixa", () => {
  const result = summarize([snapshot([invoice("1", "A", undefined, 150)])]);
  assert.equal(result.invoicesWithoutDueDate, 1);
  assert.equal(result.overdueInvoices, 0, "não dá para afirmar que está vencida");
  assert.equal(result.upcomingInvoices, 0, "nem que está no prazo");
  assert.equal(result.aging.every((bucket) => bucket.invoices === 0), true);
});

test("pagamentos fora do período não entram na conta do período", () => {
  const result = summarize([snapshot([], [
    { id: "p1", customerId: "1", paidAt: "2026-07-20", value: 100, method: "PIX" },
    { id: "p2", customerId: "1", paidAt: "2026-07-21", value: 50, method: "PIX" },
    { id: "p3", customerId: "1", paidAt: "2026-01-02", value: 900, method: "Boleto" },
  ])]);
  assert.equal(result.paymentsInPeriod, 2);
  assert.equal(result.paidInPeriod, 150);
  assert.deepEqual(result.paymentMethods, { PIX: 2 });
});

test("cadastro que não respondeu é declarado, não silenciado", () => {
  const result = summarize([snapshot([invoice("1", "A", "2026-08-01", 100)])], 2);
  assert.equal(result.customersConsulted, 1);
  assert.equal(result.customersUnavailable, 2, "quem lê precisa saber que a conta está incompleta");
});

test("régua recusa etapa inválida antes de gravar", () => {
  const valid = { name: "Régua sintética", steps: [{ offsetDays: 3, channel: "WhatsApp", templateId: "t1", attempts: 1 }] };
  assert.equal(parseRuleInput(valid).steps[0].active, true, "etapa nasce ativa a menos que digam o contrário");

  assert.throws(() => parseRuleInput({ ...valid, name: "ab" }), RuleValidationError);
  assert.throws(() => parseRuleInput({ ...valid, steps: [] }), RuleValidationError);
  assert.throws(() => parseRuleInput({ ...valid, steps: [{ offsetDays: 999, channel: "WhatsApp", templateId: "t", attempts: 1 }] }), RuleValidationError);
  assert.throws(() => parseRuleInput({ ...valid, steps: [{ offsetDays: 1, channel: "Pombo-correio", templateId: "t", attempts: 1 }] }), RuleValidationError);
  assert.throws(() => parseRuleInput({ ...valid, steps: [{ offsetDays: 1, channel: "SMS", templateId: "", attempts: 1 }] }), RuleValidationError);
  assert.throws(() => parseRuleInput({ ...valid, steps: [{ offsetDays: 1, channel: "SMS", templateId: "t", attempts: 9 }] }), RuleValidationError);
});

test("salvar a régua cria versão nova em vez de sobrescrever a anterior", async () => {
  const repository = new MemoryCollectionRulesRepository();
  assert.equal(await repository.getLatest(), undefined, "começa vazia, sem régua de exemplo");

  const first = await repository.saveVersion({ name: "v1", steps: [{ offsetDays: 1, channel: "SMS", templateId: "t", attempts: 1, active: true }] }, "operator@fixture.invalid");
  const second = await repository.saveVersion({ name: "v2", steps: [{ offsetDays: 5, channel: "WhatsApp", templateId: "t2", attempts: 2, active: true }] }, "operator@fixture.invalid");

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal((await repository.getLatest()).name, "v2");
  assert.equal(repository.versions.length, 2, "a versão anterior continua registrada");
});

test("base inteira: contagem exata, soma só do que foi lido, e nada estimado", async () => {
  const { summarizeFullBase } = await import("../lib/platform/billing-service.ts");
  const result = summarizeFullBase([
    invoice("1", "A", "2026-08-01", 100),  // 3 dias
    invoice("2", "A", "2026-07-25", 200),  // 10 dias
    invoice("3", "A", "", 70),             // sem data legível
  ], { now: NOW, overdueTotal: 9, openCount: 20, truncated: true });

  assert.equal(result.openInvoices, 20, "contagem vem do IXC, não da varredura");
  assert.equal(result.openValue, null, "a soma de toda a base não foi consultada");
  assert.equal(result.overdueInvoices, 9, "quantas existem");
  assert.equal(result.overdueScanned, 3, "quantas foram lidas de fato");
  assert.equal(result.overdueValue, 300, "só soma o que leu, e a fatura sem data não entra");
  assert.equal(result.invoicesWithoutDueDate, 1);
  assert.equal(result.truncated, true, "quem lê precisa saber que o valor é parcial");
  assert.deepEqual(result.aging.map((b) => [b.label, b.invoices]), [
    ["1–5 dias", 1], ["6–15 dias", 1], ["16–30 dias", 0], ["31+ dias", 0],
  ]);
});

test("fatura cancelada não conta como dívida do cliente", () => {
  // Cancelamentos e estados desconhecidos nunca comprovam dívida aberta.
  assert.equal(isOpenInvoice("C"), false, "cancelada não é dívida");
  assert.equal(isOpenInvoice("A"), true);
  assert.equal(isOpenInvoice("R"), false);
  assert.equal(isOpenInvoice("X"), false, "código desconhecido erra para menos: melhor não cobrar do que cobrar errado");
  assert.equal(isOpenInvoice("Em aberto"), true, "status por extenso continua funcionando");
  assert.equal(isOpenInvoice("cancelada"), false);
});

test("o dia de referência é o do Brasil, não o do servidor em UTC", async () => {
  const { businessToday } = await import("../lib/platform/billing-service.ts");
  // 04/08 às 23h de Brasília já é 05/08 em UTC. Sem fuso explícito, toda fatura
  // ganhava um dia de atraso à noite e podia mudar de faixa.
  const noiteDeBrasilia = new Date("2026-08-05T02:00:00.000Z");
  assert.equal(businessToday(noiteDeBrasilia), "2026-08-04");
  assert.equal(daysOverdue("2026-08-04", noiteDeBrasilia), 0, "vence hoje continua sendo hoje às 23h");
});

const full = (rows, extra = {}) => summarizeFullBase(rows, { now: NOW, overdueTotal: rows.length, openCount: rows.length, truncated: false, ...extra });

test("saldo aberto usa origem confirmada; valor nominal nunca substitui saldo desconhecido", () => {
  const known = invoice("1", "A", "2026-08-01", 20);
  const nominal = { ...invoice("2", "A", "2026-08-01", 100), valueSource: "face-value" };
  for (const result of [full([known, nominal]), summarize([snapshot([known, nominal])])]) {
    assert.equal(result.overdueValue, 20);
    assert.equal(result.amountIncomplete, true);
    assert.equal(result.excludedInvoices, 1);
    assert.equal(result.aging[0].value, 20);
  }
  assert.equal(full([nominal]).overdueValue, null);
  assert.equal(summarize([snapshot([nominal])]).openValue, null);
});

test("saldo zero confirmado continua zero mesmo ao lado de informação incompleta", () => {
  const zero = invoice("1", "A", "2026-08-01", 0);
  const unknown = { ...invoice("2", "A", "2026-08-01", 100), valueSource: undefined };
  for (const result of [full([zero]), full([zero, unknown]), summarize([snapshot([zero, unknown])])]) {
    assert.equal(result.overdueValue, 0);
    assert.equal(result.aging[0].value, 0);
  }
  assert.equal(full([]).overdueValue, 0, "empty and complete is genuinely zero");
  assert.equal(summarize([snapshot([])]).openValue, 0);
});

test("valor ausente, null, não numérico, negativo, NaN, infinito ou fora da precisão não vira zero", () => {
  for (const value of [undefined, null, "20", NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const row = invoice("1", "A", "2026-08-01", value);
    for (const result of [full([row]), summarize([snapshot([row])])]) {
      assert.equal(result.overdueValue, null, String(value));
      assert.equal(result.amountIncomplete, true);
      assert.equal(result.excludedInvoices, 1);
    }
  }
});

test("soma em centavos não propaga erro decimal nem ultrapassa precisão segura", () => {
  assert.equal(full([invoice("1", "A", "2026-08-01", 0.1), invoice("2", "A", "2026-08-01", 0.2)]).overdueValue, 0.3);
  const huge = invoice("1", "A", "2026-08-01", 90_000_000_000_000);
  const result = full([huge, { ...huge, id: "2" }]);
  assert.equal(Number.isFinite(result.overdueValue), true);
  assert.equal(result.amountIncomplete, true);
  assert.equal(result.excludedInvoices, 1);
});

test("estado desconhecido e data impossível não viram dívida vencida", () => {
  assert.equal(isOpenInvoice("desconhecido"), false);
  assert.equal(isOpenInvoice(""), false);
  assert.equal(isOpenInvoice("aguardando"), false);
  for (const date of ["2026-02-31", "2026-02-29", "2026-13-01", "2026-08-01extra", "2026-08-01T00:00:00Z"]) assert.equal(daysOverdue(date, NOW), undefined);
  assert.equal(daysOverdue("2024-02-29", new Date("2024-03-01T12:00:00Z")), 1);
  const rows = [invoice("1", "desconhecido", "2026-08-01", 100), invoice("2", "A", "2026-02-31", 100)];
  for (const result of [full(rows), summarize([snapshot(rows)])]) {
    assert.equal(result.overdueValue, null);
    assert.equal(result.excludedInvoices, 2);
    assert.equal(result.invoicesWithoutDueDate, 1);
  }
  assert.equal(full([invoice("1", "A", "2026-08-05", 100)]).overdueValue, null, "future invoice cannot enter overdue scan");
  assert.equal(full([invoice("1", "R", "2026-08-01", 100)]).overdueValue, null);
});

test("duplicatas, identidades vazias e cliente divergente não são somados", () => {
  const row = invoice("1", "A", "2026-08-01", 20);
  assert.equal(full([row, row]).overdueValue, null);
  assert.equal(full([{ ...row, id: "" }]).excludedInvoices, 1);
  const result = summarize([snapshot([row, row, { ...row, id: "2", customerId: "outro-sintetico" }])]);
  assert.equal(result.openValue, null);
  assert.equal(result.openInvoices, 0);
  assert.equal(result.excludedInvoices, 3);
});

test("snapshot incompleto, fonte que falhou e metadados ausentes não afirmam saldo ou recebimento zero", () => {
  for (const mutate of [
    (data) => { delete data.coverage; },
    (data) => { data.partialSources = ["invoices", "payments"]; },
    (data) => { data.coverage.invoices.complete = false; data.coverage.payments.complete = false; },
    (data) => { data.coverage.invoices.total = 1; data.coverage.payments.read = 1; },
  ]) {
    const data = snapshot([]); mutate(data);
    const result = summarize([data]);
    assert.equal(result.openValue, null);
    assert.equal(result.overdueValue, null);
    assert.equal(result.upcomingValue, null);
    assert.equal(result.paidInPeriod, null);
    assert.equal(result.amountIncomplete, true);
    assert.equal(result.paymentsIncomplete, true);
    assert.equal(result.aging.every((bucket) => bucket.value === null), true);
  }
  assert.equal(full([], { overdueTotal: 2, truncated: true }).overdueValue, null);
  assert.equal(full([], { overdueTotal: 2 }).amountIncomplete, true, "reported count mismatch is partial even if source forgot truncated");
});

const CLOCK = new Date("2026-10-28T12:00:00Z");
const payment = (id, paidAt, value = 10) => ({ id, customerId: "1", paidAt, value, method: "PIX" });
const payments = (rows, options = {}) => summarizeBilling([snapshot([], rows)], { now: CLOCK, unavailable: 0, paymentsSinceIso: "2026-10-27T12:00:00Z", ...options });

test("janela 24h usa instantes inclusivos: 23:59, 24:00 e 24:00:01, nunca o dia inteiro", () => {
  const result = payments([
    payment("p1", "2026-10-27T12:01:00Z", 1),
    payment("p2", "2026-10-27T12:00:00Z", 2),
    payment("p3", "2026-10-27T11:59:59Z", 4),
    payment("p4", "2026-10-27T01:00:00Z", 8),
    payment("p5", "2026-10-28T12:00:00Z", 16),
  ]);
  assert.equal(result.paymentsInPeriod, 3);
  assert.equal(result.paidInPeriod, 19);
  assert.equal(result.paymentsIncomplete, false);
});

test("offset explícito e meia-noite de Brasília preservam o intervalo real", () => {
  const result = payments([
    payment("p1", "2026-10-27T09:00:00-03:00", 1),
    payment("p2", "2026-10-27T08:59:59-03:00", 2),
  ]);
  assert.equal(result.paidInPeriod, 1);
  const atNight = payments([
    payment("p3", "2026-10-27T22:59:59-03:00", 4),
    payment("p4", "2026-10-27T23:00:01-03:00", 8),
  ], { now: new Date("2026-10-28T02:00:00Z"), paymentsSinceIso: "2026-10-27T02:00:00Z" });
  assert.equal(atNight.paidInPeriod, 4);
  assert.equal(atNight.excludedPayments, 1, "future receipt is not confirmed");
});

test("data sem hora/fuso nas bordas é desconhecida, não um horário inventado", () => {
  for (const raw of ["2026-10-27", "2026-10-28", "2026-10-27 18:00:00", "2026-10-28T09:00:00"]) {
    const result = payments([payment("p1", raw)]);
    assert.equal(result.paidInPeriod, null, raw);
    assert.equal(result.paymentsInPeriod, 0);
    assert.equal(result.paymentsIncomplete, true);
    assert.equal(result.excludedPayments, 1);
  }
  const interior = payments([payment("p1", "2026-10-25"), payment("p2", "2026-10-26 09:00:00")], { paymentsSinceIso: "2026-10-21T12:00:00Z" });
  assert.equal(interior.paidInPeriod, 20);
  assert.equal(interior.paymentsIncomplete, false, "whole interior calendar days are safely in a multi-day window");
});

test("datas futuras, inexistentes, ausentes e horas/offsets inválidos não são recebimento", () => {
  for (const raw of [undefined, "", "2026-10-29", "2026-10-28T12:00:01Z", "2026-02-31T12:00:00Z", "2026-10-27T24:00:00Z", "2026-10-27T12:60:00Z", "2026-10-27T12:00:60Z", "2026-10-27T12:00:00+25:00", "inválida"]) {
    const result = payments([payment("p1", raw)]);
    assert.equal(result.paidInPeriod, null, String(raw));
    assert.equal(result.paymentsInPeriod, 0);
    assert.equal(result.excludedPayments, 1);
  }
});

test("recebimento com valor desconhecido permanece parcial; zero confirmado permanece zero", () => {
  for (const value of [undefined, null, NaN, Infinity, -1, "10", Number.MAX_SAFE_INTEGER]) {
    const result = payments([{ ...payment("p1", "2026-10-28T10:00:00Z"), value }]);
    assert.equal(result.paymentsInPeriod, 1, "the occurrence is dated, not its unknown amount");
    assert.equal(result.paidInPeriod, null);
    assert.equal(result.paymentsIncomplete, true);
  }
  const zero = payments([payment("p1", "2026-10-28T10:00:00Z", 0), payment("p2", "2026-10-29", 10)]);
  assert.equal(zero.paidInPeriod, 0);
  assert.equal(zero.paymentsIncomplete, true);
  assert.equal(payments([]).paidInPeriod, 0);
});

test("recebimentos duplicados ou de outro cliente são excluídos com aviso", () => {
  const row = payment("p1", "2026-10-28T10:00:00Z");
  const result = payments([row, row, { ...row, id: "p2", customerId: "outro-sintetico" }]);
  assert.equal(result.paidInPeriod, null);
  assert.equal(result.paymentsInPeriod, 0);
  assert.equal(result.excludedPayments, 3);
});
