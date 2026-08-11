import test from "node:test";
import assert from "node:assert/strict";
import { fetchLangfuseCost, langfuseCostOptionsFromEnv, LangfuseCostError } from "../lib/observability/langfuse-cost.ts";

const opts = (over = {}) => ({ publicKey: "pk", secretKey: "sk", baseUrl: "https://us.cloud.langfuse.com", ...over });
const FROM = "2026-08-01T00:00:00.000Z", TO = "2026-08-08T00:00:00.000Z";
const ok = (body) => async () => new Response(JSON.stringify(body), { status: 200 });

test("lê o formato real da API v2 — count vem como string e é convertido", async () => {
  const result = await fetchLangfuseCost(opts({ fetcher: ok({ data: [{ sum_totalCost: 1.25, count_count: "130" }] }) }), FROM, TO);
  assert.deepEqual(result, { cost: 1.25, observations: 130 });
});

test("resposta sem linha nenhuma é zero medido, não erro", async () => {
  const result = await fetchLangfuseCost(opts({ fetcher: ok({ data: [] }) }), FROM, TO);
  assert.deepEqual(result, { cost: 0, observations: 0 });
});

test("401 aponta região/credencial, que é a causa mais comum", async () => {
  const fetcher = async () => new Response("{}", { status: 401 });
  await assert.rejects(fetchLangfuseCost(opts({ fetcher }), FROM, TO), /REGIAO_INCORRETA/);
});

test("erro HTTP não vira custo zero", async () => {
  const fetcher = async () => new Response("{}", { status: 500 });
  await assert.rejects(fetchLangfuseCost(opts({ fetcher }), FROM, TO), LangfuseCostError);
});

test("resposta com número inválido falha em vez de virar NaN na tela", async () => {
  const result = fetchLangfuseCost(opts({ fetcher: ok({ data: [{ sum_totalCost: "abc", count_count: "1" }] }) }), FROM, TO);
  await assert.rejects(result, /RESPOSTA_INESPERADA/);
});

test("usa o endpoint v2, não o metrics/daily deprecado", async () => {
  let calledUrl = "";
  const fetcher = async (url) => { calledUrl = String(url); return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
  await fetchLangfuseCost(opts({ fetcher }), FROM, TO);
  assert.match(calledUrl, /\/api\/public\/v2\/metrics/);
  assert.doesNotMatch(calledUrl, /metrics\/daily/);
});

test("configuração só existe com a flag ligada e as duas chaves", () => {
  assert.equal(langfuseCostOptionsFromEnv({ FEATURE_LANGFUSE: "false", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }), null);
  assert.equal(langfuseCostOptionsFromEnv({ FEATURE_LANGFUSE: "true", LANGFUSE_PUBLIC_KEY: "pk" }), null);
  const config = langfuseCostOptionsFromEnv({ FEATURE_LANGFUSE: "true", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com" });
  assert.equal(config?.baseUrl, "https://us.cloud.langfuse.com");
});
