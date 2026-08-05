import test from "node:test";
import assert from "node:assert/strict";
import { daysOverdue, isOpenInvoice, summarizeBilling } from "../lib/platform/billing-service.ts";
import { MemoryCollectionRulesRepository, RuleValidationError, parseRuleInput } from "../lib/platform/collection-rules-service.ts";

const NOW = new Date("2026-08-04T15:00:00.000Z");
const snapshot = (invoices, payments = []) => ({
  customer: { id: "1", name: "x", document: "", phone: "", email: "", city: "", neighborhood: "", address: "", status: "A" },
  contracts: [], plan: null, invoices, payments, serviceOrders: [], connection: null,
  partialSources: [], metrics: { totalLatencyMs: 0, blockLatencies: {} },
  fetchedAt: NOW.toISOString(), mode: "staging-readonly", cache: "miss",
});
const invoice = (id, status, dueAt, value) => ({ id, customerId: "1", status, dueAt, value });
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
  const valid = { name: "Régua BBNET", steps: [{ offsetDays: 3, channel: "WhatsApp", templateId: "t1", attempts: 1 }] };
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

  const first = await repository.saveVersion({ name: "v1", steps: [{ offsetDays: 1, channel: "SMS", templateId: "t", attempts: 1, active: true }] }, "vini@bbnet");
  const second = await repository.saveVersion({ name: "v2", steps: [{ offsetDays: 5, channel: "WhatsApp", templateId: "t2", attempts: 2, active: true }] }, "vini@bbnet");

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal((await repository.getLatest()).name, "v2");
  assert.equal(repository.versions.length, 2, "a versão anterior continua registrada");
});

test("base inteira: contagem exata, soma só do que foi lido, e nada estimado", async () => {
  const { summarizeFullBase } = await import("../lib/platform/billing-service.ts");
  const result = summarizeFullBase([
    { status:"A", dueAt:"2026-08-01", value:100 },  // 3 dias
    { status:"A", dueAt:"2026-07-25", value:200 },  // 10 dias
    { status:"A", dueAt:"", value:70 },             // sem data legível
  ], { now: NOW, overdueTotal: 3541, openCount: 73870, truncated: true });

  assert.equal(result.openInvoices, 73870, "contagem vem do IXC, não da varredura");
  assert.equal(result.openValue, null, "somar 74 mil faturas por acesso não é viável — melhor dizer que não somamos");
  assert.equal(result.overdueInvoices, 3541, "quantas existem");
  assert.equal(result.overdueScanned, 3, "quantas foram lidas de fato");
  assert.equal(result.overdueValue, 300, "só soma o que leu, e a fatura sem data não entra");
  assert.equal(result.invoicesWithoutDueDate, 1);
  assert.equal(result.truncated, true, "quem lê precisa saber que o valor é parcial");
  assert.deepEqual(result.aging.map((b) => [b.label, b.invoices]), [
    ["1–5 dias", 1], ["6–15 dias", 1], ["16–30 dias", 0], ["31+ dias", 0],
  ]);
});

test("fatura cancelada não conta como dívida do cliente", () => {
  // O IXC usa "C" para cancelada e há 557 mil delas na base. A regra anterior
  // era lista negra e deixava todas passarem como se fossem dívida em aberto.
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
