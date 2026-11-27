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
// Cada atualização só troca o texto se ele ainda for o da migração anterior; a última é o que o cliente vê.
const updates = ["0029_kb_lojas_onze_cidades.sql", "0030_kb_lojas_itabaiana.sql"].map((file) => {
  const text = sql(file);
  return { file, content: literal(text, /"content" = '((?:[^']|'')*)',\n/), expected: literal(text, /AND "content" = '((?:[^']|'')*)';/) };
});
const content = updates.at(-1).content;

test("cada atualização das lojas só troca o documento que ainda é o da migração anterior", () => {
  let current = original;
  for (const update of updates) {
    assert.ok(current && update.expected && update.content, update.file);
    assert.equal(update.expected, current, `${update.file}: o WHERE precisa casar com o texto exato anterior, senão não muda nada`);
    current = update.content;
  }
});

test("o documento das lojas cabe inteiro no que o modo autônomo manda e não tem telefone", () => {
  assert.ok(content.length <= AGENT_SOURCE_LIMIT, `${content.length} caracteres: as últimas cidades seriam cortadas`);
  assert.equal(sanitizeHandoffText(content), content, "telefone de loja não entra: o robô recusaria a resposta");
  for (const city of ["Areia Branca", "Campo do Brito", "Capela", "Frei Paulo", "Macambira", "Moita Bonita", "Nossa Senhora Aparecida",
    "Nossa Senhora da Glória", "Nossa Senhora das Dores", "Ribeirópolis", "São Domingos"]) assert.match(content, new RegExp(`^${city}: `, "m"), city);
  assert.match(content, /^Itabaiana: não tem loja/m, "sem a linha, quem é de Itabaiana podia ir parar na loja de Frei Paulo (Rua Itabaiana)");
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

test("planos e valores: a atualização casa com o texto da 0022, cabe no limite, sem telefone, com os 5 planos", () => {
  const text = sql("0031_kb_planos_valores.sql");
  const seed = literal(sql("0022_seed_knowledge_base.sql"), /\('kb-padrao-planos', '[^']*', 'Comercial', '((?:[^']|'')*)', 'published'/);
  const plans = literal(text, /"content" = '((?:[^']|'')*)',\n/);
  assert.equal(literal(text, /AND "content" = '((?:[^']|'')*)';/), seed, "o WHERE precisa casar com o texto exato da 0022");
  assert.ok(plans.length <= AGENT_SOURCE_LIMIT, `${plans.length} caracteres`);
  assert.equal(sanitizeHandoffText(plans), plans, "telefone do folheto não entra");
  for (const price of ["69,90", "99,90", "119,90", "139,90", "79,90"]) assert.ok(plans.includes(`R$ ${price}`), price);
  assert.doesNotMatch(plans, /promocion|indeterminad/i, "a BBNET pediu para não dizer ao cliente que é promocional");
});
