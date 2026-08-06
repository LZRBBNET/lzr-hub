import test from "node:test";
import assert from "node:assert/strict";
import { MemoryNetworkAlertsRepository, suggestsMassiva } from "../lib/platform/network-alerts-service.ts";
import { parseNetworkAlertMessage } from "../lib/integrations/telegram/network-alert-parser.ts";

const NOW = "2026-08-06T12:00:00.000Z";
const OLT_DOWN = "❌ OLT-TESTE-01 possui alertas!\n\nDescrição:\nInterface x está DOWN\n\nInício:\nData: 2026.08.06 | Hora: 09:00:00";
const OLT_UP = "✅ OLT-TESTE-01 normalizado!\n\nDescrição:\nInterface x está DOWN\n\nInício do Evento:\nData: 2026.08.06 | Hora: 09:00:00\n\nRecuperação:\nData: 2026.08.06 | Hora: 09:20:00";

test("queda cria uma linha aberta", async () => {
  const repository = new MemoryNetworkAlertsRepository();
  const { row, created } = await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_DOWN, NOW), OLT_DOWN, "telegram");
  assert.equal(created, true);
  assert.equal(row.status, "open");
  assert.equal((await repository.listOpen()).length, 1);
});

test("normalização fecha a mesma linha em vez de criar uma segunda", async () => {
  const repository = new MemoryNetworkAlertsRepository();
  await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_DOWN, NOW), OLT_DOWN, "telegram");
  const { created } = await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_UP, NOW), OLT_UP, "telegram");
  assert.equal(created, false, "normalização não cria linha nova");
  assert.equal(repository.rows.length, 1, "queda e normalização são um único registro");
  assert.equal((await repository.listOpen()).length, 0);
  assert.equal(repository.rows[0].status, "resolved");
});

test("reentrega da mesma queda (Telegram reenviando) não duplica", async () => {
  const repository = new MemoryNetworkAlertsRepository();
  await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_DOWN, NOW), OLT_DOWN, "telegram");
  const { created } = await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_DOWN, NOW), OLT_DOWN, "telegram");
  assert.equal(created, false);
  assert.equal(repository.rows.length, 1);
});

test("mesmo equipamento cai de novo depois de já ter sido normalizado: vira ocorrência nova, não reabre a antiga", async () => {
  const repository = new MemoryNetworkAlertsRepository();
  await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_DOWN, NOW), OLT_DOWN, "telegram");
  await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_UP, NOW), OLT_UP, "telegram");
  const { created } = await repository.upsertFromMessage(parseNetworkAlertMessage(OLT_DOWN, NOW), OLT_DOWN, "telegram");
  assert.equal(created, true, "uma nova queda depois de resolvida é um incidente novo");
  assert.equal(repository.rows.length, 2);
  assert.equal((await repository.listOpen()).length, 1);
});

test("sugestão de massiva só aparece a partir do limiar de alertas simultâneos", () => {
  const alerta = { id: "1", source: "telegram", kind: "olt_interface", equipment: "x", description: null, status: "open", externalEventId: null, correlationKey: "k", startedAt: NOW, resolvedAt: null, rawText: "", parsed: true, createdAt: NOW };
  assert.equal(suggestsMassiva([alerta, alerta]), false);
  assert.equal(suggestsMassiva([alerta, alerta, alerta]), true);
});
