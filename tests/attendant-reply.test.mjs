import test from "node:test";
import assert from "node:assert/strict";
import { MemoryReplyRepository, REPLY_WINDOW_MS, sendAttendantReply } from "../lib/platform/attendant-reply-service.ts";

const CHANNEL = "n8n-whatsapp";
const CLIENTE = "5579991234567";

function montar({ enabled = true, comConfig = true, fetcher, mensagemDoClienteHa = 60_000 } = {}) {
  const repository = new MemoryReplyRepository();
  const chamadas = [];
  const padrao = async (url, init) => {
    const body = JSON.parse(init.body);
    chamadas.push({ url, body });
    return { status: 200, json: async () => (body.status === "read" ? { success: true } : { messages: [{ id: "wamid.SAIDA1" }] }) };
  };
  const estado = { fetcher: fetcher ?? padrao };
  const config = comConfig ? { accessToken: "TOKEN-SECRETO", phoneNumberId: "999", graphVersion: "v26.0", fetcher: (...args) => estado.fetcher(...args) } : undefined;
  repository.customerMessages.push({ channel: CHANNEL, conversationId: CLIENTE, createdAt: new Date(Date.now() - mensagemDoClienteHa).toISOString(), externalMessageId: "wamid.ENTRADA1" });
  return { repository, chamadas, estado, deps: { repository, config, enabled } };
}

const pedido = (over = {}) => ({
  channel: CHANNEL, conversationId: CLIENTE, text: "Olá! Vamos verificar sua conexão.",
  idempotencyKey: "clique-0001-abcdef", actor: { email: "ana@bbnet.com.br", role: "Atendente" }, ...over,
});
const envios = (chamadas) => chamadas.filter((c) => c.body.type === "text");

test("envia, grava como resposta do atendente e audita", async () => {
  const { repository, chamadas, deps } = montar();
  const result = await sendAttendantReply(deps, pedido());
  assert.equal(result.ok, true);
  assert.equal(result.messageId, "wamid.SAIDA1");
  assert.equal(result.duplicate, false);
  assert.equal(result.recorded, true);

  assert.equal(envios(chamadas).length, 1);
  assert.equal(envios(chamadas)[0].body.to, CLIENTE);
  assert.equal(envios(chamadas)[0].body.text.body, "Olá! Vamos verificar sua conexão.");

  assert.equal(repository.sent.length, 1);
  assert.equal(repository.sent[0].sentBy, "ana@bbnet.com.br", "autoria registrada, não 'a IA'");
  assert.equal(repository.sent[0].externalMessageId, "wamid.SAIDA1");

  assert.equal(repository.audits.length, 1);
  assert.equal(repository.audits[0].action, "whatsapp.reply.sent");
  assert.match(repository.audits[0].reason, /ENVIADA ao cliente/);
  assert.equal(repository.audits[0].actor.email, "ana@bbnet.com.br");
});

test("marca a mensagem do cliente como lida antes de responder", async () => {
  const { chamadas, deps } = montar();
  await sendAttendantReply(deps, pedido());
  assert.equal(chamadas[0].body.status, "read");
  assert.equal(chamadas[0].body.message_id, "wamid.ENTRADA1");
  assert.equal(chamadas[1].body.type, "text", "a leitura vem antes do texto");
});

test("falha ao marcar como lida não impede a resposta", async () => {
  const { chamadas, estado, deps } = montar();
  estado.fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    chamadas.push({ url, body });
    if (body.status === "read") return { status: 400, json: async () => ({ error: { code: 100, message: "x" } }) };
    return { status: 200, json: async () => ({ messages: [{ id: "wamid.SAIDA1" }] }) };
  };
  assert.equal((await sendAttendantReply(deps, pedido())).ok, true);
});

test("sem login não há autor, e mensagem a cliente sem autor não sai", async () => {
  const { chamadas, repository, deps } = montar();
  const result = await sendAttendantReply(deps, pedido({ actor: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(chamadas.length, 0);
  assert.equal(repository.audits[0].action, "whatsapp.reply.blocked", "bloqueio também entra no rastro");
});

test("flag desligada e envio não configurado recusam sem chamar a Meta", async () => {
  const desligada = montar({ enabled: false });
  const a = await sendAttendantReply(desligada.deps, pedido());
  assert.equal(a.status, 503);
  assert.equal(desligada.chamadas.length, 0);

  const semConfig = montar({ comConfig: false });
  const b = await sendAttendantReply(semConfig.deps, pedido());
  assert.equal(b.status, 503);
  assert.match(b.reason, /não está configurado/);
});

test("texto de homologação nunca vai a cliente real", async () => {
  for (const texto of ["Preparei a segunda via fictícia.", "No ambiente de homologação, tudo certo.", "Diagnóstico simulado: ONU online."]) {
    const { chamadas, deps } = montar();
    const result = await sendAttendantReply(deps, pedido({ text: texto }));
    assert.equal(result.ok, false, texto);
    assert.equal(result.status, 422);
    assert.equal(chamadas.length, 0);
  }
});

test("fora da janela de 24 horas a Meta não aceita texto livre, e nem tentamos", async () => {
  const dentro = montar({ mensagemDoClienteHa: REPLY_WINDOW_MS - 60_000 });
  assert.equal((await sendAttendantReply(dentro.deps, pedido())).ok, true);

  const fora = montar({ mensagemDoClienteHa: REPLY_WINDOW_MS + 60_000 });
  const result = await sendAttendantReply(fora.deps, pedido());
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.reason, /24 horas/);
  assert.equal(fora.chamadas.length, 0);
});

test("conversa sem mensagem do cliente não tem a quem responder", async () => {
  const { chamadas, deps } = montar();
  const result = await sendAttendantReply(deps, pedido({ conversationId: "5579988887777" }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(chamadas.length, 0);
});

test("grupo, id que não é telefone, texto vazio e texto longo demais são recusados na entrada", async () => {
  const { chamadas, deps } = montar();
  assert.equal((await sendAttendantReply(deps, pedido({ conversationId: "120363373173147301@g.us" }))).status, 400);
  assert.equal((await sendAttendantReply(deps, pedido({ conversationId: "abc" }))).status, 400);
  assert.equal((await sendAttendantReply(deps, pedido({ text: "   " }))).status, 400);
  assert.equal((await sendAttendantReply(deps, pedido({ text: "a".repeat(4097) }))).status, 400);
  assert.equal((await sendAttendantReply(deps, pedido({ idempotencyKey: "curta" }))).status, 400);
  assert.equal(chamadas.length, 0);
});

test("o mesmo clique repetido devolve o resultado e não reenvia", async () => {
  const { chamadas, repository, deps } = montar();
  const primeira = await sendAttendantReply(deps, pedido());
  const segunda = await sendAttendantReply(deps, pedido());
  assert.equal(primeira.ok, true);
  assert.equal(segunda.ok, true);
  assert.equal(segunda.duplicate, true);
  assert.equal(segunda.messageId, primeira.messageId);
  assert.equal(envios(chamadas).length, 1);
  assert.equal(repository.sent.length, 1);
});

test("dois cliques simultâneos não passam os dois", async () => {
  const { chamadas, deps } = montar();
  const [a, b] = await Promise.all([sendAttendantReply(deps, pedido()), sendAttendantReply(deps, pedido())]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal([a, b].find((r) => !r.ok).status, 409);
  assert.equal(envios(chamadas).length, 1);
});

test("quando a Meta recusa, a reserva é solta e o atendente pode tentar de novo", async () => {
  const { chamadas, estado, repository, deps } = montar();
  estado.fetcher = async () => ({ status: 400, json: async () => ({ error: { code: 131047, message: "Re-engagement" } }) });
  const recusada = await sendAttendantReply(deps, pedido());
  assert.equal(recusada.ok, false);
  assert.equal(recusada.status, 422);
  assert.equal(repository.sent.length, 0, "nada gravado como enviado");
  assert.equal(repository.audits.at(-1).action, "whatsapp.reply.failed");

  estado.fetcher = async (url, init) => { const body = JSON.parse(init.body); chamadas.push({ url, body }); return { status: 200, json: async () => ({ messages: [{ id: "wamid.SAIDA2" }] }) }; };
  const tentativa = await sendAttendantReply(deps, pedido());
  assert.equal(tentativa.ok, true, "a mesma chave serve de novo: a primeira não saiu");
});

test("em timeout a mensagem pode ter saído, então a reserva fica e o reenvio é barrado", async () => {
  const { estado, repository, deps } = montar();
  estado.fetcher = (_url, init) => {
    if (JSON.parse(init.body).status === "read") return Promise.resolve({ status: 200, json: async () => ({ success: true }) });
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" }))));
  };
  deps.config.timeoutMs = 20;
  const lenta = await sendAttendantReply(deps, pedido());
  assert.equal(lenta.ok, false);
  assert.equal(lenta.status, 502);
  assert.equal(repository.audits.at(-1).result, "unknown");

  estado.fetcher = async () => ({ status: 200, json: async () => ({ messages: [{ id: "wamid.X" }] }) });
  const reenvio = await sendAttendantReply(deps, pedido());
  assert.equal(reenvio.ok, false, "reenviar com a mesma chave poderia duplicar a mensagem ao cliente");
  assert.equal(reenvio.status, 409);
});

test("a auditoria sanitiza o texto e nunca guarda o token", async () => {
  const { repository, deps } = montar();
  await sendAttendantReply(deps, pedido({ text: "Seu CPF 529.982.247-25 e e-mail ana@cliente.com estão corretos?" }));
  const todo = JSON.stringify(repository.audits);
  assert.doesNotMatch(todo, /529\.982\.247-25/);
  assert.doesNotMatch(todo, /ana@cliente\.com/);
  assert.doesNotMatch(todo, /TOKEN-SECRETO/);
});

test("se a Meta aceitou mas o histórico não gravou, o resultado diz isso em vez de fingir", async () => {
  const { repository, deps } = montar();
  repository.saveSent = async () => { throw new Error("banco fora"); };
  const result = await sendAttendantReply(deps, pedido());
  assert.equal(result.ok, true, "a mensagem saiu");
  assert.equal(result.recorded, false, "mas não ficou registrada, e quem chama precisa saber");
});
