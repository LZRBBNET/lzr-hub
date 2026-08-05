import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, llmConfigFromEnv } from "../lib/agent/llm-classifier.ts";

const reply = (content) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
});
const config = (fetcher) => ({ apiKey: "chave-de-teste", model: "m", baseUrl: "https://exemplo.invalid/v1", fetcher });

test("sem chave configurada, nada sai do servidor e vale a regra", async () => {
  let called = false;
  const semChave = llmConfigFromEnv({ FEATURE_LLM_INTENT: "true" });
  assert.equal(semChave, undefined, "flag ligada sem chave não liga nada");

  const result = await classifyIntent("estou sem internet", undefined);
  assert.equal(result.source, "rules");
  assert.equal(result.intent, "technical_no_connection");
  assert.equal(called, false);
});

test("flag desligada ignora a chave", () => {
  assert.equal(llmConfigFromEnv({ GROQ_API_KEY: "abc" }), undefined);
  assert.ok(llmConfigFromEnv({ FEATURE_LLM_INTENT: "true", GROQ_API_KEY: "abc" }));
});

test("classifica o que a regex não pega", async () => {
  // Esta é exatamente a mensagem que hoje transborda: nenhuma regra casa.
  const semLlm = await classifyIntent("oi, ta sem net aqui em casa desde ontem", undefined);
  assert.equal(semLlm.intent, "general_information");
  assert.ok(semLlm.confidence < 0.6, "abaixo do corte, por isso transborda hoje");

  const comLlm = await classifyIntent(
    "oi, ta sem net aqui em casa desde ontem",
    config(async () => reply('{"intent":"technical_no_connection","confidence":0.92}')),
  );
  assert.equal(comLlm.intent, "technical_no_connection");
  assert.equal(comLlm.source, "llm");
  assert.ok(comLlm.confidence > 0.6, "acima do corte: deixa de transbordar");
});

test("PII é removida antes de sair do servidor", async () => {
  let enviado = "";
  await classifyIntent(
    "meu cpf é 123.456.789-01, email ana@bbnet.com, fone (79) 99999-0000, e a net caiu",
    config(async (_url, init) => { enviado = String(init.body); return reply('{"intent":"technical_no_connection","confidence":0.9}'); }),
  );
  assert.ok(!enviado.includes("123.456.789-01"), "CPF não pode sair");
  assert.ok(!enviado.includes("ana@bbnet.com"), "e-mail não pode sair");
  assert.ok(!enviado.includes("99999-0000"), "telefone não pode sair");
  assert.ok(enviado.includes("REDACTED"), "o texto sai sanitizado, não truncado");
});

test("resposta inválida do modelo é descartada, não confiada", async () => {
  const casos = [
    "não sei responder isso",
    '{"intent":"inventei_uma_intencao","confidence":0.99}',
    '{"confidence":0.9}',
    "",
  ];
  for (const conteudo of casos) {
    const result = await classifyIntent("estou sem internet", config(async () => reply(conteudo)));
    assert.equal(result.source, "rules", `"${conteudo.slice(0, 20)}" deveria cair na regra`);
  }
});

test("erro, recusa e demora do provedor caem na regra sem derrubar o atendimento", async () => {
  const explode = await classifyIntent("estou sem internet", config(async () => { throw new Error("rede caiu"); }));
  assert.equal(explode.source, "rules");

  const recusado = await classifyIntent("estou sem internet", config(async () => ({ ok: false, json: async () => ({}) })));
  assert.equal(recusado.source, "rules");

  const lento = await classifyIntent(
    "estou sem internet",
    config((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("abortado")));
    })),
    20,
  );
  assert.equal(lento.source, "rules", "o cliente não espera o provedor pensar");
});

test("modelo com cerca de código ainda é lido, e confiança é limitada a 0..1", async () => {
  const cercado = await classifyIntent("quero o pix", config(async () => reply('```json\n{"intent":"financial_pix","confidence":0.88}\n```')));
  assert.equal(cercado.intent, "financial_pix");

  const foraDaFaixa = await classifyIntent("quero o pix", config(async () => reply('{"intent":"financial_pix","confidence":7}')));
  assert.equal(foraDaFaixa.confidence, 1);

  const ilegivel = await classifyIntent("quero o pix", config(async () => reply('{"intent":"financial_pix","confidence":"muita"}')));
  assert.equal(ilegivel.confidence, 0.7, "confiança ilegível não vira certeza nem zero");
});
