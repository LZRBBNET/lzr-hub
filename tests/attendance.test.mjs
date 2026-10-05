import test from "node:test";
import assert from "node:assert/strict";
import { parseMetaMessages, parseMetaStatuses } from "../lib/integrations/meta/webhook-parser.ts";
import { describeMetaError } from "../lib/integrations/meta/cloud-client.ts";
import { MemoryChannelRepository, recordUnsupportedMessage, unsupportedMessageText } from "../lib/platform/n8n-channel-service.ts";
import { MemoryContactsRepository, cleanDisplayName, rememberContactName } from "../lib/platform/channel-contacts.ts";
import { MemoryDeliveryRepository, applyStatuses, deliveryError } from "../lib/platform/delivery-status-service.ts";
import { MemoryConversationsRepository, awaitingSinceFrom, replyWindowFrom, searchTerm } from "../lib/platform/conversations-service.ts";

const webhook = (...values) => ({
  object: "whatsapp_business_account",
  entry: values.map((value, i) => ({ id: `waba-${i}`, changes: [{ field: "messages", value }] })),
});
const valor = (messages, contacts = [{ profile: { name: "Vinicius" }, wa_id: "557999151289" }]) => ({
  messaging_product: "whatsapp", metadata: { phone_number_id: "1377624278760819" }, contacts, messages,
});
const msg = (over) => ({ from: "557999151289", id: `wamid.${Math.random().toString(36).slice(2)}`, timestamp: "1749416383", ...over });

/* ------------------------------------------------------------- lote --- */

test("todas as mensagens do lote são lidas, não só a primeira", () => {
  const lidas = parseMetaMessages(webhook(
    valor([msg({ type: "text", text: { body: "oi" } }), msg({ type: "text", text: { body: "sem internet" } })]),
    valor([msg({ from: "5579988887777", type: "text", text: { body: "boleto" } })], [{ profile: { name: "Ana" }, wa_id: "5579988887777" }]),
  ));
  assert.deepEqual(lidas.map((m) => m.text), ["oi", "sem internet", "boleto"]);
  assert.equal(lidas[2].profileName, "Ana", "o nome é o do remetente, não o do primeiro contato do lote");
});

test("áudio, foto e documento chegam como tipo próprio, com legenda separada da fala", () => {
  const [audio, foto, documento] = parseMetaMessages(webhook(valor([
    msg({ type: "audio", audio: { id: "m1", mime_type: "audio/ogg" } }),
    msg({ type: "image", image: { id: "m2", caption: "meu boleto" } }),
    msg({ type: "document", document: { id: "m3", filename: "x.pdf" } }),
  ])));
  assert.equal(audio.kind, "audio");
  assert.equal(audio.text, "", "não há fala para a IA classificar");
  assert.equal(foto.kind, "image");
  assert.equal(foto.caption, "meu boleto");
  assert.equal(foto.text, "", "legenda não é tratada como pedido do cliente");
  assert.equal(documento.kind, "document");
});

test("resposta a botão vira texto; reação e aviso de sistema não são fala", () => {
  const lidas = parseMetaMessages(webhook(valor([
    msg({ type: "button", button: { text: "Falar com atendente" } }),
    msg({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "1", title: "Segunda via" } } }),
    msg({ type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } }),
    msg({ type: "system", system: { body: "trocou de número" } }),
  ])));
  assert.deepEqual(lidas.map((m) => [m.kind, m.text]), [["text", "Falar com atendente"], ["text", "Segunda via"]]);
});

test("tipo desconhecido não some: vira 'other' para o atendente ver", () => {
  const [lida] = parseMetaMessages(webhook(valor([msg({ type: "unsupported", errors: [{ code: 131051 }] })])));
  assert.equal(lida.kind, "other");
});

test("remetente sem número ou sem id não entra", () => {
  assert.equal(parseMetaMessages(webhook(valor([msg({ from: "123", type: "text", text: { body: "x" } }), msg({ id: "", type: "text", text: { body: "x" } })]))).length, 0);
  assert.equal(parseMetaMessages({ object: "page", entry: [] }).length, 0);
});

/* -------------------------------------------------------- recibos --- */

test("recibos de entrega são lidos com horário e motivo da falha", () => {
  const recibos = parseMetaStatuses(webhook({
    messaging_product: "whatsapp", metadata: {},
    statuses: [
      { id: "wamid.A", status: "delivered", timestamp: "1749416383", recipient_id: "557999151289" },
      { id: "wamid.B", status: "failed", timestamp: "1749416390", errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "Message failed to send because more than 24 hours" } }] },
      { id: "wamid.C", status: "deleted" },
    ],
  }));
  assert.equal(recibos.length, 2, "status desconhecido é ignorado");
  assert.equal(recibos[0].status, "delivered");
  assert.equal(recibos[0].at, new Date(1749416383 * 1000).toISOString());
  assert.equal(recibos[1].errorCode, 131047);
  assert.match(deliveryError(recibos[1]), /24 horas/, "a falha é dita na mesma frase da recusa no envio");
  assert.equal(deliveryError(recibos[0]), null);
});

test("recibo avança, nunca recua, e só vale para mensagem nossa", async () => {
  const repo = new MemoryDeliveryRepository();
  repo.messages.set("wamid.NOSSA", { status: null, error: null, at: null });
  const recibo = (status) => ({ messageId: "wamid.NOSSA", status });
  assert.equal(await applyStatuses(repo, [recibo("sent"), recibo("read"), recibo("delivered")]), 2, "o 'entregue' atrasado não rebaixa o 'lida'");
  assert.equal(repo.messages.get("wamid.NOSSA").status, "read");
  assert.equal(await applyStatuses(repo, [{ messageId: "wamid.DO-CLIENTE", status: "read" }]), 0);
});

test("dicionário de erro da Meta é o mesmo para recusa e recibo", () => {
  assert.equal(describeMetaError(131047).kind, "window_closed");
  assert.equal(describeMetaError(190).kind, "invalid_token");
  assert.match(describeMetaError(999, "algo novo").reason, /código 999.*algo novo/);
});

/* --------------------------------------------------- mídia no canal --- */

test("mídia fica registrada para o atendente, sem resposta da IA e sem desfecho", async () => {
  const canal = new MemoryChannelRepository();
  const entrada = { externalConversationId: "557999151289", idempotencyKey: "wamid.AUDIO", correlationId: "c1", kind: "audio" };
  const resultado = await recordUnsupportedMessage(canal, entrada);
  assert.equal(resultado.status, "unsupported");
  assert.equal(resultado.response, null);
  const gravadas = await canal.getHistory("n8n-whatsapp", "557999151289");
  assert.equal(gravadas.length, 1, "só a fala do cliente: nenhuma sugestão da IA");
  assert.equal(gravadas[0].role, "customer");
  assert.match(gravadas[0].content, /Áudio recebido/);
  assert.equal(gravadas[0].externalMessageId, "wamid.AUDIO", "dá para marcar como lida ao responder");
  assert.equal(canal.audits[0].result, "unsupported");

  await recordUnsupportedMessage(canal, entrada);
  assert.equal((await canal.getHistory("n8n-whatsapp", "557999151289")).length, 1, "reentrega da Meta não duplica");
});

test("a legenda aparece para o atendente, fora do aviso", () => {
  assert.match(unsupportedMessageText("image", "meu boleto"), /^\[Imagem recebida — .*\] Legenda: meu boleto$/);
  assert.doesNotMatch(unsupportedMessageText("audio"), /Legenda/);
});

/* --------------------------------------------------------- contatos --- */

test("nome do perfil é limpo de caractere invisível e de inversão de texto", () => {
  assert.equal(cleanDisplayName("  Ana   Paula  "), "Ana Paula");
  assert.equal(cleanDisplayName("Ana‮etorp"), "Anaetorp", "marca de direção removida");
  assert.equal(cleanDisplayName("A​na"), "Ana");
  assert.equal(cleanDisplayName("   "), undefined);
  assert.equal(cleanDisplayName(42), undefined);
  assert.equal(Array.from(cleanDisplayName("😀".repeat(100))).length, 80, "corte por caractere, sem quebrar emoji");
});

test("guardar o nome nunca derruba o atendimento", async () => {
  const repo = new MemoryContactsRepository();
  await rememberContactName(repo, "n8n-whatsapp", "557999151289", "Vinicius");
  assert.equal(repo.names.get("n8n-whatsapp:557999151289"), "Vinicius");
  await rememberContactName({ upsertName: async () => { throw new Error("banco fora"); } }, "n8n-whatsapp", "1", "X");
  await rememberContactName(repo, "n8n-whatsapp", "557999151289", "  ");
  assert.equal(repo.names.get("n8n-whatsapp:557999151289"), "Vinicius", "nome vazio não apaga o anterior");
});

/* ----------------------------------------------------------- fila --- */

const linha = (role, minutos) => ({ role, createdAt: new Date(Date.UTC(2026, 9, 5, 10, minutos)).toISOString() });

test("aguardando desde a primeira fala sem resposta", () => {
  // Da mais nova para a mais antiga.
  assert.equal(awaitingSinceFrom([linha("customer", 9), linha("customer", 5), linha("agent", 3)]), linha("customer", 5).createdAt);
  assert.equal(awaitingSinceFrom([linha("agent", 9), linha("customer", 5)]), undefined, "respondido não espera");
  assert.equal(awaitingSinceFrom([linha("suggestion", 9), linha("customer", 8), linha("agent", 1)]), linha("customer", 8).createdAt, "sugestão não respondeu ninguém");
  assert.equal(awaitingSinceFrom([]), undefined);
});

test("janela de 24 horas conta da última fala do cliente", () => {
  const dia = 24 * 60 * 60 * 1000;
  const mensagens = [{ role: "customer", createdAt: "2026-10-05T10:00:00.000Z" }, { role: "agent", createdAt: "2026-10-05T11:00:00.000Z" }];
  const aberta = replyWindowFrom(mensagens, dia, Date.parse("2026-10-06T09:00:00.000Z"));
  assert.equal(aberta.open, true);
  assert.equal(aberta.closesAt, "2026-10-06T10:00:00.000Z", "resposta do atendente não renova a janela");
  assert.equal(replyWindowFrom(mensagens, dia, Date.parse("2026-10-06T10:00:01.000Z")).open, false);
  assert.deepEqual(replyWindowFrom([{ role: "agent", createdAt: "2026-10-05T10:00:00.000Z" }], dia), { lastCustomerAt: null, closesAt: null, open: false });
});

test("busca por número usa só dígitos; por nome, a partir de 2 letras", () => {
  assert.deepEqual(searchTerm("(79) 9915-1289"), { kind: "digits", value: "7999151289" });
  assert.equal(searchTerm("79"), undefined, "dois dígitos casariam com quase tudo");
  assert.deepEqual(searchTerm(" Ana "), { kind: "name", value: "Ana" });
  assert.equal(searchTerm("a"), undefined);
  assert.equal(searchTerm(""), undefined);
});

test("a lista traz nome, espera e autor da última resposta, e filtra pela busca", async () => {
  const repo = new MemoryConversationsRepository();
  repo.add({ channel: "n8n-whatsapp", externalConversationId: "557999151289", role: "customer", content: "oi", createdAt: "2026-10-05T10:00:00.000Z" });
  repo.add({ channel: "n8n-whatsapp", externalConversationId: "557999151289", role: "agent", content: "olá", createdAt: "2026-10-05T10:01:00.000Z", sentBy: "ana@bbnet.com.br" });
  repo.add({ channel: "n8n-whatsapp", externalConversationId: "5579988887777", role: "customer", content: "sem internet", createdAt: "2026-10-05T10:02:00.000Z" });
  repo.contacts.set("n8n-whatsapp:5579988887777", "Bruno Lima");

  const [maisRecente, respondida] = await repo.listConversations(10);
  assert.equal(maisRecente.displayName, "Bruno Lima");
  assert.equal(maisRecente.awaitingSince, "2026-10-05T10:02:00.000Z");
  assert.equal(respondida.awaitingSince, undefined);
  assert.equal(respondida.lastSentBy, "ana@bbnet.com.br");

  assert.deepEqual((await repo.listConversations(10, "bruno")).map((c) => c.externalConversationId), ["5579988887777"]);
  assert.deepEqual((await repo.listConversations(10, "9915-1289")).map((c) => c.externalConversationId), ["557999151289"]);
});
