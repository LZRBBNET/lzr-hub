import test from "node:test";
import assert from "node:assert/strict";
import {
  BILLING_STAGES, TEMPLATES, canonicalPhone, firstName, isOptIn, isOptOut, templatePayload, whatsappNumber,
} from "../lib/platform/outbound-shared.ts";
import { MemoryOutboundRepository, runBillingReminders, runNetworkNotices } from "../lib/platform/outbound-service.ts";

/** Cobrança e avisos de rede que a BBNET manda primeiro, por modelo aprovado da Meta. */

// Quarta, 18/11/2026, 10h em Brasília.
const DIA = new Date("2026-11-18T13:00:00Z");

test("modelos: corpo não começa nem termina com variável, exemplo para cada uma, rodapé de descadastro", () => {
  for (const template of Object.values(TEMPLATES)) {
    const vars = template.body.match(/\{\{\d+\}\}/g) ?? [];
    assert.equal(vars.length, template.example.length, template.name);
    assert.doesNotMatch(template.body.trim(), /^\{\{|\}\}$/, `${template.name}: a Meta recusa variável na ponta`);
    assert.match(template.name, /^[a-z0-9_]+$/, "nome aceito pela Meta");
    const payload = templatePayload(template);
    assert.equal(payload.category, "UTILITY");
    assert.equal(payload.components[1].text, "Para não receber estes avisos, responda SAIR");
  }
  assert.deepEqual(BILLING_STAGES.map((stage) => stage.offsetDays), [-6, -1, 0, 3], "véspera do bloqueio (7 dias) primeiro");
});

test("telefone: só celular, no formato do WhatsApp; o nono dígito que o WhatsApp às vezes omite volta", () => {
  assert.equal(whatsappNumber("", "(79) 99830-7232"), "5579998307232");
  assert.equal(whatsappNumber("79 3431-2233"), undefined, "fixo não recebe WhatsApp");
  assert.equal(whatsappNumber("(79) 99830-7232", "79 98888-7777"), "5579998307232", "WhatsApp antes do celular");
  assert.equal(canonicalPhone("557998307232"), "5579998307232");
  assert.equal(canonicalPhone("5579998307232"), "5579998307232");
  assert.equal(firstName("MARIA DA SILVA SANTOS"), "Maria");
  assert.equal(firstName("PADARIA BOM PAO LTDA"), "cliente");
  assert.ok(isOptOut("SAIR") && isOptOut("parar") && isOptOut("Não quero mais receber"));
  assert.equal(isOptOut("quero sair do plano de 100 mega"), false, "pedido de atendimento não é descadastro");
  assert.ok(isOptIn("voltar"));
});

function cenario({ invoicesByDate = {}, contacts = {}, neighborhood = [], send } = {}) {
  const repository = new MemoryOutboundRepository();
  const enviados = [];
  const provider = {
    listOpenInvoicesDue: async (date) => ({ items: invoicesByDate[date] ?? [], total: (invoicesByDate[date] ?? []).length }),
    listCustomerContacts: async (ids) => ids.map((id) => contacts[id]).filter(Boolean),
    listCustomersInNeighborhood: async () => ({ items: neighborhood, total: neighborhood.length }),
  };
  const sender = send ?? (async (input) => { enviados.push(input); return { ok: true, messageId: `wamid.${enviados.length}` }; });
  const run = (extra = {}) => runBillingReminders({ provider, repository, send: sender, dryRun: false, maxSends: 100, dailyCap: 900, correlationId: "c", now: () => DIA, ...extra });
  return { repository, enviados, provider, sender, run };
}
const contato = (id, extra = {}) => ({ id, name: "JOANA SOUZA", mobile: "(79) 99999-00" + id.padStart(2, "0").slice(-2), whatsapp: "", active: true, neighborhood: "Centro", city: "Itabaiana", ...extra });

test("cobrança: as quatro etapas, a véspera do bloqueio primeiro, uma mensagem por cliente e nunca duas vezes", async () => {
  const { run, enviados, repository } = cenario({
    invoicesByDate: {
      "2026-11-12": [{ id: "f1", customerId: "1", dueAt: "2026-11-12", value: 99.9 }],
      "2026-11-17": [{ id: "f2", customerId: "2", dueAt: "2026-11-17", value: 79.9 }],
      "2026-11-18": [{ id: "f3", customerId: "3", dueAt: "2026-11-18", value: 99.9 }, { id: "f3b", customerId: "3", dueAt: "2026-11-18", value: 10 }],
      "2026-11-21": [{ id: "f4", customerId: "4", dueAt: "2026-11-21", value: 120 }],
    },
    contacts: { 1: contato("1"), 2: contato("2"), 3: contato("3"), 4: contato("4") },
  });
  const report = await run();
  assert.deepEqual(enviados.map((item) => item.name), ["lzr_aviso_antes_do_bloqueio", "lzr_fatura_em_atraso", "lzr_fatura_vence_hoje", "lzr_fatura_vence_em_3_dias"]);
  // A moeda sai com espaço que não quebra linha entre "R$" e o valor — igual para quem lê.
  assert.deepEqual(enviados[2].bodyParams.map((p) => p.replace(/ /g, " ")), ["Joana", "R$ 99,90", "18/11"], "duas faturas no mesmo dia: uma mensagem, a maior");
  assert.equal(report.sent, 4);
  const again = await run();
  assert.equal(again.sent, 0, "a rodada seguinte não repete");
  assert.equal(again.stages.billing_due_today.skipped.ja_enviado, 1);
  assert.equal(repository.rows.every((row) => row.status === "sent"), true);
});

test("cobrança: quem pediu para sair, sem celular ou inativo não recebe; simulação não envia nem reserva", async () => {
  const { run, enviados, repository } = cenario({
    invoicesByDate: { "2026-11-18": [{ id: "a", customerId: "1", dueAt: "2026-11-18", value: 50 }, { id: "b", customerId: "2", dueAt: "2026-11-18", value: 50 }, { id: "c", customerId: "3", dueAt: "2026-11-18", value: 50 }] },
    contacts: { 1: contato("1"), 2: contato("2", { mobile: "79 3431-2233" }), 3: contato("3", { active: false }) },
  });
  await repository.setOptOut(canonicalPhone(whatsappNumber(contato("1").mobile)), true, "whatsapp");
  const simulado = await run({ dryRun: true });
  assert.equal(enviados.length, 0);
  assert.equal(repository.rows.length, 0, "simulação não reserva");
  assert.deepEqual(simulado.stages.billing_due_today.skipped, { pediu_para_sair: 1, sem_celular: 1, cliente_inativo: 1 });
});

test("cobrança: teto por rodada, fora do horário não manda, e o limite da Meta para a rodada inteira", async () => {
  const invoices = { "2026-11-18": [1, 2, 3].map((n) => ({ id: `f${n}`, customerId: String(n), dueAt: "2026-11-18", value: 50 })) };
  const contacts = { 1: contato("1"), 2: contato("2"), 3: contato("3") };
  const teto = cenario({ invoicesByDate: invoices, contacts });
  const r1 = await teto.run({ maxSends: 2 });
  assert.equal(r1.sent, 2);
  assert.equal(r1.stoppedBy, "max_per_run");
  const noite = cenario({ invoicesByDate: invoices, contacts });
  const r2 = await noite.run({ now: () => new Date("2026-11-18T23:30:00Z") });
  assert.equal(r2.stoppedBy, "outside_hours");
  assert.equal(noite.enviados.length, 0);
  let tentativas = 0;
  const limitado = cenario({ invoicesByDate: invoices, contacts, send: async () => { tentativas++; return { ok: false, kind: "rate_limited", reason: "limite", metaCode: 131056 }; } });
  const r3 = await limitado.run();
  assert.equal(tentativas, 1, "parou no primeiro aviso de limite");
  assert.equal(r3.stoppedBy, "meta_limit");
});

test("avisos de rede: começo para o bairro, normalização só para quem foi avisado, manutenção até 48 h antes", async () => {
  const { repository, enviados, provider, sender } = cenario({ neighborhood: [contato("1"), contato("2"), contato("9", { city: "Aracaju" })], contacts: { 1: contato("1"), 2: contato("2") } });
  const opts = { provider, repository, send: sender, dryRun: false, maxSends: 100, dailyCap: 900, correlationId: "c", now: () => DIA };
  const aberta = { id: "m1", title: "Rompimento", severity: "high", status: "investigating", city: "Itabaiana", neighborhood: "Centro", equipment: null, affectedCustomers: 0, startedAt: "2026-11-18T12:00:00Z", endedAt: null, kind: "outage", scheduledStart: null, scheduledEnd: null };
  await runNetworkNotices({ ...opts, incidents: [aberta] });
  assert.equal(enviados.length, 2, "Aracaju é outra cidade com o mesmo bairro");
  assert.deepEqual(enviados[0].bodyParams, ["Joana", "Centro, Itabaiana"]);
  const resolvida = { ...aberta, status: "resolved", endedAt: "2026-11-18T12:40:00Z" };
  await runNetworkNotices({ ...opts, incidents: [resolvida] });
  assert.equal(enviados.filter((item) => item.name === "lzr_aviso_instabilidade_resolvida").length, 2);
  const manutencao = { ...aberta, id: "m2", kind: "maintenance", scheduledStart: "2026-11-19T04:00:00Z", scheduledEnd: "2026-11-19T08:00:00Z" };
  await runNetworkNotices({ ...opts, incidents: [manutencao] });
  const aviso = enviados.find((item) => item.name === "lzr_aviso_manutencao_programada");
  assert.deepEqual(aviso.bodyParams, ["Joana", "Centro, Itabaiana", "19/11", "das 01h às 05h"]);
  const distante = { ...manutencao, id: "m3", scheduledStart: "2026-11-25T04:00:00Z", scheduledEnd: "2026-11-25T08:00:00Z" };
  const antes = enviados.length;
  await runNetworkNotices({ ...opts, incidents: [distante] });
  assert.equal(enviados.length, antes, "manutenção daqui a uma semana ainda não avisa");
});
