import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentHomologationForbiddenError,
  runTrustedAgentHomologation,
} from "../lib/agent/homologation.ts";
import { loadRuntimeConfig } from "../lib/runtime/environment.ts";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("route-security", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function publicAgent({ body, query = "", headers = {} }) {
  return worker.fetch(new Request(`http://localhost/api/agent${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env, ctx);
}

const enabledTestRuntime = {
  LZR_ENV: "test",
  IXC_MODE: "disabled",
  IXC_WRITE_ENABLED: "false",
  FEATURE_IXC_WRITE: "false",
  FEATURE_AGENT_HOMOLOGATION_PROFILES: "true",
};

test("rota pública funciona sem perfil e deriva channel web", async () => {
  const response = await publicAgent({ body: { message: "Minha internet está lenta" } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.channel, "web");
  assert.equal(result.intent, "technical_slow");
  assert.equal(result.actionExecuted, false);
});

for (const simulationProfile of [
  "payment_recognized",
  "regional_incident",
  "onu_offline",
  "contract_blocked",
  "tool_timeout",
]) {
  test(`rota pública bloqueia perfil ${simulationProfile}`, async () => {
    const response = await publicAgent({ body: { message: "Já paguei", simulationProfile } });
    assert.equal(response.status, 403);
    const result = await response.json();
    assert.equal(result.errorCode, "UNTRUSTED_AGENT_CONTEXT");
    assert.equal(JSON.stringify(result).includes("pagamento reconhecido"), false);
  });
}

test("perfil inválido também é rejeitado de forma controlada", async () => {
  const response = await publicAgent({ body: { message: "Teste", simulationProfile: "inventado" } });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Contexto operacional não autorizado",
    errorCode: "UNTRUSTED_AGENT_CONTEXT",
  });
});

test("query string não pode selecionar perfil ou canal", async () => {
  for (const query of [
    "?simulationProfile=onu_offline",
    "?simulation_profile=tool_timeout",
    "?channel=test",
  ]) {
    const response = await publicAgent({ body: { message: "Estou sem internet" }, query });
    assert.equal(response.status, 403);
  }
});

test("headers não confiáveis não podem selecionar perfil ou canal", async () => {
  for (const [header, value] of [
    ["x-agent-simulation-profile", "onu_offline"],
    ["x-simulation-profile", "regional_incident"],
    ["x-agent-channel", "test"],
    ["x-internal-channel", "homologation"],
  ]) {
    const response = await publicAgent({ body: { message: "Estou sem internet" }, headers: { [header]: value } });
    assert.equal(response.status, 403);
    const result = await response.json();
    assert.equal(result.errorCode, "UNTRUSTED_AGENT_CONTEXT");
  }
});

test("channel e contexto operacional no corpo são rejeitados", async () => {
  for (const body of [
    { message: "Teste", channel: "test" },
    { message: "Teste", environment: "staging" },
    { message: "Teste", agentContext: { channel: "internal" } },
  ]) {
    const response = await publicAgent({ body });
    assert.equal(response.status, 403);
  }
});

test("feature flag é false por padrão e valor inválido falha fechado", () => {
  assert.equal(loadRuntimeConfig({ LZR_ENV: "test", IXC_MODE: "disabled" }).agentHomologationProfilesEnabled, false);
  assert.throws(
    () => loadRuntimeConfig({ LZR_ENV: "test", IXC_MODE: "disabled", FEATURE_AGENT_HOMOLOGATION_PROFILES: "yes" }),
    /FEATURE_AGENT_HOMOLOGATION_PROFILES inválida/,
  );
});

test("executor interno bloqueia quando flag está desabilitada", () => {
  assert.throws(
    () => runTrustedAgentHomologation({
      message: "Já paguei",
      simulationProfile: "payment_recognized",
      runtimeSource: { LZR_ENV: "test", IXC_MODE: "disabled" },
    }),
    AgentHomologationForbiddenError,
  );
});

test("produção bloqueia homologação mesmo com flag true", () => {
  const production = {
    LZR_ENV: "production",
    IXC_MODE: "disabled",
    FEATURE_AGENT_HOMOLOGATION_PROFILES: "true",
  };
  assert.equal(loadRuntimeConfig(production).agentHomologationProfilesEnabled, false);
  assert.throws(
    () => runTrustedAgentHomologation({ message: "Já paguei", simulationProfile: "payment_recognized", runtimeSource: production }),
    AgentHomologationForbiddenError,
  );
});

test("executor interno autorizado funciona apenas em local, test e staging", () => {
  for (const environment of ["local", "test", "staging"]) {
    const result = runTrustedAgentHomologation({
      message: "Estou sem internet",
      simulationProfile: "onu_offline",
      runtimeSource: { ...enabledTestRuntime, LZR_ENV: environment },
    });
    assert.equal(result.channel, "homologation");
    assert.equal(result.actionExecuted, false);
    assert.ok(result.tools.some((tool) => tool.tool === "network.onu_status"));
  }
});

test("erro de autorização não expõe flag, ambiente ou segredo", async () => {
  const response = await publicAgent({
    body: { message: "Teste", simulationProfile: "onu_offline" },
    headers: { "x-staging-job-secret": "valor-que-nao-pode-vazar" },
  });
  assert.equal(response.status, 403);
  const text = await response.text();
  assert.doesNotMatch(text, /valor-que-nao-pode-vazar|FEATURE_AGENT|LZR_ENV|STAGING_JOB_SECRET/);
});

test("proteções de escrita permanecem desligadas", () => {
  const config = loadRuntimeConfig({
    ...enabledTestRuntime,
    IXC_WRITE_ENABLED: "false",
    FEATURE_IXC_WRITE: "false",
  });
  assert.equal(config.writeEnabled, false);
});
