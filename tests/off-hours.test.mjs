import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NAME, MemoryChannelRepository, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { MemoryReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { MemoryConversationStateRepository } from "../lib/platform/conversation-state-service.ts";
import { metaAutoReplyOptions } from "../lib/platform/meta-auto-reply-service.ts";
import { MemoryTicketRepository, diagnosisReply, startTriage } from "../lib/platform/triage-service.ts";
import { diagnoseConnection } from "../lib/platform/connection-diagnosis-shared.ts";
import { DEFAULT_REPLY_TEMPLATES } from "../lib/platform/reply-templates-shared.ts";
import { TRIAGE_LIST, holidayName, isBusinessHours, menuChoice, nextOpeningText, offHoursMenuText } from "../lib/platform/triage-shared.ts";
import { sendInteractiveList } from "../lib/integrations/meta/cloud-client.ts";

/**
 * Fora do horário (seg–sex, 8h–12h e 14h–18h) a IA conduz sozinha: lista
 * clicável, respostas aprovadas, autoatendimento — e diz quando há gente.
 */

const CLIENTE = "5579991234567";
const CPF = "52998224725";
// Terça, 19h em Brasília.
const NOITE = Date.parse("2026-11-17T22:00:00Z");

/* ---------------------------------------------------------- horário --- */

test("horário de atendimento: dia útil 8–12 e 14–18 em Brasília; almoço, noite e fim de semana são fora", () => {
  assert.equal(isBusinessHours(new Date("2026-11-17T13:00:00Z")), true, "terça 10h");
  assert.equal(isBusinessHours(new Date("2026-11-17T15:30:00Z")), false, "terça 12h30, almoço");
  assert.equal(isBusinessHours(new Date("2026-11-17T20:59:00Z")), true, "terça 17h59");
  assert.equal(isBusinessHours(new Date("2026-11-17T21:00:00Z")), false, "terça 18h");
  assert.equal(isBusinessHours(new Date("2026-11-21T15:00:00Z")), false, "sábado 12h");
});

test("quando o atendimento com pessoas volta, em palavras", () => {
  assert.equal(nextOpeningText(new Date("2026-11-17T15:30:00Z")), "hoje às 14h");
  assert.equal(nextOpeningText(new Date("2026-11-17T22:00:00Z")), "amanhã às 8h");
  assert.equal(nextOpeningText(new Date("2026-11-20T22:00:00Z")), "segunda-feira às 8h", "sexta à noite");
  assert.equal(nextOpeningText(new Date("2026-11-22T12:00:00Z")), "amanhã às 8h", "domingo");
});

test("feriado em dia útil é fora do horário: fixos, Sergipe e móveis pela Páscoa", () => {
  assert.equal(isBusinessHours(new Date("2026-11-20T13:00:00Z")), false, "sexta 20/11, Consciência Negra, 10h");
  assert.equal(isBusinessHours(new Date("2026-12-25T13:00:00Z")), false, "Natal");
  assert.equal(isBusinessHours(new Date("2027-07-08T13:00:00Z")), false, "Emancipação de Sergipe");
  // Páscoa de 2027: 28/03 → Sexta-feira Santa 26/03, Carnaval 08 e 09/02, Corpus Christi 27/05.
  assert.equal(holidayName("2027-03-26"), "Sexta-feira Santa");
  assert.equal(holidayName("2027-02-08"), "Carnaval");
  assert.equal(holidayName("2027-02-09"), "Carnaval");
  assert.equal(holidayName("2027-05-27"), "Corpus Christi");
  assert.equal(holidayName("2026-04-03"), "Sexta-feira Santa", "Páscoa de 2026 em 05/04");
  assert.equal(holidayName("2026-11-18"), undefined);
});

test("a volta do atendimento pula o feriado", () => {
  assert.equal(nextOpeningText(new Date("2026-11-19T22:00:00Z")), "segunda-feira às 8h", "quinta à noite, sexta é feriado");
  assert.equal(nextOpeningText(new Date("2026-11-20T13:00:00Z")), "segunda-feira às 8h", "no próprio feriado, de manhã");
  assert.equal(nextOpeningText(new Date("2026-12-24T22:00:00Z")), "segunda-feira às 8h", "véspera de Natal numa quinta");
  assert.equal(nextOpeningText(new Date("2027-02-05T22:00:00Z")), "quarta-feira às 8h", "sexta antes do Carnaval");
});

test("no feriado a abertura diz que é feriado", () => {
  assert.match(offHoursMenuText(new Date("2026-11-20T13:00:00Z")), /Hoje é feriado \(Dia da Consciência Negra\)\. Ele volta segunda-feira às 8h/);
  assert.doesNotMatch(offHoursMenuText(new Date("2026-11-21T13:00:00Z")), /feriado/, "sábado não é anunciado como feriado");
});

test("feriado municipal vem de BUSINESS_HOLIDAYS, todo ano (MM-DD) ou data única", () => {
  const antes = process.env.BUSINESS_HOLIDAYS;
  try {
    process.env.BUSINESS_HOLIDAYS = "03-17, 2026-11-24, lixo";
    assert.equal(holidayName("2027-03-17"), "Feriado");
    assert.equal(isBusinessHours(new Date("2026-11-24T13:00:00Z")), false);
    assert.equal(isBusinessHours(new Date("2027-11-24T13:00:00Z")), true, "data com ano vale só naquele ano");
  } finally {
    if (antes === undefined) delete process.env.BUSINESS_HOLIDAYS; else process.env.BUSINESS_HOLIDAYS = antes;
  }
});

test("a lista clicável cabe nos limites da Meta, e a escolha chega pelo título", () => {
  assert.ok(TRIAGE_LIST.rows.length <= 10);
  for (const row of TRIAGE_LIST.rows) assert.ok(row.title.length <= 24, row.title);
  assert.equal(menuChoice("Internet lenta / Wi-Fi"), "technical_slow");
  assert.equal(menuChoice("Segunda via ou PIX"), "financial_invoice");
});

test("o envio da lista sai no formato interativo da Cloud API, cortado nos limites", async () => {
  let enviado;
  const config = { accessToken: "T", phoneNumberId: "999", graphVersion: "v26.0", fetcher: async (_url, init) => { enviado = JSON.parse(init.body); return { status: 200, json: async () => ({ messages: [{ id: "wamid.L" }] }) }; } };
  const result = await sendInteractiveList(config, { to: CLIENTE, body: "x".repeat(1500), button: "Ver assuntos", rows: [{ id: "a", title: "y".repeat(30), description: "z" }] });
  assert.deepEqual(result, { ok: true, messageId: "wamid.L" });
  assert.equal(enviado.type, "interactive");
  assert.equal(enviado.interactive.type, "list");
  assert.equal(enviado.interactive.body.text.length, 1024);
  assert.equal(enviado.interactive.action.sections[0].rows[0].title.length, 24);
});

/* ------------------------------------------------------------ fluxo --- */

function montar({ diagnose, offHours = true } = {}) {
  const channel = new MemoryChannelRepository();
  const tickets = new MemoryTicketRepository();
  const claims = new MemoryReplyRepository();
  const states = new MemoryConversationStateRepository();
  const enviados = [];
  let saida = 0;
  const config = {
    accessToken: "T", phoneNumberId: "999", graphVersion: "v26.0",
    fetcher: async (_url, init) => { enviados.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ messages: [{ id: `wamid.S${++saida}` }] }) }; },
  };
  const invoice = {
    lookup: { documentOf: async () => "529.982.247-25", openInvoices: async () => [{ id: "77", dueAt: "2026-10-10", value: 99.9 }], pixCode: async () => ({ copyPaste: "000201PIXDETESTE", expiresAt: null }) },
    sendData: true, now: () => NOITE,
  };
  let n = 0;
  const receber = async (text) => {
    const wamid = `wamid.E${++n}`;
    const triage = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup: async () => ({ id: "21857" }), diagnose, invoice, offHours, now: NOITE });
    const auto = await metaAutoReplyOptions({
      enabled: true, states, messages: channel, claims, config, channel: CHANNEL_NAME,
      delivery: { begin: async () => "t", finish: async () => {}, settleUncertain: async () => {} },
      customerMessageAt: new Date().toISOString(), awaitingAnswer: triage?.awaitingAnswer,
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `c-${wamid}` }, new MemorySupportMetricsRepository(), { ...auto, triage: triage?.hooks });
  };
  const textos = () => enviados.map((body) => body.type === "interactive" ? body.interactive.body.text : body.text.body);
  const ticket = () => tickets.tickets.find((t) => t.status === "open");
  return { receber, enviados, textos, ticket, channel };
}

test("fora do horário, a abertura vai como lista clicável dizendo quando há gente", async () => {
  const { receber, enviados, ticket, channel } = montar();
  const result = await receber("oi");
  assert.equal(result.status, "clarifying");
  assert.equal(enviados[0].type, "interactive", "lista clicável, não texto numerado");
  assert.match(enviados[0].interactive.body.text, /das 8h às 12h e das 14h às 18h\. Ele volta amanhã às 8h/);
  assert.match(enviados[0].interactive.body.text, /Protocolo do atendimento:/);
  assert.equal(enviados[0].interactive.action.sections[0].rows.length, TRIAGE_LIST.rows.length);
  const historico = await channel.getHistory(CHANNEL_NAME, CLIENTE);
  assert.match(historico[1].content, /1\. Sem internet/, "o atendente vê na tela as opções que o cliente viu");
  assert.equal(ticket().stage, "clarifying");
});

test("a escolha na lista leva ao autoatendimento, com a data de volta no fim da resposta", async () => {
  const { receber, textos, ticket } = montar();
  await receber("oi");
  await receber("Segunda via ou PIX");
  assert.equal(ticket().intent, "financial_invoice");
  assert.match(textos()[1], /CPF/, "a 2ª via pede o CPF");
  assert.match(textos()[1], /Nosso atendimento com pessoas volta amanhã às 8h/);
  await receber(CPF);
  assert.match(textos()[2], /PIX copia e cola/);
  assert.match(textos()[2], /000201PIXDETESTE/);
});

test("sem internet com bloqueio por atraso: a IA diz o motivo e já pede o CPF para mandar o PIX", async () => {
  const bloqueado = async () => diagnoseConnection({ logins: [{ id: "1", contractId: "9", online: false }], contracts: [{ id: "9", status: "A", internetStatus: "CA", trustUnlockActive: false }], openServiceOrders: [] }, []);
  const { receber, textos, ticket } = montar({ diagnose: bloqueado });
  await receber("estou sem internet desde ontem");
  assert.match(textos()[0], /bloqueada por pendência financeira/);
  assert.match(textos()[0], /CPF do titular/);
  assert.equal(ticket().selfService.step, "awaiting_cpf");
  assert.equal(ticket().diagnosis.verdict, "blocked");
  await receber(CPF);
  assert.match(textos()[1], /000201PIXDETESTE/, "do bloqueio ao PIX sem esperar ninguém");
});

test("as respostas que o diagnóstico muda: massiva, OS aberta e conexão chegando ao equipamento", () => {
  const base = { logins: [{ id: "1", contractId: "9", online: false, neighborhood: "Centro" }], contracts: [{ id: "9", status: "A", internetStatus: "A", trustUnlockActive: false }], openServiceOrders: [] };
  const massiva = diagnosisReply(diagnoseConnection(base, [{ title: "Rompimento", city: "Itabaiana", neighborhood: "Centro", startedAt: "2026-11-17T20:00:00Z" }]), true);
  assert.match(massiva.text, /instabilidade na rede da sua região \(Centro\)/);
  const os = diagnosisReply(diagnoseConnection({ ...base, openServiceOrders: [{ id: "555", status: "A" }] }, []), true);
  assert.match(os.text, /chamado técnico aberto para você \(nº 555\)/);
  const online = diagnosisReply(diagnoseConnection({ ...base, logins: [{ id: "1", contractId: "9", online: true }] }, []), true);
  assert.match(online.text, /chegando até o seu equipamento/);
  assert.equal(diagnosisReply(diagnoseConnection(base, []), true), undefined, "offline sem causa conhecida segue a resposta aprovada (reinício)");
});

test("offline sem causa conhecida: resposta aprovada de reinício, com a data de volta", async () => {
  const offline = async () => diagnoseConnection({ logins: [{ id: "1", contractId: "9", online: false }], contracts: [{ id: "9", status: "A", internetStatus: "A", trustUnlockActive: false }], openServiceOrders: [] }, []);
  const { receber, textos } = montar({ diagnose: offline });
  await receber("estou sem internet desde ontem");
  assert.ok(textos()[0].includes(DEFAULT_REPLY_TEMPLATES.technical_no_connection));
  assert.match(textos()[0], /volta amanhã às 8h/);
});

test("dentro do horário nada muda: menu numerado em texto, sem aviso de horário", async () => {
  const { receber, enviados } = montar({ offHours: false });
  await receber("oi");
  assert.equal(enviados[0].type, "text");
  assert.match(enviados[0].text.body, /responda com o número do assunto/);
  assert.doesNotMatch(enviados[0].text.body, /volta amanhã/);
});
