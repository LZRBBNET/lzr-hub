import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NAME, MemoryChannelRepository, SUGGESTION_ROLE, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { MemoryReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { MemoryConversationStateRepository } from "../lib/platform/conversation-state-service.ts";
import { metaAutoReplyOptions } from "../lib/platform/meta-auto-reply-service.ts";
import { MemoryKnowledgeRepository } from "../lib/platform/knowledge-service.ts";
import { MemoryTicketRepository, startTriage } from "../lib/platform/triage-service.ts";
import { checkBotAnswer, doubtBotAnswerer, doubtBotConfigFromEnv } from "../lib/platform/doubt-bot-service.ts";

/**
 * Robô de dúvidas (n8n) no horário comercial: responde uma vez, só dúvida que a
 * base sustenta, e qualquer falha cai na sugestão ao atendente.
 */

const CLIENTE = "5579991234567";
const SEGREDO = "s".repeat(32);
const URL_N8N = "https://n8n.exemplo.com.br/webhook/duvidas";

/* ----------------------------------------------------------- configuração --- */

test("só liga com a flag, URL https e segredo de pelo menos 24 caracteres", () => {
  const ok = { FEATURE_N8N_BOT: "true", N8N_BOT_URL: URL_N8N, N8N_BOT_SECRET: SEGREDO };
  assert.ok(doubtBotConfigFromEnv(ok));
  assert.equal(doubtBotConfigFromEnv({ ...ok, FEATURE_N8N_BOT: "false" }), undefined);
  assert.equal(doubtBotConfigFromEnv({ ...ok, N8N_BOT_URL: "http://n8n.exemplo.com.br/x" }), undefined, "http puro vazaria o segredo");
  assert.equal(doubtBotConfigFromEnv({ ...ok, N8N_BOT_URL: "lixo" }), undefined);
  assert.equal(doubtBotConfigFromEnv({ ...ok, N8N_BOT_SECRET: "curto" }), undefined);
  assert.equal(doubtBotConfigFromEnv({ ...ok, N8N_BOT_SECRET: "" }), undefined);
});

/* ------------------------------------------------------ conferência do texto --- */

test("o texto que volta do n8n é conferido antes de sair", () => {
  assert.deepEqual(checkBotAnswer("  A loja abre às 8h.  "), { ok: true, text: "A loja abre às 8h." });
  const barrados = {
    vazio: "   ", recusa: "NAO_SEI", longo: "a".repeat(901),
    homologacao: "Preparei a segunda via fictícia.", email: "Escreva para joao@exemplo.com", cpf: "O CPF 529.982.247-25 está ok",
    telefone: "Ligue (79) 99123-4567", link: "Veja em https://exemplo.com.br/planos",
    acao1: "Já abri um chamado para você.", acao2: "Gerei a sua fatura agora.", acao3: "O chamado foi aberto.", acao4: "Desbloqueei sua internet.",
  };
  for (const [nome, texto] of Object.entries(barrados)) assert.equal(checkBotAnswer(texto).ok, false, nome);
  assert.equal(checkBotAnswer(42).ok, false);
  // O futuro e a explicação não são "ação feita".
  assert.equal(checkBotAnswer("Para abrir um chamado, um atendente vai te ajudar.").ok, true);
});

/* ------------------------------------------------------------------- fluxo --- */

function base(n8n) {
  const docs = new MemoryKnowledgeRepository();
  const publicar = async (title, content, validUntil = null) => {
    const doc = await docs.create({ title, category: "geral", content });
    await docs.publish(doc.id);
    if (validUntil) docs.documents.find((item) => item.id === doc.id).validUntil = validUntil;
  };
  const chamadasN8n = [];
  const fetcher = async (url, init) => {
    chamadasN8n.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return n8n(chamadasN8n.length, init.signal);
  };
  const config = { url: URL_N8N, secret: SEGREDO, fetcher, timeoutMs: 200 };
  return { docs, publicar, chamadasN8n, config };
}
const resposta = (answer) => ({ ok: true, status: 200, json: async () => ({ answer }) });

function montar(n8n = () => resposta("A loja de Itabaiana funciona de segunda a sexta, das 8h às 18h.")) {
  const { docs, publicar, chamadasN8n, config } = base(n8n);
  const channel = new MemoryChannelRepository();
  const claims = new MemoryReplyRepository();
  const states = new MemoryConversationStateRepository();
  const metrics = new MemorySupportMetricsRepository();
  const enviados = [];
  let saida = 0;
  const metaConfig = { accessToken: "T", phoneNumberId: "999", graphVersion: "v26.0", fetcher: async (_url, init) => { enviados.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ messages: [{ id: `wamid.S${++saida}` }] }) }; } };
  let n = 0;
  // Reproduz a rota da Meta no horário comercial: a IA não fala por outro caminho, só o robô de dúvidas.
  const receber = async (text) => {
    const wamid = `wamid.E${++n}`;
    const auto = await metaAutoReplyOptions({
      enabled: true, states, messages: channel, claims, config: metaConfig, channel: CHANNEL_NAME,
      turn: {channel:"local",conversationId:"local",operation:"local",sendKey:"local",generation:"local",kind:"reply"},
      delivery: { authorizeDispatch: async () => true, begin: async () => "t", finish: async () => {}, settleUncertain: async () => {} },
      customerMessageAt: new Date().toISOString(),
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `c-${wamid}` }, metrics, {
      autoReply: false,
      doubtBot: auto.autoReply && auto.send ? { send: auto.send, answer: doubtBotAnswerer(config, () => docs.list(200)) } : undefined,
    });
  };
  const auditoria = () => channel.audits ?? [];
  return { receber, publicar, chamadasN8n, enviados, channel, auditoria, docs };
}

const DUVIDA = "qual o horario da loja de voces";

test("dúvida que a base sustenta: o robô responde e o cliente recebe pela Meta", async () => {
  const { receber, publicar, chamadasN8n, enviados, channel } = montar();
  await publicar("Horário das lojas", "A loja de Itabaiana funciona de segunda a sexta, das 8h às 18h.");
  const result = await receber(DUVIDA);
  assert.equal(result.autoReply, true);
  assert.equal(result.status, "replied", "primeira resposta, não resolução");
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].text.body, /das 8h às 18h/);
  const [chamada] = chamadasN8n;
  assert.equal(chamada.headers.Authorization, `Bearer ${SEGREDO}`);
  assert.equal(chamada.body.sources[0].title, "Horário das lojas");
  const historico = await channel.getHistory(CHANNEL_NAME, CLIENTE);
  assert.equal(historico[1].role, "agent");
  assert.equal(historico[1].sentBy, "ia");
});

test("a pergunta e o histórico vão ao n8n sem CPF, e-mail ou telefone", async () => {
  const { receber, publicar, chamadasN8n } = montar();
  await publicar("Horário das lojas", "A loja de Itabaiana funciona de segunda a sexta, das 8h às 18h.");
  await receber("horario da loja voces joao@exemplo.com");
  const enviado = JSON.stringify(chamadasN8n[0].body);
  assert.doesNotMatch(enviado, /joao@exemplo/);
  assert.equal(chamadasN8n.length, 1);
});

test("sem trecho na base o n8n nem é chamado: a conversa segue para o atendente", async () => {
  const { receber, chamadasN8n, enviados } = montar();
  const result = await receber(DUVIDA);
  assert.equal(chamadasN8n.length, 0);
  assert.equal(enviados.length, 0);
  assert.equal(result.autoReply, false);
  assert.equal(result.status, "suggested");
});

test("rascunho e documento vencido não sustentam resposta", async () => {
  const { receber, publicar, docs, chamadasN8n } = montar();
  await docs.create({ title: "Horário das lojas", category: "geral", content: "A loja funciona das 8h às 18h." });
  await publicar("Horário antigo", "A loja funciona das 9h às 17h.", "2020-01-01T00:00:00.000Z");
  await receber(DUVIDA);
  assert.equal(chamadasN8n.length, 0);
});

test("assunto com fluxo próprio não vai ao robô, mesmo com a base cheia", async () => {
  const { receber, publicar, chamadasN8n, enviados } = montar();
  await publicar("Segunda via do boleto", "A segunda via do boleto sai pelo financeiro.");
  const result = await receber("quero a segunda via do boleto");
  assert.equal(chamadasN8n.length, 0);
  assert.equal(enviados.length, 0);
  assert.equal(result.status, "suggested");
});

test("n8n fora do ar, lento ou com texto reprovado: sugestão ao atendente e linha na auditoria", async () => {
  const casos = {
    erro: () => ({ ok: false, status: 500, json: async () => ({}) }),
    acao: () => resposta("Já abri um chamado para você."),
    lento: (_n, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })))),
  };
  for (const [nome, n8n] of Object.entries(casos)) {
    const { receber, publicar, enviados, channel } = montar(n8n);
    await publicar("Horário das lojas", "A loja de Itabaiana funciona de segunda a sexta, das 8h às 18h.");
    const result = await receber(DUVIDA);
    assert.equal(result.autoReply, false, nome);
    assert.equal(enviados.length, 0, nome);
    const historico = await channel.getHistory(CHANNEL_NAME, CLIENTE);
    assert.equal(historico.at(-1).role, SUGGESTION_ROLE, nome);
    assert.ok(channel.audits.some((audit) => audit.action === "whatsapp.doubtbot.failed"), `${nome}: auditoria`);
  }
});

test("o robô disse que a base não responde: não é falha, o atendente assume", async () => {
  const { receber, publicar, enviados, channel } = montar(() => resposta("NAO_SEI"));
  await publicar("Horário das lojas", "A loja de Itabaiana funciona de segunda a sexta, das 8h às 18h.");
  const result = await receber(DUVIDA);
  assert.equal(result.autoReply, false);
  assert.equal(enviados.length, 0);
  assert.equal(channel.audits.some((audit) => audit.action === "whatsapp.doubtbot.failed"), false);
});

test("uma por espera: a segunda pergunta do cliente não vai ao robô", async () => {
  const { receber, publicar, chamadasN8n, enviados } = montar();
  await publicar("Horário das lojas", "A loja de Itabaiana funciona de segunda a sexta, das 8h às 18h.");
  await receber(DUVIDA);
  const segunda = await receber("e no sabado, qual o horario da loja de voces");
  assert.equal(chamadasN8n.length, 1);
  assert.equal(enviados.length, 1);
  assert.equal(segunda.autoReply, false, "vira sugestão até um atendente responder");
});

test("a Meta recusa o envio: a resposta do robô fica como sugestão, sem afirmar que saiu", async () => {
  // Envio bloqueado pela política (aqui, simulado): o texto do robô não pode ser dado como enviado.
  const { docs, config } = { docs: new MemoryKnowledgeRepository(), config: { url: URL_N8N, secret: SEGREDO, fetcher: async () => resposta("A loja abre às 8h.") } };
  const doc = await docs.create({ title: "Horário das lojas", category: "geral", content: "A loja funciona das 8h às 18h." });
  await docs.publish(doc.id);
  const repo = new MemoryChannelRepository();
  const bloqueado = async () => ({ sent: false, outcome: "blocked", reason: "janela" });
  const result = await processChannelMessage(repo, { externalConversationId: CLIENTE, text: DUVIDA, idempotencyKey: "w1", correlationId: "c1" }, new MemorySupportMetricsRepository(), {
    autoReply: false, doubtBot: { send: bloqueado, answer: doubtBotAnswerer(config, () => docs.list(200)) },
  });
  assert.equal(result.autoReply, false);
  assert.equal(result.suggestion, "A loja abre às 8h.", "o atendente ainda recebe o texto como sugestão");
  assert.ok(repo.audits.some((audit) => audit.action === "whatsapp.autoreply.blocked"));
});

test("cumprimento no horário comercial: o robô pergunta o assunto com o menu da triagem", async () => {
  const { docs, config } = base(() => resposta("não deve ser chamado"));
  const channel = new MemoryChannelRepository();
  const tickets = new MemoryTicketRepository();
  const enviados = [];
  const metaConfig = { accessToken: "T", phoneNumberId: "999", graphVersion: "v26.0", fetcher: async (_url, init) => { enviados.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ messages: [{ id: `wamid.S${enviados.length}` }] }) }; } };
  let n = 0;
  const receber = async (text) => {
    const wamid = `wamid.G${++n}`;
    const triage = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup: async () => undefined, offHours: false });
    const auto = await metaAutoReplyOptions({
      enabled: true, states: new MemoryConversationStateRepository(), messages: channel, claims: new MemoryReplyRepository(), config: metaConfig, channel: CHANNEL_NAME,
      turn: {channel:"local",conversationId:"local",operation:"local",sendKey:"local",generation:"local",kind:"reply"},
      delivery: { authorizeDispatch: async () => true, begin: async () => "t", finish: async () => {}, settleUncertain: async () => {} },
      customerMessageAt: new Date().toISOString(), awaitingAnswer: triage?.awaitingAnswer,
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `c-${wamid}` }, new MemorySupportMetricsRepository(), {
      autoReply: false, triage: triage?.hooks,
      doubtBot: auto.autoReply && auto.send ? { send: auto.send, answer: doubtBotAnswerer(config, () => docs.list(200)) } : undefined,
    });
  };
  const result = await receber("oi");
  assert.equal(result.status, "clarifying");
  assert.equal(result.autoReply, true);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].text.body, /assistente virtual da BBNET/);
  assert.match(enviados[0].text.body, /Protocolo do atendimento:/);
  // A resposta ao menu vira assunto e segue para o atendente: nada novo sai.
  const escolha = await receber("3");
  assert.equal(escolha.autoReply, false);
  assert.equal(enviados.length, 1);
});
