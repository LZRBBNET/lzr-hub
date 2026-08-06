import test from "node:test";
import assert from "node:assert/strict";
import { parseNetworkAlertMessage } from "../lib/integrations/telegram/network-alert-parser.ts";

const NOW = "2026-08-06T12:00:00.000Z";

const OLT_DOWN = `❌ OLT-ZTE-CDB-SUP-02 possui alertas!

Descrição:
Interface gpon_olt-1/3/16 está DOWN

Início:
Data: 2026.08.03 | Hora: 14:48:20`;

const OLT_UP = `✅ OLT-ZTE-CDB-SUP-02 normalizado!

Descrição:
Interface gpon_olt-1/3/16 está DOWN

Início do Evento:
Data: 2026.08.03 | Hora: 14:48:20

Recuperação:
Data: 2026.08.03 | Hora: 15:09:36

Duração: 21m`;

const FIBER_DOWN = `⛔ Possível rompimento de fibra em SW-L3-COR-CDB-SUP-01


Descrição do evento:
 XGigabitEthernet0/0/12 - "Core: SW-L3-COR-ARYB-POV-01 (TE1/1/4) [10Gbps]" - DOWN

Data: 2026.08.04 | 21:59:31

ID do evento: 129400624`;

test("OLT em queda: equipamento, descrição e início corretos, sem decodificar o código de local", () => {
  const parsed = parseNetworkAlertMessage(OLT_DOWN, NOW);
  assert.equal(parsed.kind, "olt_interface");
  assert.equal(parsed.equipment, "OLT-ZTE-CDB-SUP-02");
  assert.equal(parsed.description, "Interface gpon_olt-1/3/16 está DOWN");
  assert.equal(parsed.resolved, false);
  assert.equal(parsed.resolvedAt, null);
  assert.equal(parsed.startedAt, new Date("2026-08-03T14:48:20-03:00").toISOString());
  assert.equal(parsed.parsed, true);
});

test("OLT normalizada: mesma chave de correlação da queda, para casar os dois eventos", () => {
  const queda = parseNetworkAlertMessage(OLT_DOWN, NOW);
  const normalizacao = parseNetworkAlertMessage(OLT_UP, NOW);
  assert.equal(normalizacao.resolved, true);
  assert.equal(normalizacao.startedAt, new Date("2026-08-03T14:48:20-03:00").toISOString());
  assert.equal(normalizacao.resolvedAt, new Date("2026-08-03T15:09:36-03:00").toISOString());
  assert.equal(normalizacao.correlationKey, queda.correlationKey, "sem isso o par queda/normalização vira dois alertas soltos");
});

test("rompimento de fibra: equipamento após 'em', descrição, data única e id do evento", () => {
  const parsed = parseNetworkAlertMessage(FIBER_DOWN, NOW);
  assert.equal(parsed.kind, "fiber_link");
  assert.equal(parsed.equipment, "SW-L3-COR-CDB-SUP-01");
  assert.equal(parsed.description, 'XGigabitEthernet0/0/12 - "Core: SW-L3-COR-ARYB-POV-01 (TE1/1/4) [10Gbps]" - DOWN');
  assert.equal(parsed.externalEventId, "129400624");
  assert.equal(parsed.correlationKey, "event:129400624");
  assert.equal(parsed.resolved, false);
  assert.equal(parsed.startedAt, new Date("2026-08-04T21:59:31-03:00").toISOString());
});

test("nunca decodifica o código do equipamento em cidade ou bairro", () => {
  const parsed = parseNetworkAlertMessage(OLT_DOWN, NOW);
  assert.ok(!("city" in parsed) && !("neighborhood" in parsed), "adivinhar geografia a partir do código seria inventar dado");
});

test("mensagem em formato desconhecido não é descartada, fica marcada como não interpretada", () => {
  const parsed = parseNetworkAlertMessage("Alguma mensagem qualquer que não bate com nenhum padrão conhecido.", NOW);
  assert.equal(parsed.kind, "unrecognized");
  assert.equal(parsed.parsed, false);
  assert.equal(parsed.startedAt, NOW, "sem data extraível, cai no horário de recebimento — nunca fica sem valor");
});

test("mensagem vazia não derruba o parser", () => {
  const parsed = parseNetworkAlertMessage("", NOW);
  assert.equal(parsed.kind, "unrecognized");
  assert.equal(parsed.equipment, "desconhecido");
});

test("sem data extraível, usa o horário de recebimento como início", () => {
  const parsed = parseNetworkAlertMessage("❌ OLT-TESTE possui alertas!\n\nDescrição:\nSem data nesta mensagem", NOW);
  assert.equal(parsed.startedAt, NOW);
});

test("continua reconhecendo o alerta mesmo com emoji e acento corrompidos (visto num teste manual real)", () => {
  const corrompido = '? Poss\uFFFDvel rompimento de fibra em SW-L3-COR-CDB-SUP-01\n\n\nDescri\uFFFD\uFFFD\uFFFDo do evento:\n XGigabitEthernet0/0/12 - "Core: SW-L3-COR-ARYB-POV-01 (TE1/1/4) [10Gbps]" - DOWN\n\nData: 2026.08.04 | 21:59:31\n\nID do evento: 129400624';
  const parsed = parseNetworkAlertMessage(corrompido, NOW);
  assert.equal(parsed.kind, "fiber_link");
  assert.equal(parsed.equipment, "SW-L3-COR-CDB-SUP-01");
  assert.equal(parsed.externalEventId, "129400624");
});
