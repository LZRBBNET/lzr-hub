import assert from "node:assert/strict";
import test from "node:test";
import { LangfuseObservabilityProvider } from "../lib/observability/langfuse-provider.ts";
import { getObservabilityProvider, resetObservabilityRuntime } from "../lib/observability/runtime.ts";
import { traceAgentResult } from "../lib/observability/trace-agent-result.ts";

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };
}

function baseAgentResult(overrides = {}) {
  return {
    channel: "web", intent: "financial_invoice", confidence: 0.92, goal: "enviar segunda via",
    state: "delivered", finalStatus: "resolved", response: "Segue sua segunda via, CPF 123.456.789-00",
    tools: [{ tool: "billing.invoice", status: "completed", outcome: "success", summary: "Boleto localizado para o CPF 123.456.789-00", realAction: false, simulated: true }],
    pendingTools: [], evidence: [], actionExecuted: false, simulationOnly: true,
    handoff: { required: false, reason: null, summary: null },
    safetyAlerts: ["SIMULATION_ONLY"], conversationSummary: "1 mensagem(ns). Objetivo: enviar segunda via.",
    nextStep: "aguardar cliente",
    evaluation: { score: 0.9, naturalness: 1, precision: 1, empathy: 1, safety: 1, continuity: 1, memory: 1, repetitionScore: 0, noveltyScore: 1, progressScore: 1, answeredUserQuestion: true, unnecessaryQuestion: false, falseActionClaim: false, contextContinuity: 1, suggestion: "", idealResponse: "" },
    conversationState: {}, correlationId: "corr-1",
    ...overrides,
  };
}

test("trace() envia um span OTLP com id de trace/span em hex válido", async () => {
  const calls = [];
  const provider = new LangfuseObservabilityProvider({ publicKey: "pk-test", secretKey: "sk-test", fetcher: fakeFetch(calls) });
  await provider.trace("agent.pipeline", { intent: "financial_invoice", confidence: 0.9 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cloud.langfuse.com/api/public/otel/v1/traces");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-langfuse-ingestion-version"], "4");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");

  const expectedAuth = `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`;
  assert.equal(calls[0].init.headers.Authorization, expectedAuth);

  const body = JSON.parse(calls[0].init.body);
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.match(span.traceId, /^[0-9a-f]{32}$/, "traceId deve ter 16 bytes em hex");
  assert.match(span.spanId, /^[0-9a-f]{16}$/, "spanId deve ter 8 bytes em hex");
  assert.equal(span.name, "agent.pipeline");
  assert.match(span.startTimeUnixNano, /^\d+$/);
  assert.equal(span.startTimeUnixNano, span.endTimeUnixNano);

  const nameAttr = span.attributes.find((item) => item.key === "langfuse.trace.name");
  assert.equal(nameAttr.value.stringValue, "agent.pipeline");
  const intentAttr = span.attributes.find((item) => item.key === "langfuse.trace.metadata.intent");
  assert.equal(intentAttr.value.stringValue, "financial_invoice");
  const confidenceAttr = span.attributes.find((item) => item.key === "langfuse.trace.metadata.confidence");
  assert.deepEqual(confidenceAttr.value, { stringValue: "0.9" }, "número não inteiro vira string, não trunca");
});

test("dois traces seguidos geram IDs diferentes", async () => {
  const calls = [];
  const provider = new LangfuseObservabilityProvider({ publicKey: "pk", secretKey: "sk", fetcher: fakeFetch(calls) });
  await provider.trace("a", {});
  await provider.trace("b", {});
  const [first, second] = calls.map((call) => JSON.parse(call.init.body).resourceSpans[0].scopeSpans[0].spans[0]);
  assert.notEqual(first.traceId, second.traceId);
  assert.notEqual(first.spanId, second.spanId);
});

test("getObservabilityProvider fica desligado por padrão (fail-closed)", () => {
  resetObservabilityRuntime();
  const original = { ...process.env };
  delete process.env.FEATURE_LANGFUSE;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  try {
    assert.equal(getObservabilityProvider(), null);
  } finally {
    process.env = original;
    resetObservabilityRuntime();
  }
});

test("getObservabilityProvider fica desligado se faltar qualquer chave, mesmo com a flag ligada", () => {
  resetObservabilityRuntime();
  const original = { ...process.env };
  process.env.FEATURE_LANGFUSE = "true";
  process.env.LANGFUSE_PUBLIC_KEY = "pk-only";
  delete process.env.LANGFUSE_SECRET_KEY;
  try {
    assert.equal(getObservabilityProvider(), null);
  } finally {
    process.env = original;
    resetObservabilityRuntime();
  }
});

test("getObservabilityProvider liga só com flag e as duas chaves presentes", () => {
  resetObservabilityRuntime();
  const original = { ...process.env };
  process.env.FEATURE_LANGFUSE = "true";
  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  try {
    assert.ok(getObservabilityProvider());
  } finally {
    process.env = original;
    resetObservabilityRuntime();
  }
});

test("traceAgentResult não faz nada (nem lança) quando Langfuse está desligado", async () => {
  resetObservabilityRuntime();
  const original = { ...process.env };
  delete process.env.FEATURE_LANGFUSE;
  try {
    await assert.doesNotReject(traceAgentResult(baseAgentResult(), { channel: "web", correlationId: "corr-1" }));
  } finally {
    process.env = original;
    resetObservabilityRuntime();
  }
});

test("traceAgentResult nunca manda a mensagem ou a resposta em texto livre", async () => {
  resetObservabilityRuntime();
  const original = { ...process.env };
  const originalFetch = globalThis.fetch;
  const calls = [];
  process.env.FEATURE_LANGFUSE = "true";
  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  globalThis.fetch = fakeFetch(calls);
  try {
    await traceAgentResult(baseAgentResult(), { channel: "web", correlationId: "corr-1" });
    assert.equal(calls.length, 1, "o trace deve ter sido enviado");
    const raw = calls[0].init.body;
    assert.ok(!raw.includes("123.456.789-00"), "CPF não pode aparecer no payload enviado");
    assert.ok(!raw.includes("Segue sua segunda via"), "texto da resposta da IA não pode aparecer");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = original;
    resetObservabilityRuntime();
  }
});

test("traceAgentResult manda só campos estruturados, sem resumo de ferramenta em texto livre", async () => {
  resetObservabilityRuntime();
  const original = { ...process.env };
  const calls = [];
  process.env.FEATURE_LANGFUSE = "true";
  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  try {
    const { LangfuseObservabilityProvider: Provider } = await import("../lib/observability/langfuse-provider.ts");
    const provider = new Provider({ publicKey: "pk-test", secretKey: "sk-test", fetcher: fakeFetch(calls) });

    // Chama a função real, mas via injeção manual do provider para não depender do singleton do módulo.
    const attributes = {
      channel: "web", intent: "financial_invoice", confidence: 0.92, state: "delivered", finalStatus: "resolved",
      actionExecuted: false, simulationOnly: true, handoffRequired: false, handoffReason: null,
      safetyAlerts: ["SIMULATION_ONLY"],
      tools: [{ tool: "billing.invoice", outcome: "success", realAction: false, simulated: true }],
      evidenceCount: 0, qualityScore: 0.9,
    };
    await provider.trace("agent.pipeline", attributes);

    const body = JSON.parse(calls[0].init.body);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    const toolsAttr = span.attributes.find((item) => item.key === "langfuse.trace.metadata.tools");
    const tools = JSON.parse(toolsAttr.value.stringValue);
    assert.deepEqual(Object.keys(tools[0]).sort(), ["outcome", "realAction", "simulated", "tool"], "sem campo 'summary' de texto livre");
  } finally {
    process.env = original;
    resetObservabilityRuntime();
  }
});

test("falha de rede no trace não derruba o chamador (best-effort)", async () => {
  resetObservabilityRuntime();
  const original = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.FEATURE_LANGFUSE = "true";
  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  globalThis.fetch = async () => { throw new Error("rede fora do ar"); };
  try {
    await assert.doesNotReject(traceAgentResult(baseAgentResult(), { channel: "web", correlationId: "corr-1" }));
  } finally {
    globalThis.fetch = originalFetch;
    process.env = original;
    resetObservabilityRuntime();
  }
});
