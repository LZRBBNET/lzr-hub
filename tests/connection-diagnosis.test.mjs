import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseConnection } from "../lib/platform/connection-diagnosis-shared.ts";
import { MemoryTicketRepository, diagnoseTicket, ixcDiagnose, openOrContinueTicket } from "../lib/platform/triage-service.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";

/**
 * O diagnóstico de "sem internet" que os bots de provedor fazem antes de abrir
 * chamado. Os dados de entrada imitam o cadastro de teste real (login offline,
 * contrato ativo, sem OS) e as variações que mudam o próximo passo.
 */

const contrato = (over = {}) => ({ id: "48882", status: "A", internetStatus: "A", trustUnlockActive: false, ...over });
const login = (over = {}) => ({ id: "32844", contractId: "48882", online: false, lastConnectedAt: "2026-10-12 11:45:21", lastDisconnectedAt: "2026-10-13 10:48:39", neighborhood: "Centro", ...over });
const entrada = (over = {}) => ({ logins: [login()], contracts: [contrato()], openServiceOrders: [], ...over });

/* ---------------------------------------------------------- regras --- */

test("offline com contrato ativo: reinício guiado e, se não voltar, OS", () => {
  const d = diagnoseConnection(entrada(), []);
  assert.equal(d.verdict, "offline");
  assert.match(d.facts.join(" "), /desconectado desde 13\/10\/2026 10:48/);
  assert.match(d.next, /reinício/);
  assert.equal(d.trustUnlockEligible, false);
});

test("bloqueio por atraso vai para o financeiro e pode receber desbloqueio de confiança", () => {
  for (const code of ["CA", "FA"]) {
    const d = diagnoseConnection(entrada({ contracts: [contrato({ internetStatus: code })] }), []);
    assert.equal(d.verdict, "blocked", code);
    assert.equal(d.trustUnlockEligible, true, code);
    assert.match(d.next, /desbloqueio de confiança/);
  }
});

test("bloqueio manual não é desbloqueio de confiança, nem quem já está em desbloqueio", () => {
  assert.equal(diagnoseConnection(entrada({ contracts: [contrato({ internetStatus: "CM" })] }), []).trustUnlockEligible, false);
  const emDesbloqueio = diagnoseConnection(entrada({ contracts: [contrato({ internetStatus: "CA", trustUnlockActive: true })] }), []);
  assert.equal(emDesbloqueio.trustUnlockEligible, false);
  assert.match(emDesbloqueio.facts.join(" "), /em desbloqueio de confiança/);
});

test("massiva registrada no bairro do login: avisar, não abrir OS individual", () => {
  const massiva = { title: "Rompimento de fibra", city: "Itabaiana", neighborhood: "CENTRO", startedAt: "2026-10-13T09:00:00Z" };
  const d = diagnoseConnection(entrada(), [massiva]);
  assert.deepEqual(d.incident, massiva);
  assert.match(d.next, /massiva/);
  assert.equal(diagnoseConnection(entrada(), [{ ...massiva, neighborhood: "Bairro Novo" }]).incident, null, "massiva de outro bairro não conta");
});

test("já existe OS aberta: acompanhar, não abrir outra", () => {
  const d = diagnoseConnection(entrada({ openServiceOrders: [{ id: "271863", status: "A", openedAt: "2026-10-12 08:00:00" }] }), []);
  assert.equal(d.openServiceOrderId, "271863");
  assert.match(d.next, /OS 271863 já aberta/);
});

test("online: o problema não está no contrato nem no login — olhar Wi-Fi e aparelhos", () => {
  const d = diagnoseConnection(entrada({ logins: [login({ online: true })] }), []);
  assert.equal(d.verdict, "online");
  assert.match(d.next, /Wi-Fi/);
});

test("código desconhecido aparece como código, não como palpite; sem dado, inconclusivo", () => {
  assert.match(diagnoseConnection(entrada({ contracts: [contrato({ internetStatus: "ZZ" })] }), []).facts[0], /código ZZ/);
  const vazio = diagnoseConnection({ logins: [], contracts: [], openServiceOrders: [] }, []);
  assert.equal(vazio.verdict, "unknown");
  assert.match(vazio.next, /atendente precisa verificar/);
});

/* ------------------------------------------------- no atendimento --- */

async function atendimento(over = {}) {
  const tickets = new MemoryTicketRepository();
  const { ticket } = await openOrContinueTicket(tickets, { channel: "n8n-whatsapp", conversationId: "5579991234567" });
  const pronto = { ...ticket, identification: "identified", ixcCustomerId: "21857", ...over };
  await tickets.update(ticket.id, pronto);
  return { tickets, ticket: pronto };
}

test("o diagnóstico roda uma vez, só em assunto técnico e só com o cliente identificado", async () => {
  let chamadas = 0;
  const diagnose = async () => { chamadas++; return diagnoseConnection(entrada(), []); };

  const { tickets, ticket } = await atendimento();
  assert.equal(await diagnoseTicket(tickets, ticket, "financial_invoice", diagnose), undefined, "fatura não pede diagnóstico de conexão");
  const feito = await diagnoseTicket(tickets, ticket, "technical_no_connection", diagnose);
  assert.equal(feito.verdict, "offline");
  assert.equal(tickets.tickets[0].diagnosis.verdict, "offline", "fica gravado no atendimento");
  assert.equal(await diagnoseTicket(tickets, tickets.tickets[0], "technical_slow", diagnose), undefined, "não refaz: o IXC tem limite por minuto");

  const anonimo = await atendimento({ identification: "not_found", ixcCustomerId: null });
  assert.equal(await diagnoseTicket(anonimo.tickets, anonimo.ticket, "technical_no_connection", diagnose), undefined, "sem saber quem é, não há contrato para olhar");
  assert.equal(chamadas, 1);
});

test("IXC lento ou fora do ar deixa o atendimento sem diagnóstico, sem prender o webhook", async () => {
  const { tickets, ticket } = await atendimento();
  const lento = () => new Promise(() => {});
  assert.equal(await diagnoseTicket(tickets, ticket, "technical_no_connection", lento, 20), undefined);
  assert.equal(await diagnoseTicket(tickets, ticket, "technical_no_connection", async () => { throw new Error("IXC fora"); }), undefined);
  assert.equal(tickets.tickets[0].diagnosis, null);
});

test("a leitura do IXC usa três consultas e não expõe senha, IP nem MAC", async () => {
  const pedidos = [];
  const registros = {
    radusuarios: [{ id: "32844", id_cliente: "21857", id_contrato: "48882", online: "N", ultima_conexao_inicial: "2026-10-12 11:45:21", ultima_conexao_final: "2026-10-13 10:48:39", bairro: "Centro", senha: "segredo", ip: "10.0.0.1", mac: "AA:BB" }],
    cliente_contrato: [{ id: "48882", id_cliente: "21857", status: "A", status_internet: "A", desbloqueio_confianca_ativo: "N" }],
    su_oss_chamado: [{ id: "1", id_cliente: "21857", status: "F", data_abertura: "2026-01-01 08:00:00" }, { id: "2", id_cliente: "21857", status: "A", id_assunto: "15", data_abertura: "0000-00-00 00:00:00" }],
  };
  const fetcher = async (url) => { const resource = String(url).split("/").at(-1); pedidos.push(resource); return Response.json({ registros: registros[resource] ?? [] }); };
  const provider = new IxcReadonlyProvider({ baseUrl: "https://ixc.invalid", token: "secret", allowedCustomerIds: ["21857"], fetcher });
  const dados = await provider.getServiceDiagnosis("21857", "corr-1");
  assert.deepEqual(pedidos.sort(), ["cliente_contrato", "radusuarios", "su_oss_chamado"]);
  assert.equal(dados.logins[0].online, false);
  assert.equal(dados.logins[0].neighborhood, "Centro");
  assert.doesNotMatch(JSON.stringify(dados), /segredo|10\.0\.0\.1|AA:BB/);
  assert.deepEqual(dados.openServiceOrders.map((o) => o.id), ["2"], "OS finalizada não é OS aberta");
  assert.equal(dados.openServiceOrders[0].openedAt, undefined, "data zerada do IXC é ausência de data");

  const massivas = { list: async () => [{ title: "Queda", city: "Itabaiana", neighborhood: "Centro", startedAt: "2026-10-13T09:00:00Z", status: "investigating" }, { title: "Antiga", city: "X", neighborhood: "Centro", startedAt: "2026-01-01T00:00:00Z", status: "resolved" }] };
  const diagnostico = await ixcDiagnose(provider, massivas, "corr-1")("21857");
  assert.equal(diagnostico.incident.title, "Queda", "massiva encerrada não conta");
});
