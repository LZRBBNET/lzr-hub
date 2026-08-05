import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryTeamsRepository, TeamValidationError, parseTeamInput, summarizeTeamLoad, unclaimedReasons,
} from "../lib/platform/teams-service.ts";
import { HANDOFF_REASONS } from "../lib/platform/teams-shared.ts";

const input = (over = {}) => ({ name: "Suporte técnico", queue: "suporte-tecnico", handoffReasons: ["low_intent_confidence"], ...over });

test("nome e fila são validados", () => {
  assert.throws(() => parseTeamInput(input({ name: "A" })), TeamValidationError, "nome curto demais passou");
  assert.throws(() => parseTeamInput(input({ name: "x".repeat(61) })), TeamValidationError);
  for (const queue of ["Suporte Técnico", "suporte tecnico", "a", "", "fila_com_underline", "-comeca-com-hifen"]) {
    assert.throws(() => parseTeamInput(input({ queue })), TeamValidationError, `aceitou a fila "${queue}"`);
  }
  // Maiúscula não é erro: a fila é normalizada, não recusada.
  assert.equal(parseTeamInput(input({ queue: "Suporte-Tecnico" })).queue, "suporte-tecnico");
  assert.equal(parseTeamInput(input({ queue: "SUPORTE" })).queue, "suporte");
});

test("motivo de transbordo fora da lista é recusado", () => {
  assert.throws(() => parseTeamInput(input({ handoffReasons: ["motivo_inventado"] })), TeamValidationError);
  // Recusar importa: equipe apontando para motivo inexistente ficaria esperando
  // trabalho que nunca chega, e a tela mostraria carga zero como se fosse folga.
  for (const reason of HANDOFF_REASONS) {
    assert.deepEqual(parseTeamInput(input({ handoffReasons: [reason] })).handoffReasons, [reason]);
  }
});

test("motivo repetido não duplica", () => {
  const parsed = parseTeamInput(input({ handoffReasons: ["low_intent_confidence", "low_intent_confidence", "cancellation_risk"] }));
  assert.deepEqual(parsed.handoffReasons, ["low_intent_confidence", "cancellation_risk"]);
});

test("descrição vazia vira ausência, não string vazia", () => {
  assert.equal(parseTeamInput(input()).description, null);
  assert.equal(parseTeamInput(input({ description: "  " })).description, null);
  assert.equal(parseTeamInput(input({ description: "Atende N1" })).description, "Atende N1");
});

test("criar, vincular pessoa e desvincular", async () => {
  const repository = new MemoryTeamsRepository();
  repository.people.set("u1", { userId: "u1", name: "Camila Torres", email: "camila@bbnet.dev", role: "Supervisor", active: true });
  const team = await repository.create(parseTeamInput(input()));

  assert.equal(await repository.addMember(team.id, "u1"), true);
  assert.equal(await repository.addMember(team.id, "u1"), false, "vincular duas vezes não duplica");
  assert.equal((await repository.list())[0].members[0].name, "Camila Torres");

  assert.equal(await repository.removeMember(team.id, "u1"), true);
  assert.equal(await repository.removeMember(team.id, "u1"), false, "remover quem não está vinculado avisa");
  assert.equal((await repository.list())[0].members.length, 0);
});

test("desativar equipe não a apaga", async () => {
  const repository = new MemoryTeamsRepository();
  const team = await repository.create(parseTeamInput(input()));
  assert.equal(await repository.setActive(team.id, false), true);
  const list = await repository.list();
  assert.equal(list.length, 1, "a equipe continua no histórico");
  assert.equal(list[0].active, false);
  assert.equal(await repository.setActive("nao-existe", false), false);
});

test("a carga da equipe vem dos transbordos medidos, não de estimativa", async () => {
  const repository = new MemoryTeamsRepository();
  const tecnico = await repository.create(parseTeamInput(input({ handoffReasons: ["low_intent_confidence", "customer_irritated"] })));
  const retencao = await repository.create(parseTeamInput(input({ name: "Retenção", queue: "retencao", handoffReasons: ["cancellation_risk"] })));

  for (let i = 0; i < 5; i++) repository.recordHandoff("low_intent_confidence");
  for (let i = 0; i < 2; i++) repository.recordHandoff("customer_irritated");
  repository.recordHandoff("cancellation_risk");
  repository.recordHandoff("unauthorized_request");

  const counts = await repository.loadSince("2000-01-01T00:00:00.000Z");
  const load = summarizeTeamLoad(await repository.list(), counts);

  assert.equal(load.find((l) => l.teamId === tecnico.id).handoffs, 7);
  assert.equal(load.find((l) => l.teamId === retencao.id).handoffs, 1);
  assert.deepEqual(load.find((l) => l.teamId === tecnico.id).byReason, { low_intent_confidence: 5, customer_irritated: 2 });
});

test("motivo que ninguém assumiu aparece como descoberto", async () => {
  const repository = new MemoryTeamsRepository();
  await repository.create(parseTeamInput(input({ handoffReasons: ["low_intent_confidence"] })));
  repository.recordHandoff("low_intent_confidence");
  repository.recordHandoff("unauthorized_request");
  repository.recordHandoff("unauthorized_request");

  const counts = await repository.loadSince("2000-01-01T00:00:00.000Z");
  const orfaos = unclaimedReasons(await repository.list(), counts);
  assert.deepEqual(orfaos, [{ reason: "unauthorized_request", count: 2 }]);
});

test("equipe desativada não cobre motivo nenhum", async () => {
  const repository = new MemoryTeamsRepository();
  const team = await repository.create(parseTeamInput(input({ handoffReasons: ["cancellation_risk"] })));
  repository.recordHandoff("cancellation_risk");
  await repository.setActive(team.id, false);

  const counts = await repository.loadSince("2000-01-01T00:00:00.000Z");
  assert.deepEqual(unclaimedReasons(await repository.list(), counts), [{ reason: "cancellation_risk", count: 1 }],
    "com a equipe desativada o motivo volta a ficar descoberto");
});

test("dois times podem assumir o mesmo motivo, e conta para os dois", async () => {
  const repository = new MemoryTeamsRepository();
  const a = await repository.create(parseTeamInput(input({ name: "N1", queue: "n1", handoffReasons: ["low_intent_confidence"] })));
  const b = await repository.create(parseTeamInput(input({ name: "N2", queue: "n2", handoffReasons: ["low_intent_confidence"] })));
  repository.recordHandoff("low_intent_confidence");
  repository.recordHandoff("low_intent_confidence");

  const load = summarizeTeamLoad(await repository.list(), await repository.loadSince("2000-01-01T00:00:00.000Z"));
  assert.equal(load.find((l) => l.teamId === a.id).handoffs, 2);
  assert.equal(load.find((l) => l.teamId === b.id).handoffs, 2, "sem roteamento, assumir é declaração e não posse");
});

test("a janela do período recorta os transbordos", async () => {
  const repository = new MemoryTeamsRepository();
  await repository.create(parseTeamInput(input()));
  repository.recordHandoff("low_intent_confidence", "2026-08-01T00:00:00.000Z");
  repository.recordHandoff("low_intent_confidence", "2026-07-01T00:00:00.000Z");
  const recentes = await repository.loadSince("2026-07-20T00:00:00.000Z");
  assert.deepEqual(recentes, [{ reason: "low_intent_confidence", count: 1 }]);
});
