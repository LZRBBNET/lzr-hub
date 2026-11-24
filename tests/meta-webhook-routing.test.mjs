import test from "node:test";
import assert from "node:assert/strict";
import { getWebhookRouting } from "../lib/integrations/meta/templates.ts";

const config = (fetcher) => ({ accessToken: "TOKEN", wabaId: "4435162016795823", graphVersion: "v26.0", fetcher });

test("mostra a URL própria da conta e a do número, sem expor o token", async () => {
  const chamadas = [];
  const fetcher = async (url, init) => {
    chamadas.push({ url, auth: init.headers.Authorization });
    if (url.includes("subscribed_apps")) return { ok: true, status: 200, json: async () => ({ data: [{ whatsapp_business_api_data: { id: "2337825110390769", name: "BBNet bot" }, override_callback_uri: "https://outro.exemplo/hook" }] }) };
    return { ok: true, status: 200, json: async () => ({ webhook_configuration: { phone_number: "https://numero.exemplo/hook" } }) };
  };
  const result = await getWebhookRouting(config(fetcher), "999");
  assert.equal(result.ok, true);
  assert.deepEqual(result.routing.apps, [{ appId: "2337825110390769", appName: "BBNet bot", overrideCallbackUri: "https://outro.exemplo/hook" }]);
  assert.equal(result.routing.phoneOverrideUri, "https://numero.exemplo/hook");
  assert.ok(chamadas.every((c) => c.auth === "Bearer TOKEN" && !c.url.includes("TOKEN")));
  assert.doesNotMatch(JSON.stringify(result), /TOKEN/);
});

test("sem URL própria: nada é inventado", async () => {
  const fetcher = async (url) => (url.includes("subscribed_apps")
    ? { ok: true, status: 200, json: async () => ({ data: [{ whatsapp_business_api_data: { id: "1", name: "App" } }] }) }
    : { ok: true, status: 200, json: async () => ({}) });
  const result = await getWebhookRouting(config(fetcher), "999");
  assert.equal(result.routing.apps[0].overrideCallbackUri, null);
  assert.equal(result.routing.phoneOverrideUri, null);
});

test("a Meta recusar o campo do número vira aviso, não 'sem URL'", async () => {
  const fetcher = async (url) => (url.includes("subscribed_apps")
    ? { ok: true, status: 200, json: async () => ({ data: [] }) }
    : { ok: false, status: 400, json: async () => ({ error: { message: "campo inválido" } }) });
  const result = await getWebhookRouting(config(fetcher), "999");
  assert.equal(result.ok, true);
  assert.match(result.notes[0], /Não consegui ler a URL própria do número/);
});

test("falha na conta devolve motivo, sem lançar", async () => {
  const result = await getWebhookRouting(config(async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "sem permissão" } }) })));
  assert.equal(result.ok, false);
  assert.match(result.reason, /sem permissão/);
});
