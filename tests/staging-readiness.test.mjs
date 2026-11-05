import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessStagingReadiness, STAGING_FORBIDDEN_CREDENTIALS } from "../lib/runtime/staging-readiness.ts";
import { stagingDemoRequirements } from "../lib/runtime/staging-demo.ts";

const source = (extra = {}) => ({ ...stagingDemoRequirements, ...extra });
const root = fileURLToPath(new URL("../", import.meta.url));

test("configuração válida nunca equivale a produção ou homologação completa", () => {
  const r = assessStagingReadiness(source());
  assert.equal(r.status, "configuration_valid");
  assert.equal(r.scope, "configuration_only");
  assert.equal(r.readyForProduction, false);
  assert.equal(r.applicationAuth, "not_enforced");
  assert.equal(r.databaseConnectionConfigured, false);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.requiredEvidence, ["access_control", "synthetic_database", "runtime_environment", "no_real_delivery"]);
});

for (const variable of Object.keys(stagingDemoRequirements)) {
  test(`reporta ${variable} ausente ou divergente sem divulgar valor`, () => {
    for (const value of [undefined, "synthetic-private-marker", ""]) {
      const r = assessStagingReadiness(source({ [variable]: value }));
      assert.equal(r.status, "blocked");
      assert.deepEqual(r.blockers, [{ code: "CONFIG_MISMATCH", variable }]);
      assert.doesNotMatch(JSON.stringify(r), /synthetic-private-marker/);
    }
  });
}

for (const variable of STAGING_FORBIDDEN_CREDENTIALS) {
  test(`presença de ${variable} bloqueia mesmo com integração desligada`, () => {
    const r = assessStagingReadiness(source({ [variable]: "synthetic-credential-do-not-print\nother=data" }));
    assert.equal(r.status, "blocked");
    assert.deepEqual(r.blockers, [{ code: "EXTERNAL_CREDENTIAL_PRESENT", variable }]);
    assert.doesNotMatch(JSON.stringify(r), /synthetic-credential|other=data/);
    assert.equal(assessStagingReadiness(source({ [variable]: "  \n " })).status, "blocked");
    assert.equal(assessStagingReadiness(source({ [variable]: "" })).status, "configuration_valid");
  });
}

test("coleta todos os bloqueios em ordem estável", () => {
  const r = assessStagingReadiness(source({ FEATURE_N8N_CHANNEL: "true", GROQ_API_KEY: "synthetic-a", META_ACCESS_TOKEN: "synthetic-b", FEATURE_AUTH: "TRUE" }));
  assert.deepEqual(r.blockers, [
    { code: "CONFIG_MISMATCH", variable: "FEATURE_N8N_CHANNEL" },
    { code: "EXTERNAL_CREDENTIAL_PRESENT", variable: "GROQ_API_KEY" },
    { code: "EXTERNAL_CREDENTIAL_PRESENT", variable: "META_ACCESS_TOKEN" },
    { code: "INVALID_AUTH_FLAG", variable: "FEATURE_AUTH" },
  ]);
});

test("flag de login é informada sem inventar proteção externa ou sessão válida", () => {
  for (const [value, expected] of [[undefined, "not_enforced"], ["false", "not_enforced"], ["true", "required"]]) {
    const r = assessStagingReadiness(source({ FEATURE_AUTH: value }));
    assert.equal(r.applicationAuth, expected);
    assert.ok(r.requiredEvidence.includes("access_control"));
    assert.equal(r.readyForProduction, false);
  }
  for (const value of ["TRUE", "1", ""]) assert.equal(assessStagingReadiness(source({ FEATURE_AUTH: value })).status, "blocked");
});

test("URL de banco vira somente presença e nunca prova isolamento", () => {
  for (const variable of ["DATABASE_URL", "DATABASE_PUBLIC_URL"]) {
    const r = assessStagingReadiness(source({ [variable]: "postgres://synthetic:private-marker@fixture.invalid/db" }));
    assert.equal(r.databaseConnectionConfigured, variable === "DATABASE_URL");
    assert.ok(r.requiredEvidence.includes("synthetic_database"));
    assert.doesNotMatch(JSON.stringify(r), /postgres|fixture.invalid|private-marker/);
  }
});

test("não modifica ambiente nem usa flags de autodeclaração para aprovar acesso", () => {
  const input = Object.freeze(source({ STAGING_ACCESS_CONFIRMED: "true", STAGING_READY: "true", PRIVATE_NOTE: "synthetic-note" }));
  const r = assessStagingReadiness(input);
  assert.equal(r.readyForProduction, false);
  assert.ok(r.requiredEvidence.includes("access_control"));
  assert.doesNotMatch(JSON.stringify(r), /STAGING_ACCESS|STAGING_READY|PRIVATE_NOTE|synthetic-note/);
});

// Preserve explicit parent preloads (including an optional offline boundary)
// without inheriting environment variables or credentials into CLI fixtures.
const childPreloads = process.execArgv.flatMap((arg, index, args) =>
  arg === "--require" ? [arg, args[index + 1]] : arg.startsWith("--require=") ? [arg] : [],
);
function run(env) {
  return spawnSync(process.execPath, [...childPreloads, "--experimental-strip-types", "scripts/check-staging-readiness.mjs"], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
}

test("CLI válida sai zero, mantém evidências pendentes e não imprime ambiente", () => {
  const r = run(source({ PRIVATE_NOTE: "synthetic-private-output" }));
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, "configuration_valid");
  assert.equal(JSON.parse(r.stdout).readyForProduction, false);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-private-output/);
});

test("CLI com flag insegura e credencial fictícia sai um sem sanitizar a falha", () => {
  const r = run(source({ FEATURE_LLM_INTENT: "true", GROQ_API_KEY: "synthetic-secret-marker" }));
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers.map(b => b.variable), ["FEATURE_LLM_INTENT", "GROQ_API_KEY"]);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-secret-marker/);
});

test("CLI sem configuração falha e não carrega .env automaticamente", () => {
  const r = run({});
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.blockers.length, Object.keys(stagingDemoRequirements).length);
});
