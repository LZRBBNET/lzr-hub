import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import * as promiseService from "../lib/platform/payment-promise-service.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { businessToday } from "../lib/platform/billing-service.ts";

// Execute the actual HTTP handler. Only its authorization, database, runtime
// factory and audit boundaries are replaced. The IXC adapter below uses only
// an in-memory transport; no real account, database or network is accessed.
const require = createRequire(import.meta.url);
const handlerSource = transformSync(readFileSync(new URL("../app/api/billing/promises/route.ts", import.meta.url), "utf8"), {
  loader: "ts", format: "cjs", target: "es2022",
}).code;
const PRIVATE_MARKER = "synthetic-private-payload-do-not-expose";
const record = (over = {}) => ({ id: "901", id_cliente: "10", status: "A", ...over });
const body = (over = {}) => ({ action: "create", invoiceId: "901", customerId: "10", promisedFor: businessToday(new Date()), ...over });

function fixture(options = {}) {
  const calls = { runtime: 0, snapshot: 0, transport: [], db: 0, create: [], audit: [], permissions: [] };
  const provider = new IxcReadonlyProvider({
    baseUrl: "https://ixc.invalid", token: "synthetic", allowedCustomerIds: ["10"], retryLimit: 0,
    fetcher: async (url, init) => {
      calls.transport.push({ url, method: init.method, command: new Headers(init.headers).get("ixcsoft"), body: JSON.parse(init.body) });
      if (options.transportError) throw new Error(PRIVATE_MARKER);
      const value = typeof options.response === "function" ? options.response(calls.transport.length) : options.response;
      return Response.json(value ?? { registros: [record()], total: "1" }, { status: options.httpStatus ?? 200 });
    },
  });
  provider.getSnapshot = async () => {
    calls.snapshot++;
    return { invoices: options.snapshotInvoices ?? [{ id: "901", customerId: "10", status: "A" }] };
  };
  const source = Object.hasOwn(options, "source") ? options.source : provider;
  const modules = {
    "next/server": require("next/server"),
    "node:crypto": require("node:crypto"),
    "@/db": { async getDb() { calls.db++; return {}; } },
    "@/lib/integrations/ixc/runtime": { getIxcRuntime() {
      calls.runtime++;
      if (options.runtimeError) throw new Error(PRIVATE_MARKER);
      return { provider: source };
    } },
    "@/lib/platform/payment-promise-service": { ...promiseService, DbPaymentPromiseRepository: class {
      async create(input) { calls.create.push(input); return { id: "synthetic-promise", ...input, status: "pending" }; }
    } },
    "@/lib/platform/audit-log": { async logUnauthenticatedAction(event) { calls.audit.push(event); } },
    "@/lib/platform/session-guard": { async authorize(_request, permission) {
      calls.permissions.push(permission);
      return options.guard ?? { allowed: true, user: { id: "synthetic-user", email: "synthetic@example.invalid", role: "admin" } };
    } },
  };
  const compiled = { exports: {} };
  new Function("require", "module", "exports", handlerSource)((name) => {
    assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
    return modules[name];
  }, compiled, compiled.exports);
  return { calls, async post(payload = body()) {
    return compiled.exports.POST(new Request("http://localhost/api/billing/promises", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }));
  } };
}

function assertNoWrite(calls) {
  assert.equal(calls.db, 0, "invoice evidence must be validated before accessing the promise database");
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.audit, [], "no success audit for a refused promise");
}
async function assertSafeRefusal(response, expectedStatus, calls) {
  assert.equal(response.status, expectedStatus);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.equal(typeof payload.error, "string");
  assert.equal(JSON.stringify(payload).includes(PRIVATE_MARKER), false);
  assertNoWrite(calls);
  assert.equal(calls.snapshot, 0, "creation never uses a cached or partial snapshot");
}

test("creation confirms a fresh exact open invoice before DB and success audit", async () => {
  const { post, calls } = fixture();
  const response = await post();
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, "pending");
  assert.deepEqual(calls.permissions, ["billing.write-demo"]);
  assert.equal(calls.snapshot, 0);
  assert.deepEqual(calls.transport, [{
    url: "https://ixc.invalid/webservice/v1/fn_areceber", method: "POST", command: "listar",
    body: { qtype: "fn_areceber.id", query: "901", oper: "=", page: "1", rp: "2", sortname: "fn_areceber.id", sortorder: "asc",
      grid_param: JSON.stringify([{ TB: "fn_areceber.id_cliente", OP: "=", P: "10" }]) },
  }]);
  assert.equal(calls.db, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].invoiceId, "901");
  assert.equal(calls.create[0].customerId, "10");
  assert.equal(calls.create[0].registeredBy, "synthetic@example.invalid");
  assert.equal(calls.audit.length, 1);
  assert.equal(calls.audit[0].action, "billing.promise.create");
  assert.equal(calls.audit[0].result, "success");
  assert.equal(calls.audit[0].correlationId, calls.create[0].correlationId);
});

for (const status of ["R", "C"]) test(`creation refuses ${status} even when an old snapshot says open`, async () => {
  const { post, calls } = fixture({ response: { registros: [record({ status })], total: 1 } });
  await assertSafeRefusal(await post(), 409, calls);
  assert.equal(calls.transport.length, 1);
});

for (const status of ["X", "P", "", "a", " A ", null, false, 7, ["A"], { status: "A" }]) {
  test(`creation fails closed for an unknown or malformed status ${JSON.stringify(status)}`, async () => {
    const { post, calls } = fixture({ response: { registros: [record({ status })], total: 1 } });
    await assertSafeRefusal(await post(), 503, calls);
  });
}

test("creation finds an invoice outside the first 20 without reading the snapshot", async () => {
  const { post, calls } = fixture({ snapshotInvoices: Array.from({ length: 20 }, (_, index) => ({ id: String(index + 1), status: "A" })) });
  assert.equal((await post()).status, 201);
  assert.equal(calls.snapshot, 0);
  assert.equal(calls.transport.length, 1);
});

test("each create rechecks fresh status and a later paid response cannot reuse prior evidence", async () => {
  const { post, calls } = fixture({ response: (attempt) => ({ registros: [record({ status: attempt === 1 ? "A" : "R" })], total: 1 }) });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 409);
  assert.equal(calls.transport.length, 2);
  assert.equal(calls.snapshot, 0);
  assert.equal(calls.db, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.audit.length, 1);
});

test("missing exact invoice is refused without persisting a promise", async () => {
  const { post, calls } = fixture({ response: { registros: [], total: 0 } });
  await assertSafeRefusal(await post(), 404, calls);
});

for (const [label, response] of [
  ["truncated page", { registros: [record()], total: 2 }],
  ["duplicate rows", { registros: [record(), record()], total: 2 }],
  ["missing total", { registros: [record()] }],
  ["invalid total", { registros: [record()], total: "invalid" }],
  ["contradictory total", { registros: [record()], total: 0 }],
  ["malformed extra record", { registros: [record(), null], total: 1 }],
  ["wrong invoice", { registros: [record({ id: "902" })], total: 1 }],
  ["wrong customer", { registros: [record({ id_cliente: "20" })], total: 1 }],
  ["missing customer", { registros: [record({ id_cliente: null })], total: 1 }],
  ["unsafe numeric identity", { registros: [record({ id: 9007199254740992 })], total: 1 }],
  ["API failure with private detail", { type: "error", message: PRIVATE_MARKER }],
]) test(`incomplete or inconsistent fresh evidence is refused: ${label}`, async () => {
  const { post, calls } = fixture({ response });
  await assertSafeRefusal(await post(), 503, calls);
  assert.equal(calls.transport.length, 1);
});

for (const [label, options] of [
  ["provider disabled", { source: undefined }],
  ["runtime failure", { runtimeError: true }],
  ["transport failure", { transportError: true }],
  ["HTTP failure", { httpStatus: 503 }],
  ["provider without exact lookup", { source: { getSnapshot: async () => ({ invoices: [record()] }) } }],
  ["exact lookup throws private detail", { source: { async getInvoiceForCustomer() { throw new Error(PRIVATE_MARKER); } } }],
]) test(`missing or failing fresh source prevents creation: ${label}`, async () => {
  const { post, calls } = fixture(options);
  await assertSafeRefusal(await post(), 503, calls);
});

for (const invoice of [
  { id: "902", customerId: "10", status: "A" },
  { id: "901", customerId: "20", status: "A" },
  { id: 901, customerId: "10", status: "A" },
  { id: "901", customerId: "10", status: ["A"] },
  { id: "901", customerId: "10" },
]) test(`handler independently rejects incorrect identity or malformed status ${JSON.stringify(invoice)}`, async () => {
  const { post, calls } = fixture({ source: { async getInvoiceForCustomer() { return invoice; } } });
  await assertSafeRefusal(await post(), 503, calls);
});

test("customer allowlist is preserved before IXC transport", async () => {
  const { post, calls } = fixture();
  await assertSafeRefusal(await post(body({ customerId: "20" })), 503, calls);
  assert.equal(calls.transport.length, 0);
});

for (const key of ["invoiceId", "customerId"]) test(`invalid ${key} is rejected before runtime, IXC or DB`, async () => {
  for (const value of [undefined, null, false, 10, {}, [], "", "0", "-1", "1.5", "1e2", "01", " 10", "10 ", "10\n", "1 OR 1=1", "9".repeat(33)]) {
    const { post, calls } = fixture();
    await assertSafeRefusal(await post(body({ [key]: value })), 400, calls);
    assert.equal(calls.runtime, 0);
    assert.equal(calls.transport.length, 0);
  }
});

test("invalid promised date remains rejected before invoice lookup", async () => {
  for (const promisedFor of ["", "not-a-date", "2026-11-31", "2000-01-01"]) {
    const { post, calls } = fixture();
    await assertSafeRefusal(await post(body({ promisedFor })), 400, calls);
    assert.equal(calls.runtime, 0);
  }
});

for (const status of [401, 403]) test(`creation preserves authorization denial ${status}`, async () => {
  const { post, calls } = fixture({ guard: { allowed: false, status, error: "Access denied" } });
  await assertSafeRefusal(await post(), status, calls);
  assert.deepEqual(calls.permissions, ["billing.write-demo"]);
  assert.equal(calls.runtime, 0);
  assert.equal(calls.transport.length, 0);
});
