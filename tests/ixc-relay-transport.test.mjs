import test from "node:test";
import assert from "node:assert/strict";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { DirectIxcTransport, RelayIxcTransport } from "../lib/integrations/ixc/transport.ts";
import { loadRuntimeConfig } from "../lib/runtime/environment.ts";

const allowedId = "CUSTOMER-1";
const relaySecrets = {
  IXC_RELAY_URL: "https://relay.example.invalid",
  IXC_RELAY_HMAC_SECRET: "h".repeat(64),
  CF_ACCESS_CLIENT_ID: "access-id",
  CF_ACCESS_CLIENT_SECRET: "access-secret",
};

test("Worker usa relay assinado sem token IXC", async () => {
  let captured;
  const transport = new RelayIxcTransport({
    relayUrl: relaySecrets.IXC_RELAY_URL,
    hmacSecret: relaySecrets.IXC_RELAY_HMAC_SECRET,
    accessClientId: relaySecrets.CF_ACCESS_CLIENT_ID,
    accessClientSecret: relaySecrets.CF_ACCESS_CLIENT_SECRET,
    now: () => 1_750_000_000_000,
    nonce: () => "nonce-transport-0000001",
    fetcher: async (url, init) => {
      captured = { url: String(url), init };
      return Response.json({ ok: true, data: [], meta: { correlationId: "corr-relay-001" } });
    },
  });
  await transport.execute({
    operation: "getCustomer",
    parameters: { customerId: allowedId },
    correlationId: "corr-relay-001",
  });
  assert.equal(captured.url, "https://relay.example.invalid/v1/ixc/read");
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get("CF-Access-Client-Id"), "access-id");
  assert.equal(headers.get("X-LZR-Signature")?.length, 64);
  assert.equal(JSON.stringify(captured).includes("IXC_API_TOKEN"), false);
});

test("produção aceita relay somente sem token IXC", () => {
  const config = loadRuntimeConfig({
    LZR_ENV: "production",
    IXC_MODE: "production-readonly",
    IXC_TRANSPORT: "relay",
    IXC_ALLOWED_CUSTOMER_IDS: allowedId,
    IXC_WRITE_ENABLED: "false",
    FEATURE_IXC_WRITE: "false",
    ...relaySecrets,
  });
  assert.equal(config.ixcTransport, "relay");
  assert.equal(config.ixcToken, undefined);
  assert.throws(() => loadRuntimeConfig({
    LZR_ENV: "production",
    IXC_MODE: "production-readonly",
    IXC_TRANSPORT: "relay",
    IXC_ALLOWED_CUSTOMER_IDS: allowedId,
    IXC_API_TOKEN: "forbidden-in-worker",
    ...relaySecrets,
  }), /Token IXC não pode existir/);
});

test("produção bloqueia transporte direto e não admite fallback", () => {
  assert.throws(() => loadRuntimeConfig({
    LZR_ENV: "production",
    IXC_MODE: "production-readonly",
    IXC_TRANSPORT: "direct",
    IXC_BASE_URL: "https://ixc.invalid",
    IXC_API_TOKEN: "secret",
    IXC_ALLOWED_CUSTOMER_IDS: allowedId,
  }), /Produção proíbe transporte IXC direto/);
});

test("direct permanece permitido somente em staging controlado", async () => {
  let resource;
  const direct = new DirectIxcTransport({
    baseUrl: "https://ixc.invalid",
    token: `128:${"a".repeat(64)}`,
    fetcher: async (url) => {
      resource = String(url).split("/").at(-1);
      return Response.json({ registros: [] });
    },
  });
  await direct.execute({
    operation: "listInvoices",
    parameters: { customerId: allowedId },
    correlationId: "corr-direct-001",
  });
  assert.equal(resource, "fn_areceber");
  const config = loadRuntimeConfig({
    LZR_ENV: "staging",
    IXC_MODE: "staging-readonly",
    IXC_TRANSPORT: "direct",
    IXC_BASE_URL: "https://ixc.invalid",
    IXC_API_TOKEN: "secret",
    IXC_ALLOWED_CUSTOMER_IDS: allowedId,
  });
  assert.equal(config.ixcTransport, "direct");
});

test("falha do relay não dispara chamada direta ao IXC", async () => {
  let relayCalls = 0;
  const relay = new RelayIxcTransport({
    relayUrl: relaySecrets.IXC_RELAY_URL,
    hmacSecret: relaySecrets.IXC_RELAY_HMAC_SECRET,
    accessClientId: relaySecrets.CF_ACCESS_CLIENT_ID,
    accessClientSecret: relaySecrets.CF_ACCESS_CLIENT_SECRET,
    fetcher: async () => {
      relayCalls += 1;
      throw new Error("relay offline");
    },
  });
  const provider = new IxcReadonlyProvider({
    transport: relay,
    allowedCustomerIds: [allowedId],
    retryLimit: 0,
  });
  await assert.rejects(() => provider.getSnapshot(allowedId, "corr-no-fallback"));
  assert.equal(relayCalls, 1);
});
