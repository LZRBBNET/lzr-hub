import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NAME, MemoryChannelRepository, SUGGESTION_ROLE, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { MemoryReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { MemoryConversationStateRepository } from "../lib/platform/conversation-state-service.ts";
import { REPLY_WINDOW_MS } from "../lib/platform/conversation-state-shared.ts";
import { metaAutoReplyOptions } from "../lib/platform/meta-auto-reply-service.ts";
import { MemoryTicketRepository, closeOpenTicket, identifyTicketCustomer, knownCustomer, openOrContinueTicket, startTriage } from "../lib/platform/triage-service.ts";
import { CLARIFY_TEXT, formatProtocol, menuChoice, queueForIntent } from "../lib/platform/triage-shared.ts";
import { DEFAULT_REPLY_TEMPLATES } from "../lib/platform/reply-templates-shared.ts";
import { analyzeIntent } from "../lib/agent/pipeline.ts";

const CLIENTE = "5579991234567";

/* ---------------------------------------------------------- regras --- */

test("menu: o número ou o nome exato da opção escolhem o assunto; texto livre fica com o classificador", () => {
  assert.equal(menuChoice("3"), "financial_invoice");
  assert.equal(menuChoice(" 3. "), "financial_invoice");
  assert.equal(menuChoice("opção 7"), "sales_inquiry");
  assert.equal(menuChoice("sem internet"), "technical_no_connection");
  assert.equal(menuChoice("10"), undefined, "fora do menu");
  assert.equal(menuChoice("minha fatura veio errada"), undefined);
});

test("o protocolo usa a data de Brasília e o sequencial com 6 dígitos", () => {
  // 02h UTC do dia 14 ainda é dia 13 em Brasília.
  assert.equal(formatProtocol(42, new Date("2026-10-14T02:00:00Z")), "20261013000042");
  assert.equal(formatProtocol(1234567, new Date("2026-10-14T15:00:00Z")), "202610141234567", "passar de 6 dígitos não corta o número");
});

test("cada assunto vai para um setor", () => {
  assert.equal(queueForIntent("technical_slow"), "tecnico");
  assert.equal(queueForIntent("financial_pix"), "financeiro");
  assert.equal(queueForIntent("sales_inquiry"), "comercial");
  assert.equal(queueForIntent("cancellation_risk"), "comercial", "cancelamento é retenção");
  assert.equal(queueForIntent("human_handoff"), "atendimento");
});

test("planos e contratação viram assunto próprio, sem roubar lentidão de quem já é cliente", () => {
  assert.equal(analyzeIntent("quero contratar internet").intent, "sales_inquiry");
  assert.equal(analyzeIntent("quais os planos de vocês?").intent, "sales_inquiry");
  assert.equal(analyzeIntent("meu plano de 100 mega está lento").intent, "technical_slow");
  assert.ok(DEFAULT_REPLY_TEMPLATES.sales_inquiry.length > 0);
});

/* ------------------------------------------------------ atendimento --- */

test("a primeira fala abre atendimento com protocolo; a seguinte continua o mesmo", async () => {
  const tickets = new MemoryTicketRepository();
  const at = Date.parse("2026-10-14T13:00:00Z");
  const primeiro = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, now: at });
  assert.equal(primeiro.created, true);
  assert.equal(primeiro.ticket.protocol, "20261014000001");
  assert.equal(primeiro.ticket.stage, "new");
  assert.equal(primeiro.ticket.identification, "pending");

  const segundo = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, now: at + 60_000 });
  assert.equal(segundo.created, false);
  assert.equal(segundo.ticket.protocol, primeiro.ticket.protocol);
  assert.equal(tickets.tickets.length, 1);
});

test("24 horas sem o cliente falar encerram o atendimento; a fala nova ganha outro protocolo", async () => {
  const tickets = new MemoryTicketRepository();
  const at = Date.parse("2026-10-14T13:00:00Z");
  const velho = (await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, now: at })).ticket;
  const novo = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, now: at + REPLY_WINDOW_MS + 60_000 });
  assert.equal(novo.created, true);
  assert.notEqual(novo.ticket.protocol, velho.protocol);
  const fechado = tickets.tickets.find((t) => t.id === velho.id);
  assert.equal(fechado.status, "closed");
  assert.equal(fechado.closedReason, "inactivity");
});

test("resolver a conversa fecha o atendimento", async () => {
  const tickets = new MemoryTicketRepository();
  const { ticket } = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE });
  await closeOpenTicket(tickets, CHANNEL_NAME, CLIENTE);
  assert.equal(tickets.tickets[0].status, "closed");
  assert.equal(tickets.tickets[0].closedReason, "resolved");
  const depois = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE });
  assert.equal(depois.created, true);
  assert.notEqual(depois.ticket.protocol, ticket.protocol);
});

test("duas mensagens chegando juntas não abrem dois protocolos", async () => {
  const tickets = new MemoryTicketRepository();
  const [a, b] = await Promise.all([
    openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE }),
    openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE }),
  ]);
  assert.equal(tickets.tickets.length, 1);
  assert.equal(a.ticket.id, b.ticket.id);
});

test("se o protocolo não grava, o atendimento segue e diz que não há protocolo", async () => {
  const tickets = new MemoryTicketRepository();
  tickets.failUpdates = true;
  const { ticket } = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE });
  assert.equal(ticket.protocol, null);
});

test("o cliente é procurado no IXC uma vez por atendimento", async () => {
  const tickets = new MemoryTicketRepository();
  let consultas = 0;
  const lookup = async () => { consultas++; return { id: "21857" }; };
  const primeira = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup });
  const segunda = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup });
  assert.equal(consultas, 1, "o IXC tem limite por minuto: não se repete a cada mensagem");
  assert.equal(primeira.ticket.identification, "identified");
  assert.equal(segunda.ticket.ixcCustomerId, "21857");
});

test("IXC fora do ar fica registrado e é tentado de novo na próxima fala", async () => {
  const tickets = new MemoryTicketRepository();
  const { ticket } = await openOrContinueTicket(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE });
  const fora = await identifyTicketCustomer(tickets, ticket, async () => { throw new Error("timeout"); });
  assert.equal(fora.identification, "unavailable");
  const voltou = await identifyTicketCustomer(tickets, fora, async () => undefined);
  assert.equal(voltou.identification, "not_found", "nenhum ou mais de um cadastro: não identifica");
});

test("a captação de lead aproveita a busca do atendimento, e na dúvida não cria lead", async () => {
  const base = { id: "t", channel: CHANNEL_NAME, conversationId: CLIENTE, ixcCustomerId: null };
  assert.deepEqual(await knownCustomer({ ...base, identification: "identified", ixcCustomerId: "9" })(CLIENTE), { id: "9" });
  assert.equal(await knownCustomer({ ...base, identification: "not_found" })(CLIENTE), undefined, "sem cadastro: vira lead");
  await assert.rejects(knownCustomer({ ...base, identification: "unavailable" })(CLIENTE), "IXC fora do ar: o funil não cria");
});

test("tabela do atendimento fora do ar não derruba o canal", async () => {
  const tickets = new MemoryTicketRepository();
  tickets.findOpen = async () => { throw new Error("relation does not exist"); };
  assert.equal(await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup: async () => undefined }), undefined);
});

/* ------------------------------------------------- triagem no canal --- */

function montar({ enabled = true, fetcher, identificado = true } = {}) {
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  const claims = new MemoryReplyRepository();
  const states = new MemoryConversationStateRepository();
  const tickets = new MemoryTicketRepository();
  const chamadas = [];
  let saida = 0;
  const estado = {
    fetcher: fetcher ?? (async (url, init) => {
      chamadas.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ messages: [{ id: `wamid.SAIDA${++saida}` }] }) };
    }),
  };
  const config = { accessToken: "TOKEN", phoneNumberId: "999", graphVersion: "v26.0", fetcher: (...args) => estado.fetcher(...args) };
  let n = 0;
  const receber = async (text) => {
    const wamid = `wamid.E${++n}`;
    const triage = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup: async () => (identificado ? { id: "21857" } : undefined) });
    const auto = await metaAutoReplyOptions({
      enabled, states, messages: channel, claims, config, channel: CHANNEL_NAME,
      customerMessageAt: new Date().toISOString(), afterClarification: triage?.ticket.stage === "clarifying",
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `corr-${wamid}` }, metrics, { ...auto, triage: triage?.hooks });
  };
  const ticket = () => tickets.tickets.find((t) => t.status === "open");
  const enviados = () => chamadas.filter((body) => body.type === "text").map((body) => body.text.body);
  return { channel, metrics, tickets, chamadas, estado, receber, ticket, enviados };
}

test("sem certeza do assunto, a IA pergunta com o menu e informa o protocolo", async () => {
  const { receber, ticket, enviados, metrics } = montar();
  const result = await receber("oi, boa tarde");
  assert.equal(result.status, "clarifying");
  const [pergunta] = enviados();
  assert.ok(pergunta.startsWith(CLARIFY_TEXT));
  assert.match(pergunta, new RegExp(`Protocolo do atendimento: ${ticket().protocol}`));
  assert.equal(ticket().stage, "clarifying");
  assert.ok(ticket().protocolSentAt, "o protocolo saiu para o cliente");
  assert.equal(metrics.outcomes[0].finalStatus, "clarifying", "perguntar não é resolver");
});

test("a escolha no menu define assunto e setor, e ganha resposta — sem repetir o protocolo", async () => {
  const { receber, ticket, enviados } = montar();
  await receber("oi");
  const escolha = await receber("3");
  assert.equal(escolha.autoReply, true, "a pergunta não pode virar beco: a resposta a ela é respondida");
  assert.equal(enviados().length, 2);
  assert.equal(enviados()[1], DEFAULT_REPLY_TEMPLATES.financial_invoice, "sem o protocolo de novo");
  assert.equal(ticket().intent, "financial_invoice");
  assert.equal(ticket().intentSource, "menu");
  assert.equal(ticket().queue, "financeiro");
  assert.equal(ticket().stage, "routed");

  const depois = await receber("ok, obrigado");
  assert.equal(depois.autoReply, false, "depois disso, uma por espera: o resto é do atendente");
  assert.equal(enviados().length, 2);
  assert.equal(ticket().queue, "financeiro", "o \"ok\" não muda o setor de quem pediu segunda via");
});

test("pedido claro dispensa a pergunta: responde direto, com o protocolo no fim", async () => {
  const { receber, ticket, enviados } = montar();
  const result = await receber("estou sem internet desde ontem");
  assert.notEqual(result.status, "clarifying");
  assert.equal(enviados()[0], `${DEFAULT_REPLY_TEMPLATES.technical_no_connection}\n\nProtocolo do atendimento: ${ticket().protocol}`);
  assert.equal(ticket().queue, "tecnico");
  assert.equal(ticket().stage, "routed");
});

test("a pergunta é feita uma vez por atendimento", async () => {
  const { receber, ticket, enviados } = montar();
  await receber("oi");
  await receber("é sobre aquilo que falei");
  assert.equal(enviados().filter((texto) => texto.startsWith(CLARIFY_TEXT)).length, 1, "resposta vaga à pergunta segue para o setor, sem repetir o menu");
  assert.equal(ticket().stage, "routed");
  assert.equal(ticket().queue, "atendimento");
});

test("modo observação: nada é perguntado nem enviado, mas o atendimento ganha protocolo e setor", async () => {
  const { receber, ticket, chamadas, channel } = montar({ enabled: false });
  const result = await receber("quero a segunda via do boleto");
  assert.equal(chamadas.length, 0);
  assert.equal(result.status, "suggested");
  assert.match(result.suggestion, new RegExp(`Protocolo do atendimento: ${ticket().protocol}$`), "o rascunho do atendente já leva o protocolo");
  assert.equal(ticket().protocolSentAt, null, "sugestão não informa ninguém");
  assert.equal(ticket().queue, "financeiro");
  assert.equal(ticket().identification, "identified");
  assert.equal((await channel.getHistory(CHANNEL_NAME, CLIENTE))[1].role, SUGGESTION_ROLE);
});

test("modo observação com fala vaga não marca o atendimento como encaminhado", async () => {
  const { receber, ticket } = montar({ enabled: false });
  await receber("oi");
  assert.equal(ticket().stage, "new", "se a resposta automática for ligada depois, a pergunta ainda pode ser feita");
});

test("se a pergunta não sai, o atendimento não fica esperando resposta a ela", async () => {
  const { receber, ticket } = montar({ fetcher: async () => ({ status: 400, json: async () => ({ error: { code: 131026, message: "x" } }) }) });
  const result = await receber("oi");
  assert.equal(result.status, "suggested");
  assert.equal(ticket().stage, "new");
  assert.equal(ticket().protocolSentAt, null);
});
