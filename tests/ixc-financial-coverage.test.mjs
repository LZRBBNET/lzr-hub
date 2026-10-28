import test from "node:test";
import assert from "node:assert/strict";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { summarizeFullBase } from "../lib/platform/billing-service.ts";
import { IxcInvoiceMapper } from "../lib/integrations/ixc/mappers.ts";

const row = (id = "940001") => ({ id, id_cliente: "910001", status: "A", data_vencimento: "2026-10-01", valor: "100", valor_aberto: "20" });
function fixture(body) {
  const calls = [];
  const provider = new IxcReadonlyProvider({ baseUrl: "https://ixc.fixture.invalid", token: "synthetic-fixture-only", allowedCustomerIds: [], fullBase: true, retryLimit: 0,
    fetcher: async (_url, init) => {
      assert.equal(new Headers(init.headers).get("ixcsoft"), "listar");
      const request = JSON.parse(init.body); calls.push(request);
      return Response.json(typeof body === "function" ? body(request) : body);
    },
  });
  return { provider, calls };
}
const invalid = (error) => error.code === "IXC_INCOMPLETE_FINANCIAL_RESPONSE" && error.message === "IXC_INCOMPLETE_FINANCIAL_RESPONSE";

for (const [label, total] of [["missing", undefined], ["null", null], ["blank", ""], ["invalid", "invalid"], ["boolean", true], ["negative", -1], ["fractional", 1.5], ["unsafe", Number.MAX_SAFE_INTEGER + 1]]) {
  for (const records of [[], [row()]]) test(`financial ${label} total with ${records.length ? "full" : "empty"} page fails closed`, async () => {
    const { provider, calls } = fixture({ registros: records, total });
    await assert.rejects(provider.listOverdueInvoices("2026-10-28", "synthetic-overdue", 2, 1), invalid);
    await assert.rejects(provider.countOpenInvoices("synthetic-count"), invalid);
    assert.equal(calls.length, 2, "no guessed total or silent extra pagination");
  });
}

for (const [label, body] of [
  ["missing rows", { total: 0 }],
  ["non-array rows", { total: 0, registros: {} }],
  ["filtered invalid row", { total: 1, registros: [null] }],
  ["array row", { total: 1, registros: [[]] }],
  ["missing identity", { total: 1, registros: [{ status: "A" }] }],
  ["unsafe numeric identity", { total: 1, registros: [row(Number.MAX_SAFE_INTEGER + 1)] }],
  ["noncanonical identity", { total: 1, registros: [row("0940001")] }],
  ["contradictory zero", { total: 0, registros: [row()] }],
  ["empty positive count", { total: 1, registros: [] }],
  ["wrong page", { total: 1, registros: [row()], page: "2" }],
]) test(`financial malformed response fails closed: ${label}`, async () => {
  const { provider } = fixture(body);
  await assert.rejects(provider.listOverdueInvoices("2026-10-28", "synthetic-overdue", 2, 1), invalid);
  await assert.rejects(provider.countOpenInvoices("synthetic-count"), invalid);
});

test("explicit zero with intact empty page remains a confirmed zero", async () => {
  const { provider } = fixture({ total: "0", registros: [], page: "1" });
  const scan = await provider.listOverdueInvoices("2026-10-28", "synthetic-zero");
  assert.deepEqual(scan, { rows: [], total: 0, truncated: false });
  assert.equal(await provider.countOpenInvoices("synthetic-zero-count"), 0);
  const summary = summarizeFullBase([], { now: new Date("2026-10-28T12:00:00Z"), overdueTotal: scan.total, openCount: 0, truncated: scan.truncated });
  assert.equal(summary.overdueValue, 0);
  assert.equal(summary.amountIncomplete, false);
});

test("count query uses explicit total even when total exceeds its one-row limit", async () => {
  const { provider, calls } = fixture({ total: "9", registros: [row()], page: 1 });
  assert.equal(await provider.countOpenInvoices("synthetic-count"), 9);
  assert.equal(calls[0].rp, "1");
});

test("valid paginated financial scan preserves total, open balances and bounded truncation", async () => {
  const all = [row("940001"), row("940002"), row("940003")];
  const { provider, calls } = fixture((request) => ({ total: "3", page: request.page, registros: all.slice((+request.page - 1) * +request.rp, +request.page * +request.rp) }));
  const scan = await provider.listOverdueInvoices("2026-10-28", "synthetic-pages", 3, 2);
  assert.equal(scan.total, 3); assert.equal(scan.truncated, false); assert.equal(scan.rows.length, 3); assert.equal(calls.length, 2);
  const summary = summarizeFullBase(scan.rows.map(IxcInvoiceMapper.map), { now: new Date("2026-10-28T12:00:00Z"), overdueTotal: scan.total, openCount: 3, truncated: scan.truncated });
  assert.equal(summary.overdueValue, 60); assert.equal(summary.amountIncomplete, false);
  const partial = await provider.listOverdueInvoices("2026-10-28", "synthetic-bounded", 1, 2);
  assert.equal(partial.truncated, true); assert.equal(partial.total, 3); assert.equal(partial.rows.length, 2);
});

test("short page, duplicate page and changing total cannot masquerade as complete scan", async () => {
  for (const response of [
    () => ({ total: 3, registros: [row()] }),
    (request) => ({ total: 2, registros: [row(+request.page === 1 ? 940001 : "940001")] }),
    (request) => ({ total: +request.page === 1 ? 2 : 3, registros: [row(`94000${request.page}`)] }),
  ]) {
    const { provider } = fixture(response);
    await assert.rejects(provider.listOverdueInvoices("2026-10-28", "synthetic-bad-page", 3, response.length ? 1 : 2), invalid);
  }
});
