import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NAME, MemoryChannelRepository, SUGGESTION_ROLE, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository, CSAT_QUESTION, CSAT_THANKS, getSupportMetrics } from "../lib/platform/support-metrics.ts";
import { MemoryReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { MemoryConversationStateRepository } from "../lib/platform/conversation-state-service.ts";
import { AI_SENDER, REPLY_WINDOW_MS, awaitingSinceFrom, needsReply } from "../lib/platform/conversation-state-shared.ts";
import { MemoryConversationsRepository } from "../lib/platform/conversations-service.ts";
import { AUTO_REPLY_CLAIM_PREFIX, metaAutoReplyOptions, metaAutoReplySender } from "../lib/platform/meta-auto-reply-service.ts";
import { parseMetaMessages } from "../lib/integrations/meta/webhook-parser.ts";

/**
 * A resposta automática pela Meta: o que fica gravado como enviado é só o que a
 * Meta aceitou. Antes, com a flag ligada, a tela dizia que o cliente recebeu e
 * nenhuma chamada saía.
 */

const CLIENTE = "5579991234567";
const ENTRADA = "wamid.ENTRADA1";

function montar({ enabled = true, comConfig = true, fetcher, mensagemDoClienteHa = 60_000, semHora = false } = {}) {
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  const claims = new MemoryReplyRepository();
  const states = new MemoryConversationStateRepository();
  const chamadas = [];
  let saida = 0;
  const padrao = async (url, init) => {
    const body = JSON.parse(init.body);
    chamadas.push({ url, body });
    return { status: 200, json: async () => ({ messages: [{ id: `wamid.SAIDA${++saida}` }] }) };
  };
  const estado = { fetcher: fetcher ?? padrao };
  const config = comConfig ? { accessToken: "TOKEN-SECRETO", phoneNumberId: "999", graphVersion: "v26.0", fetcher: (...args) => estado.fetcher(...args) } : undefined;
  const deps = {
    enabled, states, messages: channel, claims, config, channel: CHANNEL_NAME,
    customerMessageAt: semHora ? undefined : new Date(Date.now() - mensagemDoClienteHa).toISOString(),
  };
  const receber = async (text = "quero a segunda via do boleto", wamid = ENTRADA) => processChannelMessage(
    channel,
    { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `corr-${wamid}` },
    metrics,
    await metaAutoReplyOptions(deps, CLIENTE),
  );
  const historico = () => channel.getHistory(CHANNEL_NAME, CLIENTE);
  return { channel, metrics, claims, states, chamadas, estado, deps, receber, historico };
}

const humano = { status: "open", assigneeId: "u-ana", assigneeName: "Ana", assignedAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null };
const falhasDeEnvio = (channel) => channel.audits.filter((a) => a.action?.startsWith("whatsapp.autoreply."));

/* ------------------------------------------------------------- envio --- */

test("com a resposta automática ligada, a resposta sai pela Meta e só então é gravada como enviada", async () => {
  const { chamadas, receber, historico, channel } = montar();
  const result = await receber();

  assert.equal(chamadas.length, 1, "uma chamada à Cloud API");
  assert.equal(chamadas[0].body.to, CLIENTE);
  assert.equal(chamadas[0].body.text.body, result.response, "o que saiu é o que a tela mostra");
  assert.equal(result.autoReply, true);
  assert.equal(result.externalMessageId, "wamid.SAIDA1");

  const [cliente, resposta] = await historico();
  assert.equal(cliente.externalMessageId, ENTRADA);
  assert.equal(resposta.role, "agent");
  assert.equal(resposta.externalMessageId, "wamid.SAIDA1", "é o wamid do envio que casa o recibo de entrega");
  assert.equal(resposta.sentBy, AI_SENDER, "quem enviou fica registrado: a IA, não um atendente");

  assert.match(channel.audits[0].reason, /ENVIADA ao cliente/);
  assert.equal(falhasDeEnvio(channel).length, 0);
});

test("primeira resposta não conta como atendimento resolvido nem pede avaliação", async () => {
  // O pipeline diz `simulated` para segunda via; a resposta aprovada que sai diz
  // "vou pedir para um atendente enviar". Ninguém resolveu nada ainda.
  const { receber, metrics } = montar();
  const result = await receber("quero a segunda via do boleto");
  assert.equal(result.status, "replied");
  assert.ok(!result.response.includes(CSAT_QUESTION), "\"um atendente retorna... antes de encerrar, avalie\" se contradiz");
  const resumo = await getSupportMetrics(metrics, "2000-01-01T00:00:00.000Z");
  assert.equal(resumo.resolvedWithoutHuman, 0);
  assert.equal(resumo.suggestionsOnly, 0, "também não é sugestão: a resposta saiu");
});

test("transbordo e pergunta ao cliente guardam o desfecho do pipeline", async () => {
  assert.equal((await montar().receber("quero falar com um atendente")).status, "handoff");
  assert.equal((await montar().receber("estou sem internet")).status, "waiting_customer");
});

test("reentrega do mesmo webhook não envia de novo", async () => {
  const { chamadas, receber, historico } = montar();
  const primeira = await receber();
  const segunda = await receber();
  assert.deepEqual(segunda, primeira);
  assert.equal(chamadas.length, 1);
  assert.equal((await historico()).length, 2);
});

test("duas entregas simultâneas do mesmo wamid: só uma chega ao cliente", async () => {
  const { chamadas, receber } = montar();
  await Promise.all([receber(), receber()]);
  assert.equal(chamadas.length, 1);
});

test("se o envio saiu e a gravação caiu, a reentrega registra o que saiu sem reenviar", async () => {
  const { chamadas, channel, receber, historico } = montar();
  const original = channel.saveMessages.bind(channel);
  channel.saveMessages = async () => { throw new Error("banco fora"); };
  await assert.rejects(receber(), /banco fora/, "a rota responde erro, e a Meta reentrega");
  channel.saveMessages = original;

  const result = await receber();
  assert.equal(chamadas.length, 1, "o cliente não recebe a mesma resposta duas vezes");
  const resposta = (await historico())[1];
  assert.equal(resposta.role, "agent");
  assert.equal(resposta.externalMessageId, "wamid.SAIDA1");
  assert.equal(resposta.content, chamadas[0].body.text.body, "o texto gravado é o que saiu, não um recalculado");
  assert.equal(result.externalMessageId, "wamid.SAIDA1");
});

/* ------------------------------------------------------------ falha --- */

test("quando a Meta recusa, a resposta fica como sugestão e a falha é auditada", async () => {
  const { claims, receber, historico, metrics, channel } = montar({
    fetcher: async () => ({ status: 400, json: async () => ({ error: { code: 131026, message: "Receiver incapable" } }) }),
  });
  const result = await receber();

  assert.equal(result.autoReply, false, "nada foi respondido automaticamente");
  assert.equal(result.response, null);
  assert.equal(result.status, "suggested");
  assert.ok(result.suggestion.length > 0);
  assert.equal(result.externalMessageId, undefined);

  const resposta = (await historico())[1];
  assert.equal(resposta.role, SUGGESTION_ROLE, "a tela não pode afirmar que o cliente recebeu");
  assert.equal(resposta.externalMessageId, undefined);
  assert.equal(metrics.outcomes[0].finalStatus, "suggested", "não entra na conta de resolvidos sem humano");

  const [falha] = falhasDeEnvio(channel);
  assert.equal(falha.action, "whatsapp.autoreply.failed");
  assert.equal(falha.result, "failed");
  assert.match(falha.reason, /NÃO enviada/);
  assert.match(falha.reason, /131026/);
  assert.match(channel.audits[0].reason, /NÃO enviada/, "o registro do atendimento também não diz ENVIADA");
  assert.equal(await claims.claimState(`${AUTO_REPLY_CLAIM_PREFIX}${ENTRADA}`), undefined, "recusa da Meta solta a reserva: nada saiu");
});

test("sugestão que sobra de envio falho não leva a pergunta de avaliação", async () => {
  const falho = montar({ fetcher: async () => ({ status: 500, json: async () => ({ error: { code: 1, message: "x" } }) }) });
  const result = await falho.receber();
  assert.ok(!result.suggestion.includes(CSAT_QUESTION), "não se avalia o que o cliente não recebeu");
});

test("em timeout a mensagem pode ter saído: fica como sugestão, auditada como incerta, e nada é reenviado", async () => {
  const { claims, deps, receber, historico, channel } = montar({
    fetcher: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })))),
  });
  deps.config.timeoutMs = 20;
  const result = await receber();

  assert.equal(result.status, "suggested");
  assert.equal((await historico())[1].role, SUGGESTION_ROLE);
  const [falha] = falhasDeEnvio(channel);
  assert.equal(falha.result, "unknown");
  assert.match(falha.reason, /Não sei se a mensagem saiu/);
  assert.deepEqual(await claims.claimState(`${AUTO_REPLY_CLAIM_PREFIX}${ENTRADA}`), { status: "unknown" }, "a reserva fica e barra a reentrega");

  const chamadas = [];
  const segunda = await metaAutoReplySender({ ...deps, config: { ...deps.config, fetcher: async (url, init) => { chamadas.push(init); return { status: 200, json: async () => ({ messages: [{ id: "wamid.X" }] }) }; } } })({
    conversationId: CLIENTE, text: "Olá", inboundMessageId: ENTRADA,
  });
  assert.equal(segunda.sent, false);
  assert.equal(segunda.outcome, "blocked");
  assert.equal(chamadas.length, 0, "reenviar poderia duplicar a mensagem ao cliente");
});

/* ------------------------------------------------- uma por espera --- */

test("a IA responde sozinha uma vez por espera; o resto vira sugestão para o atendente", async () => {
  const { chamadas, receber, historico } = montar();
  await receber("quero a segunda via do boleto", "wamid.1");
  const segunda = await receber("ok, obrigado", "wamid.2");
  assert.equal(chamadas.length, 1, "o \"ok\" do cliente não ganha outra resposta automática");
  assert.equal(segunda.autoReply, false);
  assert.equal(segunda.status, "suggested");
  assert.equal((await historico()).at(-1).role, SUGGESTION_ROLE);
});

test("depois que um atendente responde, a próxima espera tem de novo primeira resposta", async () => {
  const { chamadas, channel, receber } = montar();
  await receber("quero a segunda via do boleto", "wamid.1");
  await channel.saveMessages(CHANNEL_NAME, CLIENTE, [{ role: "agent", content: "Segue a segunda via.", sentBy: "ana@bbnet.com.br" }]);
  assert.equal((await receber("minha internet caiu", "wamid.2")).autoReply, true);
  assert.equal(chamadas.length, 2);
});

test("resolver a conversa também recomeça a espera", async () => {
  const { chamadas, states, receber } = montar();
  await receber("quero a segunda via do boleto", "wamid.1");
  await states.save(CHANNEL_NAME, CLIENTE, { status: "resolved", assigneeId: null, assigneeName: null, assignedAt: null, resolvedAt: new Date(Date.now() + 1000).toISOString(), resolvedBy: "Ana" });
  assert.equal((await receber("voltou a cair", "wamid.2")).autoReply, true);
  assert.equal(chamadas.length, 2);
});

test("histórico ilegível conta como 'já respondeu': na dúvida, sugere", async () => {
  const { deps } = montar();
  const options = await metaAutoReplyOptions({ ...deps, messages: { getHistory: async () => { throw new Error("banco fora"); } } }, CLIENTE);
  assert.equal(options.autoReply, false);
  assert.equal(options.send, undefined);
});

test("a primeira resposta não tira a conversa da fila: o cliente segue esperando um humano", async () => {
  const { receber, historico } = montar();
  await receber("quero a segunda via do boleto");
  const [cliente, gravada] = await historico();
  // A resposta é sempre posterior à fala; o carimbo explícito tira o empate do duplo de teste.
  const resposta = { ...gravada, createdAt: new Date(Date.parse(cliente.createdAt) + 1).toISOString() };
  assert.equal(awaitingSinceFrom([resposta, cliente]), cliente.createdAt, "a promessa de atendente não é atendimento");

  const conversas = new MemoryConversationsRepository();
  for (const linha of [cliente, resposta]) conversas.add({ channel: CHANNEL_NAME, externalConversationId: CLIENTE, ...linha });
  const [resumo] = await conversas.listConversations(10);
  assert.equal(needsReply(resumo, Date.now()), true, "aparece na fila, no menu e no sino");
  const [, bolha] = await conversas.getMessages(CHANNEL_NAME, CLIENTE, 10);
  assert.equal(bolha.sentByName, "IA", "a bolha diz quem respondeu");

  conversas.add({ channel: CHANNEL_NAME, externalConversationId: CLIENTE, role: "agent", content: "Segue a segunda via.", createdAt: new Date(Date.now() + 1000).toISOString(), sentBy: "ana@bbnet.com.br" });
  const [depois] = await conversas.listConversations(10);
  assert.equal(needsReply(depois, Date.now()), false, "resposta de gente tira da fila");
});

/* ---------------------------------------------------------- travas --- */

test("conversa com responsável humano não recebe resposta automática", async () => {
  const { states, chamadas, receber, historico, channel } = montar();
  await states.save(CHANNEL_NAME, CLIENTE, humano);
  const result = await receber();
  assert.equal(chamadas.length, 0, "a IA não fala por cima do atendente");
  assert.equal(result.autoReply, false);
  assert.equal((await historico())[1].role, SUGGESTION_ROLE);
  assert.match(channel.audits[0].reason, /apenas sugerida/);
});

test("estado da conversa ilegível conta como 'tem humano': a IA só sugere", async () => {
  const { states, chamadas, receber } = montar();
  states.failReads = true;
  const result = await receber();
  assert.equal(chamadas.length, 0);
  assert.equal(result.autoReply, false);
});

test("conversa resolvida em que o cliente volta a escrever pode ser respondida pela IA", async () => {
  const { states, chamadas, receber } = montar();
  await states.save(CHANNEL_NAME, CLIENTE, { ...humano, status: "resolved", resolvedAt: new Date(Date.now() - 3_600_000).toISOString(), resolvedBy: "Ana" });
  assert.equal((await receber()).autoReply, true);
  assert.equal(chamadas.length, 1);
});

test("fora da janela de 24 horas não tenta enviar: fica como sugestão e o bloqueio é auditado", async () => {
  const dentro = montar({ mensagemDoClienteHa: REPLY_WINDOW_MS - 60_000 });
  assert.equal((await dentro.receber()).autoReply, true);

  const fora = montar({ mensagemDoClienteHa: REPLY_WINDOW_MS + 60_000 });
  const result = await fora.receber();
  assert.equal(fora.chamadas.length, 0);
  assert.equal(result.status, "suggested");
  const [bloqueio] = falhasDeEnvio(fora.channel);
  assert.equal(bloqueio.action, "whatsapp.autoreply.blocked");
  assert.equal(bloqueio.result, "blocked");
  assert.match(bloqueio.reason, /24 horas/);
});

test("sem a hora da mensagem no webhook a janela não pode ser provada, e nada sai", async () => {
  const { chamadas, receber, channel } = montar({ semHora: true });
  const result = await receber();
  assert.equal(chamadas.length, 0);
  assert.equal(result.autoReply, false);
  assert.match(falhasDeEnvio(channel)[0].reason, /não dá para provar/);
});

test("flag desligada: nada sai e nenhum bloqueio é registrado — é o modo observação", async () => {
  const { chamadas, receber, historico, channel } = montar({ enabled: false });
  const result = await receber();
  assert.equal(chamadas.length, 0);
  assert.equal(result.autoReply, false);
  assert.equal((await historico())[1].role, SUGGESTION_ROLE);
  assert.equal(channel.audits.length, 1);
});

test("sem token ou id do número, não envia e diz por quê", async () => {
  const { chamadas, receber, channel } = montar({ comConfig: false });
  const result = await receber();
  assert.equal(chamadas.length, 0);
  assert.equal(result.status, "suggested");
  assert.match(falhasDeEnvio(channel)[0].reason, /não está configurado/);
});

test("texto de homologação e destino que não é cliente são barrados antes da Meta", async () => {
  const { deps, chamadas } = montar();
  const enviar = metaAutoReplySender(deps);
  assert.equal((await enviar({ conversationId: CLIENTE, text: "Preparei a segunda via fictícia.", inboundMessageId: "wamid.A" })).outcome, "blocked");
  assert.equal((await enviar({ conversationId: "120363373173147301@g.us", text: "Olá", inboundMessageId: "wamid.B" })).outcome, "blocked");
  assert.equal((await enviar({ conversationId: CLIENTE, text: "a".repeat(4097), inboundMessageId: "wamid.C" })).outcome, "blocked");
  assert.equal(chamadas.length, 0);
});

test("o agradecimento da avaliação também sai pela Meta, e só é gravado como enviado se sair", async () => {
  const ok = montar();
  await ok.channel.saveMessages(CHANNEL_NAME, CLIENTE, [{ role: "agent", content: `Pronto.\n\n${CSAT_QUESTION}` }]);
  const avaliada = await ok.receber("5", "wamid.NOTA");
  assert.equal(avaliada.status, "rated");
  assert.equal(ok.chamadas.length, 1);
  assert.equal(ok.chamadas[0].body.text.body, CSAT_THANKS);
  const agradecimento = (await ok.historico()).at(-1);
  assert.equal(agradecimento.role, "agent");
  assert.equal(agradecimento.externalMessageId, "wamid.SAIDA1");

  const falho = montar({ fetcher: async () => ({ status: 400, json: async () => ({ error: { code: 131047, message: "x" } }) }) });
  await falho.channel.saveMessages(CHANNEL_NAME, CLIENTE, [{ role: "agent", content: `Pronto.\n\n${CSAT_QUESTION}` }]);
  const semEnvio = await falho.receber("5", "wamid.NOTA");
  assert.equal(semEnvio.autoReply, false);
  assert.equal((await falho.historico()).at(-1).role, SUGGESTION_ROLE);
  assert.equal(falhasDeEnvio(falho.channel)[0].action, "whatsapp.autoreply.failed");
});

test("a auditoria nunca guarda o token", async () => {
  const { receber, channel } = montar({ fetcher: async () => ({ status: 401, json: async () => ({ error: { code: 190, message: "Invalid OAuth access token" } }) }) });
  await receber();
  assert.doesNotMatch(JSON.stringify(channel.audits), /TOKEN-SECRETO/);
});

/* ---------------------------------------------------------- webhook --- */

test("o webhook traz a hora em que o cliente escreveu, que é de onde conta a janela", () => {
  const [lida] = parseMetaMessages({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messages: [{ from: CLIENTE, id: "wamid.T", timestamp: "1749416383", type: "text", text: { body: "oi" } }] } }] }],
  });
  assert.equal(lida.sentAt, new Date(1749416383 * 1000).toISOString());

  const [semHora] = parseMetaMessages({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messages: [{ from: CLIENTE, id: "wamid.U", type: "text", text: { body: "oi" } }] } }] }],
  });
  assert.equal(semHora.sentAt, undefined);
});
