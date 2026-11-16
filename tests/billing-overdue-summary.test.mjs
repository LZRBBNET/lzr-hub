import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFullBase } from "../lib/platform/billing-service.ts";
const now = new Date("2026-08-05T02:00:00Z"); // Ainda 04/08 em Brasília.
const options = { now, overdueTotal: 99, openCount: 120, truncated: true };
for (const status of ["R", "P", "C", "X", "", "desconhecido", "cancelada"]) {
  test(`resumo ignora status sem abertura comprovada: ${JSON.stringify(status)}`, () => {
    const result = summarizeFullBase([{ status, dueAt: "2026-08-01", value: 900 }], options);
    assert.equal(result.overdueValue, 0);
    assert.equal(result.aging.reduce((n, b) => n + b.invoices, 0), 0);
  });
}
for (const dueAt of ["2026-08-04", "2026-08-05", "2026-09-01"]) {
  test(`data não vencida não entra na soma: ${dueAt}`, () => {
    const result = summarizeFullBase([{ status: "A", dueAt, value: 900 }], options);
    assert.equal(result.overdueValue, 0);
  });
}
test("lote misto preserva totais remotos e soma somente vencidas abertas", () => {
  const result = summarizeFullBase([
    { status: "A", dueAt: "2026-08-01", value: 100 },
    { status: " em aberto ", dueAt: "2026-07-25", value: 200 },
    { status: "R", dueAt: "2026-08-01", value: 900 },
    { status: "A", dueAt: "2026-08-04", value: 900 },
    { status: "A", dueAt: undefined, value: 900 },
    { status: "C", dueAt: undefined, value: 900 },
  ], options);
  assert.equal(result.overdueValue, 300);
  assert.equal(result.aging.reduce((n, b) => n + b.value, 0), 300);
  assert.equal(result.invoicesWithoutDueDate, 1);
  assert.equal(result.overdueScanned, 6);
  assert.equal(result.overdueInvoices, 99);
  assert.equal(result.openInvoices, 120);
  assert.equal(result.openValue, null);
  assert.equal(result.truncated, true);
});

for (const [reference, expected] of [["2026-03-04T02:59:59Z", 0], ["2026-03-04T03:00:00Z", 50]]) {
  test(`composição: datas impossíveis e status desconhecidos na virada brasileira ${reference}`, () => {
    const result = summarizeFullBase([
      { status: "A", dueAt: "2026-02-30", value: 1000 },
      { status: "desconhecido", dueAt: "2026-03-01", value: 2000 },
      { status: "R", dueAt: "2026-02-30", value: 3000 },
      { status: "A", dueAt: "2026-03-03", value: 50 },
      { status: "A", dueAt: "2026-03-05", value: 4000 },
    ], { ...options, now: new Date(reference) });
    assert.equal(result.overdueValue, expected);
    assert.equal(result.aging.reduce((sum, bucket) => sum + bucket.value, 0), expected);
    assert.equal(result.invoicesWithoutDueDate, 1);
    assert.equal(result.overdueScanned, 5);
    assert.equal(result.overdueInvoices, 99);
    assert.equal(result.openInvoices, 120);
  });
}
