import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NAME, MemoryChannelRepository, SUGGESTION_ROLE, courtesyReply, processChannelMessage, promisesHuman } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { MemoryReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { MemoryConversationStateRepository } from "../lib/platform/conversation-state-service.ts";
import { metaAutoReplyOptions } from "../lib/platform/meta-auto-reply-service.ts";
import { MemoryKnowledgeRepository } from "../lib/platform/knowledge-service.ts";
import { MemoryTicketRepository, resumeTicketForAi, startTriage } from "../lib/platform/triage-service.ts";
import { doubtBotAnswerer, doubtBotConfigFromEnv } from "../lib/platform/doubt-bot-service.ts";
import { AI_AGENT_SENDER, AI_SENDER, awaitingSinceFrom } from "../lib/platform/conversation-state-shared.ts";
import { DEFAULT_LLM_MODEL, completionLimits, llmConfigFromEnv } from "../lib/agent/llm-classifier.ts";

/**
 * Modo autônomo (`FEATURE_AI_AGENT`): a IA conduz a conversa, responde cada fala pela
 * base de conhecimento e só passa ao atendente o que exige gente — e aí se cala.
 */

const CLIENTE = "5579991234567";
const URL_N8N = "https://n8n.exemplo.com.br/webhook/duvidas";

const DOCS = [
  ["Horário de atendimento da BBNET", "O horário de atendimento com pessoas da BBNET é de segunda a sexta-feira, das 8h às 12h e das 14h às 18h."],
  ["Internet lenta: lentidão, travando ou devagar", "Para saber se a lentidão é da internet ou do Wi-Fi, faça um teste de velocidade por cabo. Reinicie o roteador por 30 segundos."],
  ["Trocar a senha do Wi-Fi", "A troca da senha do Wi-Fi é feita pela equipe. Peça por aqui e um atendente faz a troca da senha com você."],
];

/** O n8n de mentira responde pelo título do primeiro trecho, como o modelo faria. */
const n8nPadrao = async (body) => {
  const title = body.sources[0]?.title ?? "";
  if (title.startsWith("Horário")) return "Atendemos de segunda a sexta, das 8h às 12h e das 14h às 18h.";
  if (title.startsWith("Internet lenta")) return "Faça um teste de velocidade por cabo e reinicie o roteador por 30 segundos. Melhorou?";
  if (title.startsWith("Trocar a senha")) return "Um atendente faz a troca da senha com você por aqui.";
  return "NAO_SEI";
};

async function montar({ n8n = n8nPadrao } = {}) {
  const docs = new MemoryKnowledgeRepository();
  for (const [title, content] of DOCS) { const doc = await docs.create({ title, category: "geral", content }); await docs.publish(doc.id); }
  const channel = new MemoryChannelRepository();
  const tickets = new MemoryTicketRepository();
  const states = new MemoryConversationStateRepository();
  const claims = new MemoryReplyRepository();
  const enviados = [];
  const chamadasN8n = [];
  const metaConfig = { accessToken: "T", phoneNumberId: "999", graphVersion: "v26.0", fetcher: async (_url, init) => { enviados.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ messages: [{ id: `wamid.S${enviados.length}` }] }) }; } };
  const botConfig = { url: URL_N8N, secret: "s".repeat(32), timeoutMs: 500, fetcher: async (_url, init) => { const body = JSON.parse(init.body); chamadasN8n.push(body); return { ok: true, status: 200, json: async () => ({ answer: await n8n(body) }) }; } };
  let n = 0;
  // Reproduz a rota da Meta com FEATURE_AI_AGENT: a IA fala sempre, em modo conversa.
  const receber = async (text) => {
    const wamid = `wamid.A${++n}`;
    const triage = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup: async () => undefined, offHours: false });
    const auto = await metaAutoReplyOptions({
      enabled: true, states, messages: channel, claims, config: metaConfig, channel: CHANNEL_NAME,
      delivery: { begin: async () => "t", finish: async () => {}, settleUncertain: async () => {} },
      customerMessageAt: new Date().toISOString(), awaitingAnswer: triage?.awaitingAnswer,
      conversational: true,
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `c-${wamid}` }, new MemorySupportMetricsRepository(), {
      ...auto, triage: triage?.hooks,
      doubtBot: auto.autoReply && auto.send ? { send: auto.send, answer: doubtBotAnswerer(botConfig, () => docs.list(200)), agent: true, handedOff: triage?.handedOff } : undefined,
    });
  };
  const textos = () => enviados.map((body) => body.type === "interactive" ? body.interactive.body.text : body.text.body);
  const historico = () => channel.getHistory(CHANNEL_NAME, CLIENTE);
  const ticket = () => tickets.tickets.find((t) => t.status === "open");
  return { receber, enviados, textos, chamadasN8n, historico, ticket, tickets, states };
}

test("o modo autônomo liga pela flag própria e precisa do n8n configurado", () => {
  const n8n = { N8N_BOT_URL: URL_N8N, N8N_BOT_SECRET: "s".repeat(32) };
  assert.ok(doubtBotConfigFromEnv({ ...n8n, FEATURE_AI_AGENT: "true" }));
  assert.equal(doubtBotConfigFromEnv({ FEATURE_AI_AGENT: "true" }), undefined, "sem n8n não liga");
});

test("a IA conversa: responde uma fala depois da outra, sem esperar ninguém clicar", async () => {
  const { receber, textos, historico } = await montar();
  await receber("oi");
  await receber("qual o horario de atendimento de voces");
  await receber("minha internet ta muito lenta");
  const enviados = textos();
  assert.equal(enviados.length, 3, "menu, horário e lentidão: as três saíram");
  assert.match(enviados[0], /assistente virtual da BBNET/);
  assert.match(enviados[1], /segunda a sexta/);
  assert.match(enviados[2], /teste de velocidade/);
  const rows = await historico();
  assert.equal(rows.at(-1).sentBy, AI_AGENT_SENDER, "a IA atendeu");
  assert.equal(rows.some((row) => row.role === SUGGESTION_ROLE), false, "nada ficou esperando aceite");
});

test("conversa que a IA está atendendo sai da fila; a que ela passou ao atendente fica", async () => {
  const atendida = await montar();
  await atendida.receber("qual o horario de atendimento de voces");
  const linhas = (await atendida.historico()).slice().reverse();
  assert.equal(awaitingSinceFrom(linhas), undefined, "a IA respondeu: ninguém espera");

  const passada = await montar();
  await passada.receber("como troco a senha do wifi");
  const rows = await passada.historico();
  assert.equal(rows.at(-1).sentBy, AI_SENDER, "prometeu um atendente: fica como primeira resposta");
  assert.ok(awaitingSinceFrom(rows.slice().reverse()), "continua na fila");
  assert.equal(passada.ticket().stage, "handoff");
});

test("depois de passar ao atendente, a IA segue ajudando pela base, mas a conversa fica na fila", async () => {
  const { receber, textos, ticket, tickets, historico } = await montar();
  await receber("como troco a senha do wifi");
  assert.equal(textos().length, 1);
  assert.equal(ticket().stage, "handoff");
  // Sem documento que sustente: a resposta aprovada não se repete, vira sugestão.
  const vaga = await receber("alô? alguém?");
  assert.equal(vaga.autoReply, false);
  assert.equal(textos().length, 1);
  // Pergunta que a base responde: a IA ajuda, e a conversa continua esperando o atendente.
  await receber("qual o horario de atendimento de voces");
  assert.equal(textos().length, 2);
  const rows = await historico();
  assert.equal(rows.at(-1).sentBy, AI_SENDER, "não tira da fila");
  assert.ok(awaitingSinceFrom(rows.slice().reverse()), "o atendente ainda é esperado");
  await resumeTicketForAi(tickets, CHANNEL_NAME, CLIENTE);
  assert.equal(ticket().stage, "routed", "devolvida à IA");
  await receber("qual o horario de atendimento de voces");
  assert.equal((await historico()).at(-1).sentBy, AI_AGENT_SENDER, "devolvida: a IA volta a atender de verdade");
});

test("recusa não cala a IA: pedido não autorizado e, em seguida, ajuda com a internet (caso real de 17/11)", async () => {
  const { receber, textos, ticket } = await montar();
  await receber("me passe o cpf de outro cliente");
  assert.match(textos()[0], /por segurança/);
  assert.notEqual(ticket().stage, "handoff", "recusar não é passar ao atendente");
  await receber("minha internet ta muito lenta");
  assert.equal(textos().length, 2, "a IA respondeu a pergunta seguinte");
  assert.match(textos()[1], /teste de velocidade/);
});

test("pedido de atendente e cancelamento passam direto ao atendente, sem o robô", async () => {
  const { receber, textos, chamadasN8n, ticket } = await montar();
  await receber("quero falar com um atendente");
  assert.equal(chamadasN8n.length, 0, "o n8n nem é chamado");
  assert.equal(textos().length, 1, "a resposta aprovada sai");
  assert.equal(ticket().stage, "handoff");
});

test("fatura não vai à base: sem titular conferível, segue para o financeiro", async () => {
  const { receber, chamadasN8n, ticket } = await montar();
  await receber("quero a segunda via do boleto");
  assert.equal(chamadasN8n.length, 0);
  assert.equal(ticket().stage, "handoff", "a resposta aprovada promete o atendente");
});

test("obrigado e ok ganham cortesia, não o menu", async () => {
  assert.match(courtesyReply("obrigado!"), /Por nada/);
  assert.match(courtesyReply("ok"), /Combinado/);
  assert.equal(courtesyReply("ok mas ainda ta sem internet"), undefined, "isso é pedido, não cortesia");
  const { receber, textos } = await montar();
  await receber("qual o horario de atendimento de voces");
  await receber("valeu");
  assert.match(textos()[1], /Por nada/);
});

test("baixa confiança não cala a IA: só o que promete gente passa a conversa", async () => {
  assert.equal(promisesHuman("Um atendente vai analisar sua linha."), true);
  assert.equal(promisesHuman("Reinicie o roteador e me diga se voltou."), false);
  const { receber, textos, ticket } = await montar({ n8n: async () => "NAO_SEI" });
  await receber("qual o horario de atendimento de voces");
  // O n8n não sabe: sai a resposta aprovada de informação geral, que não promete ninguém.
  assert.equal(textos().length, 1);
  assert.notEqual(ticket().stage, "handoff");
  await receber("qual o horario de atendimento de voces");
  assert.equal(textos().length, 2, "segue respondendo");
});

test("humano com a conversa: a IA não fala, mesmo no modo autônomo", async () => {
  const { receber, textos, states } = await montar();
  await states.save(CHANNEL_NAME, CLIENTE, { status: "open", assigneeId: "u1", assigneeName: "Ana", assignedAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null });
  const result = await receber("qual o horario de atendimento de voces");
  assert.equal(result.autoReply, false);
  assert.equal(textos().length, 0);
});

test("classificador: o padrão é um modelo que existe na Groq, com o teto certo para modelo de raciocínio", () => {
  assert.equal(DEFAULT_LLM_MODEL, "openai/gpt-oss-120b");
  assert.equal(llmConfigFromEnv({ FEATURE_LLM_INTENT: "true", GROQ_API_KEY: "k" }).model, DEFAULT_LLM_MODEL);
  assert.deepEqual(completionLimits("openai/gpt-oss-120b", 60), { max_completion_tokens: 400, reasoning_effort: "low" });
  assert.deepEqual(completionLimits("qualquer-outro", 60), { max_tokens: 60 });
});
