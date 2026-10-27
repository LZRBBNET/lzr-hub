import test from "node:test";
import assert from "node:assert/strict";
import { canSee, navigation, parseView, sectionOf } from "../lib/platform/navigation.ts";

test("recuperação é uma aba de cobrança com permissão de leitura", () => {
  assert.equal(parseView("#/recuperacao"), "recuperacao");
  assert.equal(sectionOf("recuperacao").id, "cobranca");
  const tab = navigation.flatMap((section) => section.tabs).find((item) => item.id === "recuperacao");
  assert.equal(canSee(tab, []), false);
  assert.equal(canSee(tab, ["customer.read"]), true);
});

for (const path of ["/api/billing/recovery", "/api/billing/recovery/customer?customerId=123"]) {
  test(`HTTP sem sessão falha fechado: ${path}`, async () => {
    const { default: worker } = await import("../dist/server/index.js");
    const response = await worker.fetch(new Request(`http://localhost${path}`), {}, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal("rows" in body, false);
    assert.equal("contracts" in body, false);
  });

  test(`HTTP não oferece operação de escrita: ${path}`, async () => {
    const { default: worker } = await import("../dist/server/index.js");
    const response = await worker.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {}, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 405);
  });
}
