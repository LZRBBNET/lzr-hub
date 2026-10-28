import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { IxcInvoiceMapper } from "../lib/integrations/ixc/mappers.ts";
import { businessToday, summarizeBilling, summarizeFullBase } from "../lib/platform/billing-service.ts";

// Execute the actual route with isolated dependencies; no session, ERP or network access.
const source = await readFile(new URL("../app/api/billing/overview/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/^import .*?;\s*$/gm, "").replace("export async function GET", "async function GET");
const NOW = new Date("2026-10-28T12:00:00Z");
class Clock extends Date {
  constructor(value) { super(value === undefined ? NOW.getTime() : value); }
  static now() { throw new Error("Use the same captured reference instant, not a second clock read"); }
}
const build = new Function("NextResponse", "getIxcRuntime", "IxcInvoiceMapper", "businessToday", "summarizeBilling", "summarizeFullBase", "authorize", "Date", `${compiled}\nreturn GET;`);
const handler = (runtime, guard = { allowed: true }) => build({ json: Response.json }, () => runtime, IxcInvoiceMapper, businessToday, summarizeBilling, summarizeFullBase, async () => guard, Clock);
const raw = (extra = {}) => ({ id: "940001", id_cliente: "910001", status: "A", data_vencimento: "2026-10-01", valor: "100.00", valor_aberto: "20.00", ...extra });
const full = (rows) => ({ config: { ixcFullBase: true }, provider: { async listOverdueInvoices(day) { assert.equal(day, "2026-10-28"); return { rows, total: rows.length, truncated: false }; }, async countOpenInvoices() { return 8; } } });
const request = (period = "30d") => new Request(`http://localhost/api/billing/overview?period=${period}`);

test("overview route consumes actual open balance, not face value, including confirmed zero", async () => {
  const get = handler(full([raw(), raw({ id: "940002", valor_aberto: "0" })]));
  const response = await get(request());
  assert.equal(response.status, 200);
  const { summary } = await response.json();
  assert.equal(summary.overdueValue, 20);
  assert.equal(summary.amountIncomplete, false);
  assert.equal(summary.openValue, null);
  assert.equal(summary.openInvoices, 8);
});

test("overview raw absent/null/invalid balance cannot become a nominal or zero balance", async () => {
  for (const valor_aberto of [undefined, null, "", "invalid", "-2", "NaN", "Infinity"]) {
    const { summary } = await (await handler(full([raw({ valor_aberto })]))(request())).json();
    assert.equal(summary.overdueValue, null, String(valor_aberto));
    assert.equal(summary.amountIncomplete, true);
    assert.equal(summary.excludedInvoices, 1);
  }
});

test("overview malformed row is disclosed without losing the valid partial reading", async () => {
  const { summary } = await (await handler(full([raw(), { status: "A", valor: "999" }]))(request())).json();
  assert.equal(summary.overdueValue, 20);
  assert.equal(summary.overdueScanned, 2);
  assert.equal(summary.excludedInvoices, 1);
  assert.equal(summary.amountIncomplete, true);
});

test("overview allowlist 24h uses one reference clock and discloses partial snapshot sources", async () => {
  const data = {
    customer: { id: "910001" }, invoices: [],
    payments: [{ id: "950001", customerId: "910001", paidAt: "2026-10-27T12:00:00Z", value: 15, method: "PIX" }],
    coverage: { invoices: { read: 0, total: null, complete: false, limit: 20 }, payments: { read: 1, total: 1, complete: true, limit: 100 } },
    partialSources: ["invoices"],
  };
  const runtime = { config: { ixcFullBase: false, ixcAllowlist: ["910001"] }, provider: { async getSnapshot(id) { assert.equal(id, "910001"); return data; } } };
  const { summary } = await (await handler(runtime)(request("24h"))).json();
  assert.equal(summary.openValue, null);
  assert.equal(summary.amountIncomplete, true);
  assert.equal(summary.paidInPeriod, 15);
  assert.equal(summary.paymentsIncomplete, false);
});

test("overview denies unauthorized access before touching the financial provider", async () => {
  const denied = await handler(undefined, { allowed: false, error: "Forbidden", status: 403 })(request());
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Forbidden" });
});


test("overview with actual adapter rejects missing financial total rather than returning zero", async () => {
  const provider = new IxcReadonlyProvider({ baseUrl: "https://ixc.fixture.invalid", token: "synthetic-fixture-only", allowedCustomerIds: [], fullBase: true, retryLimit: 0,
    fetcher: async () => Response.json({ registros: [] }),
  });
  const response = await handler({ config: { ixcFullBase: true }, provider })(request());
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.summary, null);
  assert.equal(body.detail, "Consulta financeira do IXC indisponível");
});
