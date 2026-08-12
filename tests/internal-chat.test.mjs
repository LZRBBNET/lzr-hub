import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryInternalChatRepository, InternalChatValidationError,
  countUnread, normalizeParticipants, parseMessageBody, parseSubject,
} from "../lib/platform/internal-chat-service.ts";

async function setup() {
  const repository = new MemoryInternalChatRepository();
  repository.people.push(
    { id: "ana", name: "Ana Souza", role: "Atendente" },
    { id: "bruno", name: "Bruno Lima", role: "Suporte" },
    { id: "carla", name: "Carla Dias", role: "Supervisor" },
  );
  return repository;
}

test("assunto e mensagem são validados", () => {
  assert.throws(() => parseSubject("oi"), InternalChatValidationError);
  assert.throws(() => parseSubject("x".repeat(121)), InternalChatValidationError);
  assert.equal(parseSubject("  Cliente sem conexão  "), "Cliente sem conexão");
  assert.throws(() => parseMessageBody("   "), InternalChatValidationError);
  assert.throws(() => parseMessageBody("x".repeat(4001)), InternalChatValidationError);
});

test("quem abre a conversa participa dela sempre", () => {
  // Sem isto daria para criar conversa que o próprio autor não consegue ler.
  assert.deepEqual(normalizeParticipants("ana", ["bruno"]), ["ana", "bruno"]);
  assert.deepEqual(normalizeParticipants("ana", ["ana", "bruno"]), ["ana", "bruno"], "sem duplicar o autor");
});

test("conversa precisa de pelo menos duas pessoas", () => {
  assert.throws(() => normalizeParticipants("ana", []), InternalChatValidationError);
  assert.throws(() => normalizeParticipants("ana", ["ana"]), InternalChatValidationError);
});

test("quem não participa não enxerga a conversa", async () => {
  const repository = await setup();
  const id = await repository.createThread({ subject: "Caso do cliente 21857", authorId: "ana", participantIds: ["ana", "bruno"] });
  assert.ok(await repository.getThread(id, "ana"));
  assert.equal(await repository.getThread(id, "carla"), undefined, "terceiro não lê conversa alheia");
  assert.equal((await repository.listThreadsFor("carla")).length, 0);
});

test("quem não participa também não consegue escrever", async () => {
  const repository = await setup();
  const id = await repository.createThread({ subject: "Discussão interna", authorId: "ana", participantIds: ["ana", "bruno"] });
  assert.equal(await repository.addMessage(id, "carla", "posso opinar?"), undefined);
  assert.equal(repository.messages.length, 0, "a mensagem não pode nem ser gravada");
});

test("conversa inexistente não distingue de conversa alheia", async () => {
  const repository = await setup();
  // Devolver "não existe" para uma e "sem acesso" para outra revelaria quais
  // conversas existem no sistema.
  assert.equal(await repository.getThread("id-que-nao-existe", "ana"), undefined);
});

test("mensagens aparecem em ordem para quem participa", async () => {
  const repository = await setup();
  const id = await repository.createThread({ subject: "Sem conexão no Centro", authorId: "ana", participantIds: ["ana", "bruno"] });
  await repository.addMessage(id, "ana", "Cliente diz que caiu de novo");
  await repository.addMessage(id, "bruno", "Vou olhar a OLT");
  const view = await repository.getThread(id, "bruno");
  assert.deepEqual(view.messages.map((m) => m.body), ["Cliente diz que caiu de novo", "Vou olhar a OLT"]);
  assert.equal(view.messages[0].authorName, "Ana Souza");
});

test("não lida conta só mensagem dos outros", () => {
  const messages = [
    { authorId: "ana", createdAt: "2026-08-12T10:00:00.000Z" },
    { authorId: "bruno", createdAt: "2026-08-12T11:00:00.000Z" },
    { authorId: "bruno", createdAt: "2026-08-12T12:00:00.000Z" },
  ];
  assert.equal(countUnread(messages, "ana", null), 2, "as próprias mensagens nunca são novidade para quem escreveu");
  assert.equal(countUnread(messages, "ana", "2026-08-12T11:30:00.000Z"), 1);
  assert.equal(countUnread(messages, "bruno", null), 1);
});

test("escrever marca a própria conversa como lida", async () => {
  const repository = await setup();
  const id = await repository.createThread({ subject: "Caso difícil", authorId: "ana", participantIds: ["ana", "bruno"] });
  await repository.addMessage(id, "bruno", "olha isso");
  assert.equal((await repository.listThreadsFor("ana"))[0].unread, 1);
  await repository.addMessage(id, "ana", "vi, obrigado");
  assert.equal((await repository.listThreadsFor("ana"))[0].unread, 0);
});

test("marcar como lida zera o contador sem apagar mensagem", async () => {
  const repository = await setup();
  const threadId = await repository.createThread({ subject: "Assunto", authorId: "ana", participantIds: ["ana", "bruno"] });
  await repository.addMessage(threadId, "bruno", "primeira");
  await repository.markRead(threadId, "ana");
  const lista = await repository.listThreadsFor("ana");
  assert.equal(lista[0].unread, 0);
  assert.equal((await repository.getThread(threadId, "ana")).messages.length, 1);
});

test("conversa pode ser vinculada a um atendimento, e o vínculo aparece", async () => {
  const repository = await setup();
  const id = await repository.createThread({ subject: "Dúvida no caso", linkedConversationId: "5579998307232", authorId: "ana", participantIds: ["ana", "carla"] });
  assert.equal((await repository.getThread(id, "carla")).thread.linkedConversationId, "5579998307232");
});

test("lista ordena pela conversa com mensagem mais recente", async () => {
  const repository = await setup();
  const antiga = await repository.createThread({ subject: "Antiga", authorId: "ana", participantIds: ["ana", "bruno"] });
  const nova = await repository.createThread({ subject: "Nova", authorId: "ana", participantIds: ["ana", "bruno"] });
  await repository.addMessage(antiga, "bruno", "resposta tardia");
  const lista = await repository.listThreadsFor("ana");
  assert.equal(lista[0].id, antiga, "quem recebeu mensagem por último aparece primeiro");
  assert.equal(lista[1].id, nova);
});

test("participantes vêm com nome e papel para a tela não precisar de outra consulta", async () => {
  const repository = await setup();
  await repository.createThread({ subject: "Com quem falo", authorId: "ana", participantIds: ["ana", "carla"] });
  const lista = await repository.listThreadsFor("ana");
  assert.deepEqual(lista[0].participants.map((p) => `${p.name} (${p.role})`).sort(), ["Ana Souza (Atendente)", "Carla Dias (Supervisor)"]);
});
