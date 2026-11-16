import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NAME, MemoryChannelRepository, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { MemoryReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { MemoryConversationStateRepository } from "../lib/platform/conversation-state-service.ts";
import { metaAutoReplyOptions } from "../lib/platform/meta-auto-reply-service.ts";
import { MemoryTicketRepository, startTriage } from "../lib/platform/triage-service.ts";
import { DEFAULT_REPLY_TEMPLATES } from "../lib/platform/reply-templates-shared.ts";
import {
  ASK_CPF_TEXT, INVALID_CPF_TEXT, MISMATCH_TEXT, UNAVAILABLE_TEXT, VERIFIED_HANDOFF_TEXT, extractDocument, invoiceDraft,
} from "../lib/platform/invoice-self-service-shared.ts";

/**
 * Segunda via com confirmação do titular: a IA pede o CPF, confere com o
 * cadastro que o telefone identificou e só então mostra a fatura.
 */

const CLIENTE = "5579991234567";
const CPF = "52998224725";            // CPF válido de teste (dígitos verificadores fecham)
const OUTRO_CPF = "11144477735";      // também válido, de outra pessoa
const HOJE = Date.parse("2026-10-21T15:00:00Z");

/* ---------------------------------------------------------- regras --- */

test("o documento é achado com ou sem pontuação; telefone não vira CPF", () => {
  assert.deepEqual(extractDocument("meu cpf é 529.982.247-25"), { digits: CPF });
  assert.deepEqual(extractDocument("52998224725"), { digits: CPF });
  assert.deepEqual(extractDocument("cnpj 11.222.333/0001-81"), { digits: "11222333000181" });
  assert.deepEqual(extractDocument("529.982.247-26"), { invalid: true }, "dígito verificador errado é erro de digitação");
  assert.deepEqual(extractDocument("me liga no 5579998307232"), {}, "13 dígitos de telefone não são documento");
  assert.deepEqual(extractDocument("quero a segunda via"), {});
});

test("o rascunho leva vencimento, valor, situação e a linha digitável quando o IXC devolve", () => {
  const texto = invoiceDraft([
    { id: "1", dueAt: "2026-10-10", value: 99.9, overdue: true, paymentCode: "34191.79001 01043.510047 91020.150008 1 96100000009990" },
    { id: "2", dueAt: "2026-11-10", value: 99.9, overdue: false, paymentCode: null },
  ]);
  assert.match(texto, /2 faturas em aberto/);
  assert.match(texto, /vence 10\/10\/2026 — R\$\s?99,90 \(vencida\)/);
  assert.match(texto, /Linha digitável da que vence primeiro:\n34191/);
  assert.match(invoiceDraft([]), /Não encontrei fatura em aberto/);
});

/* ------------------------------------------------------------ fluxo --- */

function montar({ autoReply = true, sendData = false, identificado = true, documento = "529.982.247-25", faturas, documentOf, budgetMs, pixCode } = {}) {
  const channel = new MemoryChannelRepository();
  const tickets = new MemoryTicketRepository();
  const claims = new MemoryReplyRepository();
  const states = new MemoryConversationStateRepository();
  const metrics = new MemorySupportMetricsRepository();
  const enviados = [];
  const leituras = { documento: 0, faturas: 0 };
  let saida = 0;
  const config = {
    accessToken: "TOKEN", phoneNumberId: "999", graphVersion: "v26.0",
    fetcher: async (_url, init) => { enviados.push(JSON.parse(init.body).text.body); return { status: 200, json: async () => ({ messages: [{ id: `wamid.S${++saida}` }] }) }; },
  };
  const lookup = {
    documentOf: documentOf ?? (async () => { leituras.documento++; return documento; }),
    openInvoices: async () => { leituras.faturas++; return faturas ?? [{ id: "77", dueAt: "2026-10-10", value: 99.9, paymentCode: "34191.79001" }]; },
    ...(pixCode ? { pixCode } : {}),
  };
  let n = 0;
  const receber = async (text) => {
    const wamid = `wamid.E${++n}`;
    const triage = await startTriage(tickets, {
      channel: CHANNEL_NAME, conversationId: CLIENTE, lookup: async () => (identificado ? { id: "21857" } : undefined),
      invoice: { lookup, sendData, budgetMs, now: () => HOJE },
    });
    const auto = await metaAutoReplyOptions({
      enabled: autoReply, states, messages: channel, claims, config, channel: CHANNEL_NAME,
      delivery: { begin: async () => "test-token", finish: async () => {}, settleUncertain: async () => {} },
      customerMessageAt: new Date().toISOString(), awaitingAnswer: triage?.awaitingAnswer,
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `c-${wamid}` }, metrics, { ...auto, triage: triage?.hooks });
  };
  const ticket = () => tickets.tickets.find((t) => t.status === "open");
  return { receber, ticket, enviados, leituras, tickets, metrics };
}

test("a IA pede o CPF antes de falar de fatura", async () => {
  const { receber, ticket, enviados } = montar();
  const result = await receber("quero a segunda via do boleto");
  assert.equal(result.status, "waiting_customer");
  assert.ok(enviados[0].startsWith(ASK_CPF_TEXT));
  assert.match(enviados[0], /Protocolo do atendimento:/, "primeira fala da IA no atendimento leva o protocolo");
  assert.equal(ticket().selfService.step, "awaiting_cpf");
});

test("CPF que confere com o cadastro do número: titular confirmado, fatura lida — e o envio dos dados espera a flag", async () => {
  const { receber, ticket, enviados, leituras, metrics } = montar();
  await receber("quero a segunda via do boleto");
  const result = await receber("529.982.247-25");
  assert.equal(result.autoReply, true, "o CPF é resposta a um pedido da IA: ganha resposta");
  assert.equal(enviados[1], VERIFIED_HANDOFF_TEXT, "sem FEATURE_AI_INVOICE a IA só confirma; quem manda a fatura é o atendente");
  assert.equal(ticket().selfService.step, "verified");
  assert.equal(ticket().selfService.invoices[0].overdue, true);
  assert.match(ticket().selfService.draft, /Linha digitável/, "o rascunho fica pronto na ficha");
  assert.deepEqual(leituras, { documento: 1, faturas: 1 });
  assert.equal(metrics.outcomes.at(-1).intentSource, "flow", "o CPF não passou pelo classificador");
});

test("com FEATURE_AI_INVOICE a IA manda a fatura", async () => {
  const { receber, enviados } = montar({ sendData: true });
  await receber("quero a segunda via do boleto");
  await receber("52998224725");
  assert.match(enviados[1], /Titular confirmado! Você tem 1 fatura em aberto/);
  assert.match(enviados[1], /34191\.79001/);
});

test("CPF de outra pessoa não confere: nada de fatura, e o motivo não revela de quem é o cadastro", async () => {
  const { receber, ticket, enviados, leituras } = montar();
  await receber("quero a segunda via do boleto");
  await receber(OUTRO_CPF);
  assert.equal(enviados[1], MISMATCH_TEXT);
  assert.equal(ticket().selfService.step, "mismatch");
  assert.equal(leituras.faturas, 0, "sem titular confirmado, a fatura nem é lida");
});

test("CPF digitado errado: pede de novo uma vez, depois passa para o atendente", async () => {
  const { receber, ticket, enviados } = montar();
  await receber("quero a segunda via do boleto");
  await receber("529.982.247-26");
  assert.equal(enviados[1], INVALID_CPF_TEXT);
  await receber("529.982.247-27");
  assert.match(enviados[2], /Não consegui confirmar o titular/);
  assert.equal(ticket().selfService.attempts, 2);
  const depois = await receber("e agora?");
  assert.equal(depois.autoReply, false, "sem mais pedido em aberto, volta a valer uma resposta por espera");
});

test("IXC fora do ar ou lento: \"não consegui consultar\", nunca \"não confere\"", async () => {
  for (const documentOf of [async () => { throw new Error("IXC fora"); }, () => new Promise(() => {})]) {
    const { receber, ticket, enviados } = montar({ documentOf, budgetMs: 20 });
    await receber("quero a segunda via do boleto");
    await receber(CPF);
    assert.equal(enviados[1], UNAVAILABLE_TEXT);
    assert.equal(ticket().selfService.step, "unavailable");
  }
});

test("CPF já na primeira mensagem: confere na hora", async () => {
  const { receber, ticket, enviados } = montar();
  await receber("preciso da segunda via, cpf 529.982.247-25");
  assert.equal(ticket().selfService.step, "verified");
  assert.ok(enviados[0].startsWith(VERIFIED_HANDOFF_TEXT));
});

test("número sem cadastro no IXC: não há com o que conferir, segue para o atendente como antes", async () => {
  const { receber, ticket, enviados } = montar({ identificado: false });
  await receber("quero a segunda via do boleto");
  assert.ok(enviados[0].includes(DEFAULT_REPLY_TEMPLATES.financial_invoice));
  assert.equal(ticket().selfService, null);
});

test("modo observação: nada é pedido; se o cliente manda o CPF, o atendente recebe a fatura pronta como sugestão", async () => {
  const { receber, ticket, enviados } = montar({ autoReply: false });
  const pedido = await receber("quero a segunda via do boleto");
  assert.equal(enviados.length, 0);
  assert.ok(pedido.suggestion.includes(DEFAULT_REPLY_TEMPLATES.financial_invoice));
  assert.equal(ticket().selfService, null);

  const cpf = await receber("meu cpf 52998224725");
  assert.equal(enviados.length, 0);
  assert.match(cpf.suggestion, /Titular confirmado! Você tem 1 fatura em aberto/);
  assert.equal(ticket().selfService.step, "verified");
});

test("o CPF nunca é gravado no atendimento", async () => {
  const { receber, tickets } = montar();
  await receber("quero a segunda via do boleto");
  await receber("529.982.247-25");
  assert.doesNotMatch(JSON.stringify(tickets.tickets), /52998224725|529\.982\.247-25/);
});

test("número de 11 dígitos que não é CPF só conta como \"CPF errado\" quando a IA pediu o CPF", async () => {
  const { receber, ticket, enviados } = montar({ autoReply: false });
  await receber("quero a segunda via do boleto");
  const telefone = await receber("meu outro número é 79998307233");
  assert.ok(!telefone.suggestion.includes("não parece um CPF"), "sem pedido de CPF, é só um número");
  assert.equal(ticket().selfService, null);
  assert.equal(enviados.length, 0);
});


/* --------------------------------------------------------------- PIX --- */

const PIX = "00020126970014br.gov.bcb.pix2575qrcodes.exemplo/cobv/abc5204000053039865404099.905802BR6304ABCD";

test("com o titular confirmado, o rascunho leva o PIX copia e cola da fatura que vence primeiro", async () => {
  const pedidos = [];
  const { receber, ticket, enviados } = montar({ sendData: true, pixCode: async (id) => { pedidos.push(id); return { copyPaste: PIX, expiresAt: "19/01/2027 00:00:00" }; } });
  await receber("quero a segunda via do boleto");
  await receber(CPF);
  assert.deepEqual(pedidos, ["77"], "PIX só da que vence primeiro, e só depois do titular confirmado");
  assert.equal(ticket().selfService.pix.copyPaste, PIX);
  assert.match(enviados[1], /PIX copia e cola da que vence primeiro \(R\$\s?99,90\):\n0002012697/);
  assert.doesNotMatch(enviados[1], /Linha digitável/, "com PIX, a linha digitável não vai junto");
});

test("PIX que falha não derruba a segunda via: titular confirmado, rascunho sem o código", async () => {
  const { receber, ticket } = montar({ pixCode: async () => { throw new Error("IXC_PIX_RECUSADO"); } });
  await receber("quero a segunda via do boleto");
  await receber(CPF);
  assert.equal(ticket().selfService.step, "verified");
  assert.equal(ticket().selfService.pix, null);
  assert.doesNotMatch(ticket().selfService.draft, /PIX/);
});

test("CPF de outra pessoa nem chega a gerar PIX", async () => {
  let chamadas = 0;
  const { receber } = montar({ pixCode: async () => { chamadas++; return { copyPaste: PIX, expiresAt: null }; } });
  await receber("quero a segunda via do boleto");
  await receber(OUTRO_CPF);
  assert.equal(chamadas, 0);
});
