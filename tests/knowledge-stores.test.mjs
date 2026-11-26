import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_SOURCE_LIMIT } from "../lib/platform/doubt-bot-service.ts";
import { sanitizeHandoffText } from "../lib/agent/handoff.ts";
import { findSources, intentTerms } from "../lib/platform/copilot-service.ts";

// O working copy no Windows pode estar com CRLF; o arquivo versionado (e o que o Railway aplica) é LF.
const sql = (file) => readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const literal = (text, pattern) => pattern.exec(text)?.[1].replace(/''/g, "'");
const original = literal(sql("0028_kb_lojas_por_cidade.sql"), /'Atendimento', '((?:[^']|'')*)', 'published'/);
const update = sql("0029_kb_lojas_onze_cidades.sql");
const content = literal(update, /"content" = '((?:[^']|'')*)',\n/);
const expected = literal(update, /AND "content" = '((?:[^']|'')*)';/);

test("a atualização das lojas só troca o documento que ainda é o de 0028", () => {
  assert.ok(original && expected);
  assert.equal(expected, original, "o WHERE precisa casar com o texto exato de 0028, senão a migração não muda nada");
});

test("o documento das lojas cabe inteiro no que o modo autônomo manda e não tem telefone", () => {
  assert.ok(content.length <= AGENT_SOURCE_LIMIT, `${content.length} caracteres: as últimas cidades seriam cortadas`);
  assert.equal(sanitizeHandoffText(content), content, "telefone de loja não entra: o robô recusaria a resposta");
  for (const city of ["Areia Branca", "Campo do Brito", "Capela", "Frei Paulo", "Macambira", "Moita Bonita", "Nossa Senhora Aparecida",
    "Nossa Senhora da Glória", "Nossa Senhora das Dores", "Ribeirópolis", "São Domingos"]) assert.match(content, new RegExp(`^${city}: `, "m"), city);
});

test("quem diz a cidade ou pergunta onde fica a loja recebe o documento das lojas", () => {
  const docs = [
    { id: "kb-lojas-por-cidade", title: "Onde fica a loja da BBNET em cada cidade (endereço)", category: "Atendimento", content, status: "published", version: 2 },
    { id: "kb-padrao-senha-wifi", title: "Trocar a senha ou o nome da rede Wi-Fi", category: "Suporte técnico", content: "A troca da senha ou do nome da rede Wi-Fi não é feita pelo aplicativo nem por mensagem: traga o roteador e a fonte até a loja da BBNET da sua cidade, ou peça por aqui uma visita técnica.", status: "published", version: 2 },
    { id: "kb-padrao-sem-conexao", title: "Cliente sem conexão", category: "Suporte técnico", content: "Sem internet: confira as luzes e reinicie.", status: "published", version: 1 },
  ];
  for (const [text, intent] of [["sou de moita bonita", "technical_wifi"], ["moro em ribeiropolis", "technical_wifi"], ["aqui é de dores", "general_information"],
    ["sou da gloria", "general_information"], ["onde fica a loja de vocês?", "general_information"], ["quero trocar a senha do wifi", "technical_wifi"],
    ["onde é a loja de Capela?", "general_information"], ["Moro em São Domingos, e aí?", "general_information"]]) {
    const hint = intent === "general_information" ? "" : intentTerms(intent);
    assert.ok(findSources(docs, text, hint).slice(0, 2).some((source) => source.id === "kb-lojas-por-cidade"), text);
  }
});

test("pontuação na ponta da palavra não esconde o termo; hífen no meio continua", () => {
  const docs = [
    { id: "a", title: "Trocar a senha do Wi-Fi", category: "Suporte técnico", content: "Senha do Wi-Fi.", status: "published", version: 1 },
    { id: "b", title: "Fatura", category: "Financeiro", content: "Segunda via da fatura.", status: "published", version: 1 },
  ];
  assert.equal(findSources(docs, "segunda via da fatura?")[0]?.id, "b");
  assert.equal(findSources(docs, "como troco a senha do wi-fi?!")[0]?.id, "a");
});
