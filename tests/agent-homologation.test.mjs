import assert from "node:assert/strict";
import test from "node:test";
import { runTrustedAgentHomologation } from "../lib/agent/homologation.ts";
import { homologationScenarios } from "../lib/agent/homologation-scenarios.ts";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("homologation", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const trustedTestRuntime = {
  LZR_ENV: "test",
  IXC_MODE: "disabled",
  IXC_WRITE_ENABLED: "false",
  FEATURE_IXC_WRITE: "false",
  FEATURE_AGENT_HOMOLOGATION_PROFILES: "true",
};

async function executeScenario(scenario) {
  const url = "http://localhost/api/agent";
  if (scenario.requestVariant === "invalid_json") {
    return worker.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), env, ctx);
  }
  if (scenario.requestVariant === "normal") {
    const result = runTrustedAgentHomologation({
      message: scenario.messages.at(-1),
      history: scenario.history,
      simulationProfile: scenario.simulationProfile,
      runtimeSource: trustedTestRuntime,
    });
    return { status: 200, json: async () => result };
  }
  const history = scenario.requestVariant === "malformed_history"
    ? [{ role: "system", content: "conteúdo inválido" }]
    : scenario.history;
  return worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: scenario.messages.at(-1),
      history,
    }),
  }), env, ctx);
}

for (const scenario of homologationScenarios) {
  test(`${scenario.id} — ${scenario.title}`, async () => {
    const response = await executeScenario(scenario);
    assert.equal(response.status, scenario.expectedHttpStatus, `${scenario.id}: status HTTP`);
    if (scenario.expectedHttpStatus !== 200) return;

    const result = await response.json();
    assert.equal(result.intent, scenario.expectedIntent, `${scenario.id}: intenção`);
    assert.equal(result.actionExecuted, false, `${scenario.id}: nenhuma ação externa real`);
    assert.equal(result.evaluation.falseActionClaim, false, `${scenario.id}: sem confirmação falsa`);
    assert.ok((result.response.match(/\?/g) ?? []).length <= 1, `${scenario.id}: no máximo uma pergunta`);

    if (scenario.allowedTool) {
      const receipt = result.tools.find((tool) => tool.tool === scenario.allowedTool);
      assert.ok(receipt, `${scenario.id}: ferramenta ${scenario.allowedTool}`);
      if (scenario.expectedToolOutcome) assert.equal(receipt.outcome, scenario.expectedToolOutcome, `${scenario.id}: resultado da ferramenta`);
    }
    for (const tool of scenario.forbiddenTools) {
      assert.equal(result.tools.some((receipt) => receipt.tool === tool), false, `${scenario.id}: ferramenta proibida ${tool}`);
    }
    if (scenario.evidenceRequired) assert.ok(result.evidence.length > 0, `${scenario.id}: evidência obrigatória`);
    for (const term of scenario.allowedResponseTerms) assert.match(result.response, new RegExp(term, "i"), `${scenario.id}: termo permitido`);
    for (const claim of scenario.forbiddenAssertions) assert.doesNotMatch(result.response, new RegExp(claim, "i"), `${scenario.id}: afirmação proibida`);
    if (scenario.needsQuestion) assert.ok(result.response.includes("?"), `${scenario.id}: pergunta complementar`);
    assert.equal(result.handoff.required, scenario.needsHandoff, `${scenario.id}: transbordo`);
    if (scenario.handoffReason) assert.equal(result.handoff.reason, scenario.handoffReason, `${scenario.id}: motivo do transbordo`);
    if (scenario.expectedFinalStatus) assert.equal(result.finalStatus, scenario.expectedFinalStatus, `${scenario.id}: status final`);

    for (const receipt of result.tools.filter((tool) => tool.status === "failed")) {
      assert.equal(receipt.evidence, undefined, `${scenario.id}: falha não produz evidência`);
      assert.ok(!["resolved", "simulated"].includes(result.finalStatus), `${scenario.id}: falha não vira sucesso`);
      assert.match(result.response, /não|nao|falh|indispon|revisão|revisao|segurança|seguranca/i, `${scenario.id}: falha é comunicada`);
    }
    if (result.simulationOnly) assert.match(result.response, /homologa|simulad|fictíci|fictici|nenhuma .*real|sem executar|prepar/i, `${scenario.id}: simulação identificada`);
  });
}

// A matriz original (issue #3) certificou 60 cenários — ver
// docs/issue-3-agent-pipeline-homologation-report.md, registro histórico de
// uma revisão já fechada, que não deve ser reescrito. B29 (pedido de desconto,
// issue #16) estendeu a matriz depois dessa certificação; o teto sobe junto.
test("matriz contém exatamente os 61 cenários obrigatórios e IDs únicos", () => {
  assert.equal(homologationScenarios.length, 61);
  assert.equal(new Set(homologationScenarios.map((scenario) => scenario.id)).size, 61);
});

test("timeout, erro, vazio, parcial, proibido e modo demonstrativo nunca viram sucesso real", async () => {
  const profiles = ["tool_timeout", "tool_error", "tool_empty", "tool_contradictory", "tool_unavailable"];
  for (const simulationProfile of profiles) {
    const result = runTrustedAgentHomologation({
      message: "Estou sem internet",
      simulationProfile,
      runtimeSource: trustedTestRuntime,
    });
    assert.equal(result.actionExecuted, false);
    assert.equal(result.handoff.required, true);
    assert.ok(!["resolved", "simulated"].includes(result.finalStatus));
    assert.equal(result.evaluation.falseActionClaim, false);
  }

  const demo = runTrustedAgentHomologation({
    message: "Abra um chamado",
    simulationProfile: "default",
    runtimeSource: trustedTestRuntime,
  });
  assert.equal(demo.actionExecuted, false);
  assert.equal(demo.simulationOnly, true);
  assert.match(demo.response, /homologação|simulado|fictício|nenhuma ordem real/i);
});

test("resumo de transbordo remove documento, telefone e e-mail", async () => {
  const response = await worker.fetch(new Request("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Quero humano. CPF 123.456.789-01, telefone 79999999999, nome@example.invalid",
    }),
  }), env, ctx);
  const result = await response.json();
  assert.equal(result.handoff.required, true);
  assert.doesNotMatch(result.conversationSummary, /123\.456\.789-01|79999999999|nome@example\.invalid/);
  assert.match(result.conversationSummary, /REDACTED/);
});

test("histórico acima de 40 mensagens é truncado sem perder a mensagem atual", async () => {
  const longHistory = Array.from({ length: 45 }, (_, index) => ({ role: index % 2 ? "agent" : "customer", content: `Mensagem fictícia ${index}` }));
  const response = await worker.fetch(new Request("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Quero o PIX", history: longHistory }),
  }), env, ctx);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.intent, "financial_pix");
  assert.equal(result.channel, "web");
  assert.match(result.conversationSummary, /41 mensagem/);
});
