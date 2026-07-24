import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRelayApp } from "../src/app.ts";
import { loadRelayConfig } from "../src/config.ts";

const fixedNow = 1_750_000_000_000;
const hmacSecret = "relay-hmac-secret-".padEnd(64, "x");
const apiToken = `128:${"a".repeat(64)}`;
let nonceSequence = 0;

function config(overrides = {}) {
  return loadRelayConfig({
    RELAY_ENV: "test",
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "8788",
    RELAY_LOG_LEVEL: "info",
    IXC_UPSTREAM_BASE_URL: "https://ixc.invalid",
    IXC_API_TOKEN: apiToken,
    IXC_ALLOWED_CUSTOMER_IDS: "CUSTOMER-1",
    IXC_TIMEOUT_MS: "500",
    IXC_RETRY_LIMIT: "0",
    IXC_RATE_LIMIT_PER_MINUTE: "30",
    IXC_WRITE_ENABLED: "false",
    FEATURE_IXC_WRITE: "false",
    IXC_RELAY_HMAC_SECRET: hmacSecret,
    IXC_RELAY_MAX_CLOCK_SKEW_SECONDS: "60",
    IXC_RELAY_NONCE_TTL_SECONDS: "120",
    IXC_RELAY_MAX_BODY_BYTES: "32768",
    IXC_RELAY_MAX_CONCURRENCY: "8",
    IXC_RELAY_ALLOWED_OPERATIONS: "testConnection,getCustomer,listContracts,getPlan,listInvoices,listPayments,listServiceOrders,getConnection",
    ...overrides,
  });
}

function signedRequest(path, payload, options = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(fixedNow / 1000));
  const nonce = options.nonce ?? `nonce-${String(++nonceSequence).padStart(20, "0")}`;
  const correlationId = options.correlationId ?? `corr-${String(nonceSequence).padStart(12, "0")}`;
  const method = options.method ?? "POST";
  const canonicalPath = options.canonicalPath ?? path;
  const canonical = [
    "v1",
    timestamp,
    nonce,
    method,
    canonicalPath,
    createHash("sha256").update(options.signedBody ?? body).digest("hex"),
    correlationId,
  ].join("\n");
  const signature = options.signature ?? createHmac("sha256", hmacSecret).update(canonical).digest("hex");
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
    "CF-Access-Client-Id": "service-client-id",
    "CF-Access-Client-Secret": "service-client-secret",
    "X-LZR-Timestamp": timestamp,
    "X-LZR-Nonce": nonce,
    "X-LZR-Signature": signature,
    "X-Correlation-Id": correlationId,
  });
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request(`https://relay.invalid${path}`, { method, headers, body });
}

function appWith(fetcher, overrides = {}, logs = []) {
  return createRelayApp(config(overrides), {
    fetcher,
    now: () => fixedNow,
    logSink: (event) => logs.push(event),
  });
}

async function json(response) {
  return response.json();
}

test("operação permitida usa somente POST/listar e recurso mapeado", async () => {
  let captured;
  const app = appWith(async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({ registros: [{ id: "CUSTOMER-1" }] });
  });
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer",
    parameters: { customerId: "CUSTOMER-1", pageSize: 1 },
  }));
  assert.equal(response.status, 200);
  assert.equal(captured.url, "https://ixc.invalid/webservice/v1/cliente");
  assert.equal(captured.init.method, "POST");
  assert.equal(new Headers(captured.init.headers).get("ixcsoft"), "listar");
  assert.deepEqual(JSON.parse(captured.init.body), {
    qtype: "id", query: "CUSTOMER-1", oper: "=", page: "1", rp: "1", sortname: "id", sortorder: "asc",
  });
});

test("operação não permitida é recusada antes do IXC", async () => {
  let calls = 0;
  const app = appWith(async () => { calls += 1; return Response.json({ registros: [] }); });
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "updateCustomer",
    parameters: { customerId: "CUSTOMER-1" },
  }));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error.code, "RELAY_OPERATION_FORBIDDEN");
  assert.equal(calls, 0);
});

for (const field of ["url", "resource", "headers", "method", "body", "qtype", "oper"]) {
  test(`campo arbitrário ${field} é bloqueado`, async () => {
    let calls = 0;
    const app = appWith(async () => { calls += 1; return Response.json({ registros: [] }); });
    const response = await app.fetch(signedRequest("/v1/ixc/read", {
      operation: "getCustomer",
      parameters: { customerId: "CUSTOMER-1" },
      [field]: field === "headers" ? { Authorization: "attacker" } : "https://internal.invalid",
    }));
    assert.equal(response.status, 403);
    assert.equal((await json(response)).error.code, "RELAY_FIELD_FORBIDDEN");
    assert.equal(calls, 0);
  });
}

test("método diferente de POST é bloqueado", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const request = new Request("https://relay.invalid/v1/ixc/read", { method: "DELETE" });
  const response = await app.fetch(request);
  assert.equal(response.status, 405);
});

test("assinatura válida é aceita", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }));
  assert.equal(response.status, 200);
});

test("assinatura inválida é rejeitada", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { signature: "0".repeat(64) }));
  assert.equal(response.status, 401);
  assert.equal((await json(response)).error.code, "RELAY_SIGNATURE_INVALID");
});

test("Access ausente é rejeitado", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { headers: { "CF-Access-Client-Id": null } }));
  assert.equal(response.status, 401);
  assert.equal((await json(response)).error.code, "RELAY_UNAUTHORIZED");
});

test("assinatura ausente é rejeitada", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { headers: { "X-LZR-Signature": null } }));
  assert.equal(response.status, 401);
  assert.equal((await json(response)).error.code, "RELAY_SIGNATURE_INVALID");
});

test("timestamp expirado é rejeitado", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { timestamp: String(Math.floor(fixedNow / 1000) - 61) }));
  assert.equal(response.status, 401);
  assert.equal((await json(response)).error.code, "RELAY_TIMESTAMP_INVALID");
});

test("nonce reutilizado é rejeitado", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const nonce = "nonce-replay-0000000001";
  const first = signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { nonce });
  const second = signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { nonce });
  assert.equal((await app.fetch(first)).status, 200);
  const response = await app.fetch(second);
  assert.equal(response.status, 409);
  assert.equal((await json(response)).error.code, "RELAY_REPLAY_DETECTED");
});

test("corpo alterado após assinatura é rejeitado", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const original = JSON.stringify({ operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" } });
  const altered = JSON.stringify({ operation: "getCustomer", parameters: { customerId: "OUTSIDE" } });
  const response = await app.fetch(signedRequest("/v1/ixc/read", altered, { signedBody: original }));
  assert.equal(response.status, 401);
  assert.equal((await json(response)).error.code, "RELAY_SIGNATURE_INVALID");
});

test("correlation ID é preservado ponta a ponta", async () => {
  let upstreamCorrelation;
  const app = appWith(async (_url, init) => {
    upstreamCorrelation = new Headers(init.headers).get("x-correlation-id");
    return Response.json({ registros: [] });
  });
  const correlationId = "corr-preserved-001";
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { correlationId }));
  assert.equal((await json(response)).meta.correlationId, correlationId);
  assert.equal(upstreamCorrelation, correlationId);
});

test("cliente na allowlist é aceito", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "listContracts", parameters: { customerId: "CUSTOMER-1" },
  }));
  assert.equal(response.status, 200);
});

test("cliente fora da allowlist é bloqueado antes da rede", async () => {
  let calls = 0;
  const app = appWith(async () => { calls += 1; return Response.json({ registros: [] }); });
  const response = await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "listContracts", parameters: { customerId: "CUSTOMER-2" },
  }));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error.code, "RELAY_CUSTOMER_NOT_ALLOWED");
  assert.equal(calls, 0);
});

test("token IXC nunca é retornado", async () => {
  const app = appWith(async () => Response.json({ type: "error", message: `token inválido ${apiToken}` }));
  const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  assert.equal((await response.text()).includes(apiToken), false);
});

test("token IXC nunca é registrado", async () => {
  const logs = [];
  const app = appWith(async () => Response.json({ type: "error", message: `token inválido ${apiToken}` }), {}, logs);
  await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  assert.equal(JSON.stringify(logs).includes(apiToken), false);
});

test("timeout IXC retorna código sanitizado", async () => {
  const app = appWith(async () => { throw new DOMException("timeout", "AbortError"); });
  const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  assert.equal(response.status, 504);
  assert.equal((await json(response)).error.code, "IXC_TIMEOUT");
});

for (const status of [429, 500]) {
  test(`HTTP ${status} do IXC é normalizado`, async () => {
    const app = appWith(async () => new Response("sensível", { status }));
    const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
      operation: "testConnection", parameters: {},
    }));
    assert.equal(response.status, 503);
    assert.equal((await json(response)).error.code, `IXC_HTTP_${status}`);
  });
}

for (const [message, code] of [
  ["Token inválido para login", "IXC_AUTHENTICATION_FAILED"],
  ["Seu IP não está liberado para efetuar login", "IXC_IP_NOT_ALLOWED"],
  ["Usuário sem permissão", "IXC_PERMISSION_DENIED"],
]) {
  test(`${code} é preservado sem mensagem crua`, async () => {
    const app = appWith(async () => Response.json({ type: "error", message }));
    const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
      operation: "testConnection", parameters: {},
    }));
    const result = await json(response);
    assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes(message), false);
  });
}

test("resposta IXC inválida falha fechada", async () => {
  const app = appWith(async () => Response.json({ registros: "não-array" }));
  const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  assert.equal(response.status, 502);
  assert.equal((await json(response)).error.code, "IXC_RESPONSE_INVALID");
});

test("resposta IXC vazia vira lista vazia válida", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  assert.deepEqual((await json(response)).data, []);
});

test("circuit breaker abre após três falhas", async () => {
  let calls = 0;
  const app = appWith(async () => { calls += 1; return new Response("", { status: 500 }); });
  for (let index = 0; index < 3; index += 1) {
    await app.fetch(signedRequest("/v1/ixc/test-connection", {
      operation: "testConnection", parameters: {},
    }));
  }
  const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  assert.equal((await json(response)).error.code, "RELAY_CIRCUIT_OPEN");
  assert.equal(calls, 3);
});

test("rate limit bloqueia excesso sem chamar IXC", async () => {
  let calls = 0;
  const app = appWith(async () => { calls += 1; return Response.json({ registros: [] }); }, {
    IXC_RATE_LIMIT_PER_MINUTE: "1",
  });
  await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  const response = await app.fetch(signedRequest("/v1/ixc/test-connection", {
    operation: "testConnection", parameters: {},
  }));
  assert.equal(response.status, 429);
  assert.equal((await json(response)).error.code, "RELAY_RATE_LIMITED");
  assert.equal(calls, 1);
});

test("limite de corpo é aplicado antes da autenticação", async () => {
  const app = appWith(async () => Response.json({ registros: [] }), {
    IXC_RELAY_MAX_BODY_BYTES: "1024",
  });
  const response = await app.fetch(new Request("https://relay.invalid/v1/ixc/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(1025),
  }));
  assert.equal(response.status, 413);
});

test("JSON inválido é recusado", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", "{invalid"));
  assert.equal(response.status, 400);
  assert.equal((await json(response)).error.code, "RELAY_JSON_INVALID");
});

test("Content-Type inválido é recusado", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read", "{}", { contentType: "text/plain" }));
  assert.equal(response.status, 415);
});

test("query string arbitrária é recusada", async () => {
  const app = appWith(async () => Response.json({ registros: [] }));
  const response = await app.fetch(signedRequest("/v1/ixc/read?url=https%3A%2F%2Finternal.invalid", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { canonicalPath: "/v1/ixc/read" }));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error.code, "RELAY_FIELD_FORBIDDEN");
});

test("escrita permanece bloqueada mesmo com configuração incorreta", () => {
  assert.throws(() => config({ IXC_WRITE_ENABLED: "true" }), /RELAY_WRITE_MUST_REMAIN_DISABLED/);
  assert.throws(() => config({ FEATURE_IXC_WRITE: "true" }), /RELAY_WRITE_MUST_REMAIN_DISABLED/);
});

test("serviço sem segredo não inicia", () => {
  assert.throws(() => config({ IXC_RELAY_HMAC_SECRET: "" }), /RELAY_HMAC_SECRET_REQUIRED/);
});

test("healthcheck não consulta IXC e não revela configuração", async () => {
  let calls = 0;
  const app = appWith(async () => { calls += 1; return Response.json({ registros: [] }); });
  const response = await app.fetch(new Request("https://relay.invalid/healthz"));
  assert.deepEqual(await json(response), { status: "ok" });
  assert.equal(calls, 0);
});

test("readyz valida configuração sem consultar IXC", async () => {
  let calls = 0;
  const app = appWith(async () => { calls += 1; return Response.json({ registros: [] }); });
  const response = await app.fetch(new Request("https://relay.invalid/readyz"));
  assert.deepEqual(await json(response), { status: "ok" });
  assert.equal(calls, 0);
});

test("logs são sanitizados e não contêm payload ou PII", async () => {
  const logs = [];
  const app = appWith(async () => Response.json({ registros: [{ cpf: "12345678901", nome: "Cliente Completo" }] }), {}, logs);
  const correlationId = "corr-log-preserved-001";
  await app.fetch(signedRequest("/v1/ixc/read", {
    operation: "getCustomer", parameters: { customerId: "CUSTOMER-1" },
  }, { correlationId }));
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("12345678901"), false);
  assert.equal(serialized.includes("Cliente Completo"), false);
  assert.equal(serialized.includes("CF-Access"), false);
  assert.equal(logs[0].correlationId, correlationId);
});
