import test from "node:test";
import assert from "node:assert/strict";

for (const auth of ["false", "true"]) test(`revisão HTTP sem sessão não executa reconciliação, FEATURE_AUTH=${auth}`, async () => {
  const before = process.env.FEATURE_AUTH;
  process.env.FEATURE_AUTH = auth;
  try {
    const { default: worker } = await import("../dist/server/index.js");
    const response = await worker.fetch(new Request("http://localhost/api/billing/promises", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "review" }),
    }), {}, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal("fulfilled" in body, false);
  } finally { if (before === undefined) delete process.env.FEATURE_AUTH; else process.env.FEATURE_AUTH = before; }
});

for (const auth of ["false", "true"]) test(`criação HTTP sem sessão não registra promessa, FEATURE_AUTH=${auth}`, async () => {
  const before = process.env.FEATURE_AUTH;
  process.env.FEATURE_AUTH = auth;
  try {
    const { default: worker } = await import("../dist/server/index.js");
    const response = await worker.fetch(new Request("http://localhost/api/billing/promises", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", customerId: "10", invoiceId: "901", promisedFor: "2026-10-28" }),
    }), {}, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal("id" in body, false);
  } finally { if (before === undefined) delete process.env.FEATURE_AUTH; else process.env.FEATURE_AUTH = before; }
});
