import test from "node:test";
import assert from "node:assert/strict";
import { botMayReply, effectiveState, needsReply, waitTone, windowOpen, REPLY_WINDOW_MS } from "../lib/platform/conversation-state-shared.ts";
import { MemoryConversationStateRepository, botMayReplyNow, changeConversationState, claimIfUnassigned, stateKey } from "../lib/platform/conversation-state-service.ts";
import { MemoryConversationsRepository } from "../lib/platform/conversations-service.ts";

const CHANNEL = "n8n-whatsapp";
const CLIENTE = "5579991234567";
const ANA = { id: "u-ana", name: "Ana Souza", email: "ana@bbnet.com.br", role: "Atendente" };
const BRUNO = { id: "u-bruno", name: "Bruno Lima", email: "bruno@bbnet.com.br", role: "Atendente" };
const T0 = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

function montar(ultimaFala = iso(-60_000)) {
  const repository = new MemoryConversationStateRepository();
  repository.conversations.set(stateKey(CHANNEL, CLIENTE), ultimaFala);
  const agir = (action, actor = ANA, extra = {}) => changeConversationState(repository, { channel: CHANNEL, conversationId: CLIENTE, action, actor, now: () => T0, ...extra });
  return { repository, agir };
}

test("sem linha gravada a conversa está aberta e com a IA", () => {
  const state = effectiveState(undefined, iso(0));
  assert.equal(state.status, "open");
  assert.equal(state.assigneeId, null);
  assert.equal(botMayReply(undefined), true);
});

test("assumir torna a pessoa responsável, cala a IA e vai para a auditoria", async () => {
  const { repository, agir } = montar();
  const result = await agir("claim");
  assert.equal(result.ok, true);
  assert.equal(result.state.assigneeName, "Ana Souza");
  assert.equal(botMayReply(repository.states.get(stateKey(CHANNEL, CLIENTE))), false);
  assert.equal(repository.audits.length, 1);
  assert.equal(repository.audits[0].action, "conversation.claim");
  assert.equal(repository.audits[0].entity, `conversation:${CLIENTE}`);
});

test("assumir de novo o que já é seu não grava outra linha", async () => {
  const { repository, agir } = montar();
  await agir("claim");
  const again = await agir("claim");
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(repository.audits.length, 1);
});

test("conversa de colega só é tomada com confirmação, e a auditoria diz de quem era", async () => {
  const { repository, agir } = montar();
  await agir("claim", ANA);
  const refused = await agir("claim", BRUNO);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(refused.state.assigneeName, "Ana Souza");
  const taken = await agir("claim", BRUNO, { takeOver: true });
  assert.equal(taken.ok, true);
  assert.equal(taken.state.assigneeId, "u-bruno");
  assert.match(repository.audits.at(-1).reason, /estava com Ana Souza/);
});

test("devolver para a IA tira o responsável e deixa a IA responder", async () => {
  const { repository, agir } = montar();
  await agir("claim");
  const released = await agir("release");
  assert.equal(released.state.assigneeId, null);
  assert.equal(botMayReply(repository.states.get(stateKey(CHANNEL, CLIENTE))), true);
  assert.match(repository.audits.at(-1).reason, /Devolveu a conversa para a IA \(estava com Ana Souza\)/);
});

test("resolvida volta aberta e sem responsável quando o cliente escreve depois", async () => {
  const { repository, agir } = montar(iso(-60_000));
  await agir("claim");
  const resolved = await agir("resolve");
  assert.equal(resolved.state.status, "resolved");
  assert.equal(resolved.state.resolvedBy, "Ana Souza");
  const row = repository.states.get(stateKey(CHANNEL, CLIENTE));
  // Antes de o cliente falar: continua resolvida, com quem atendeu.
  assert.equal(effectiveState(row, iso(-60_000)).status, "resolved");
  // Fala nova depois de resolver: aberta, reaberta e de volta para a IA.
  const reopened = effectiveState(row, iso(5 * 60_000));
  assert.equal(reopened.status, "open");
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.assigneeId, null);
  // Resolvida não segura a IA: a fala nova reabre a conversa.
  assert.equal(botMayReply(row), true);
});

test("reabrir à mão devolve a conversa para a fila", async () => {
  const { agir } = montar();
  await agir("resolve");
  const reopened = await agir("reopen");
  assert.equal(reopened.state.status, "open");
  assert.equal(reopened.state.assigneeId, null);
});

test("sem login não há responsável, e conversa inexistente é recusada", async () => {
  const { agir, repository } = montar();
  const anonymous = await changeConversationState(repository, { channel: CHANNEL, conversationId: CLIENTE, action: "claim" });
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.status, 401);
  const missing = await changeConversationState(repository, { channel: CHANNEL, conversationId: "5579000000000", action: "claim", actor: ANA });
  assert.equal(missing.status, 404);
  const invalid = await agir("apagar");
  assert.equal(invalid.status, 400);
  const group = await changeConversationState(repository, { channel: CHANNEL, conversationId: "120363@g.us", action: "claim", actor: ANA });
  assert.equal(group.status, 400);
});

test("quem responde pela tela vira responsável só se ninguém era", async () => {
  const { repository, agir } = montar();
  await claimIfUnassigned(repository, CHANNEL, CLIENTE, ANA);
  assert.equal(repository.states.get(stateKey(CHANNEL, CLIENTE)).assigneeId, "u-ana");
  await claimIfUnassigned(repository, CHANNEL, CLIENTE, BRUNO);
  assert.equal(repository.states.get(stateKey(CHANNEL, CLIENTE)).assigneeId, "u-ana");
  await agir("release");
  await claimIfUnassigned(repository, CHANNEL, CLIENTE, undefined);
  assert.equal(repository.states.get(stateKey(CHANNEL, CLIENTE)).assigneeId, null);
});

test("estado ilegível cala a IA: na dúvida ela só sugere", async () => {
  const { repository } = montar();
  assert.equal(await botMayReplyNow(repository, CHANNEL, CLIENTE), true);
  repository.failReads = true;
  assert.equal(await botMayReplyNow(repository, CHANNEL, CLIENTE), false);
});

test("a fila conta só quem espera, está aberto e ainda pode ser respondido", () => {
  const now = T0;
  const fresh = { awaitingSince: iso(-10 * 60_000), lastCustomerAt: iso(-10 * 60_000), state: effectiveState(undefined, iso(0)) };
  assert.equal(needsReply(fresh, now), true);
  // Janela da Meta fechada: ninguém consegue responder, não entra na fila.
  const stale = { awaitingSince: iso(-REPLY_WINDOW_MS - 60_000), lastCustomerAt: iso(-REPLY_WINDOW_MS - 60_000) };
  assert.equal(needsReply(stale, now), false);
  assert.equal(windowOpen(stale.lastCustomerAt, now), false);
  // Resolvida não está na fila, mesmo com o cliente tendo falado por último antes.
  const done = { ...fresh, state: { ...fresh.state, status: "resolved" } };
  assert.equal(needsReply(done, now), false);
  // Ninguém esperando.
  assert.equal(needsReply({ lastCustomerAt: iso(-60_000) }, now), false);
});

test("a cor da espera segue 5 e 30 minutos", () => {
  assert.equal(waitTone(iso(-2 * 60_000), T0), "ok");
  assert.equal(waitTone(iso(-10 * 60_000), T0), "warn");
  assert.equal(waitTone(iso(-45 * 60_000), T0), "bad");
});

test("a lista traz a fala do cliente, o estado e o nome de quem respondeu", async () => {
  const conversations = new MemoryConversationsRepository();
  conversations.add({ channel: CHANNEL, externalConversationId: CLIENTE, role: "customer", content: "minha net caiu", createdAt: iso(-120_000) });
  conversations.add({ channel: CHANNEL, externalConversationId: CLIENTE, role: "suggestion", content: "Vou verificar sua conexão.", createdAt: iso(-119_000) });
  conversations.states.set(stateKey(CHANNEL, CLIENTE), { status: "open", assigneeId: "u-ana", assigneeName: "Ana Souza", assignedAt: iso(-60_000), resolvedAt: null, resolvedBy: null });
  const [item] = await conversations.listConversations(10);
  assert.equal(item.lastRole, "suggestion");
  assert.equal(item.lastCustomerMessage, "minha net caiu");
  assert.equal(item.lastCustomerAt, iso(-120_000));
  assert.equal(item.state.assigneeName, "Ana Souza");

  conversations.userNames.set("ana@bbnet.com.br", "Ana Souza");
  conversations.add({ channel: CHANNEL, externalConversationId: CLIENTE, role: "agent", content: "Vou verificar sua conexão.", createdAt: iso(-30_000), sentBy: "ana@bbnet.com.br" });
  const [after] = await conversations.listConversations(10);
  assert.equal(after.lastSentByName, "Ana Souza");
  const messages = await conversations.getMessages(CHANNEL, CLIENTE, 10);
  assert.equal(messages.at(-1).sentByName, "Ana Souza");
});
