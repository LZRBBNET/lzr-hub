import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadStagingDemoConfig, stagingDemoHealth, stagingDemoRequirements } from "../lib/runtime/staging-demo.ts";
import { llmConfigFromEnv } from "../lib/agent/llm-classifier.ts";
import { copilotLlmConfigFromEnv } from "../lib/platform/copilot-service.ts";
import { attendantReplyEnabled } from "../lib/platform/attendant-reply-service.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const extraFlags = ["FEATURE_N8N_AUTOREPLY", "FEATURE_ATTENDANT_REPLY", "FEATURE_LLM_INTENT", "FEATURE_COPILOT_LLM", "FEATURE_TELEGRAM_ALERTS"];
const allFlags = [...new Set([...Object.keys(stagingDemoRequirements).filter(key => key.startsWith("FEATURE_")), ...extraFlags])];
const envFile = async () => Object.fromEntries((await readFile(new URL("../.env.staging.example", import.meta.url), "utf8")).split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => line.split(/=(.*)/s).slice(0, 2)));
const isolatedEnv = (override = {}) => ({ PATH: process.env.PATH, ...override });

function throughScript(inherited = {}, keys = [...Object.keys(stagingDemoRequirements), ...extraFlags, "FEATURE_AUTH"]) {
  const result = spawnSync("bash", ["scripts/staging-env.sh", process.execPath, "-e", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`], {
    cwd: root, env: isolatedEnv(inherited), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const flag of extraFlags) {
  test(`demo recusa ${flag} ativa, ausente ou inválida`, () => {
    for (const value of ["true", undefined, "TRUE", "1", ""]) {
      const source = { ...stagingDemoRequirements, [flag]: value };
      assert.throws(() => loadStagingDemoConfig(source), new RegExp(flag));
      assert.equal(stagingDemoHealth(source).status, "degraded");
    }
  });
}

test("wrapper neutraliza todas as flags externas mesmo quando herdadas true", () => {
  const source = throughScript(Object.fromEntries(allFlags.map(flag => [flag, "true"])));
  for (const flag of allFlags) assert.equal(source[flag], "false", flag);
  assert.doesNotThrow(() => loadStagingDemoConfig(source));
});

test("wrapper também produz configuração completa em ambiente limpo", () => {
  const source = throughScript();
  assert.doesNotThrow(() => loadStagingDemoConfig(source));
  for (const flag of extraFlags) assert.equal(source[flag], "false");
});

test("exemplo de ambiente inclui desligamento explícito dos novos caminhos", async () => {
  const source = await envFile();
  for (const flag of extraFlags) assert.equal(source[flag], "false", flag);
  assert.doesNotThrow(() => loadStagingDemoConfig(source));
});

test("wrapper não muda a escolha de autenticação do ambiente", () => {
  for (const expected of ["true", "false"]) assert.equal(throughScript({ FEATURE_AUTH: expected }).FEATURE_AUTH, expected);
  assert.equal(throughScript().FEATURE_AUTH, null);
});

test("configuradores LLM ficam desligados com flags herdadas e chave fictícia", () => {
  const source = throughScript({ FEATURE_LLM_INTENT: "true", FEATURE_COPILOT_LLM: "true" });
  source.GROQ_API_KEY = "synthetic-fixture-not-a-real-key";
  assert.equal(llmConfigFromEnv(source), undefined);
  assert.equal(copilotLlmConfigFromEnv(source), undefined);
});

test("envio de atendente fica desligado depois do wrapper", () => {
  assert.equal(attendantReplyEnabled(throughScript({ FEATURE_ATTENDANT_REPLY: "true" })), false);
});

test("wrapper conserva limites de IXC, piloto e runtime", () => {
  const source = throughScript({ LZR_ENV: "production", NEXT_PUBLIC_LZR_ENV: "production", LZR_RUNTIME_MODE: "real", IXC_MODE: "staging-readonly", IXC_TRANSPORT: "http", IXC_WRITE_ENABLED: "true", PILOT_MODE: "internal" });
  assert.deepEqual(loadStagingDemoConfig(source), { environment: "staging", runtimeMode: "mock", ixc: "disabled", externalWrites: false });
});

test("health recusado não expõe valores ou credenciais fictícias", () => {
  const output = stagingDemoHealth({ ...stagingDemoRequirements, FEATURE_COPILOT_LLM: "true", GROQ_API_KEY: "synthetic-key-must-not-appear" });
  assert.equal(output.status, "degraded");
  assert.doesNotMatch(JSON.stringify(output), /synthetic-key|GROQ|FEATURE_COPILOT/);
});

test("wrapper preserva argumentos e saída do comando, sem iniciar serviço", () => {
  const r = spawnSync("bash", ["scripts/staging-env.sh", process.execPath, "-e", "process.stdout.write(process.argv[1]); process.exit(7)", "fixture com espaços"], { cwd: root, env: isolatedEnv(), encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 7);
  assert.equal(r.stdout, "fixture com espaços");
});
