import test from "node:test";
import assert from "node:assert/strict";
import { AUDIO_REPLY, FILE_REPLY, STICKER_GREETING, mediaReply } from "../lib/platform/media-reply-shared.ts";

const NOW = Date.parse("2026-11-24T20:30:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

test("conversa nova aberta com figurinha ganha o cumprimento (24/11: a IA ficou calada)", () => {
  assert.equal(mediaReply("sticker", [], NOW), STICKER_GREETING);
  assert.equal(mediaReply("sticker", [{ role: "agent", content: "Resolvido!", createdAt: ago(60 * 24) }], NOW), STICKER_GREETING, "conversa de ontem não conta");
});

test("figurinha no meio da conversa é reação, não pedido", () => {
  assert.equal(mediaReply("sticker", [{ role: "agent", content: "Pode reiniciar a caixinha?", createdAt: ago(3) }], NOW), undefined);
});

test("foto, vídeo e documento pedem para escrever (e lembram do comprovante); áudio também", () => {
  for (const kind of ["image", "video", "document"]) assert.equal(mediaReply(kind, [], NOW), FILE_REPLY);
  assert.equal(mediaReply("audio", [], NOW), AUDIO_REPLY);
  assert.match(FILE_REPLY, /comprovante/);
});

test("rajada de fotos ganha uma resposta só", () => {
  const history = [{ role: "customer", content: "[Imagem]", createdAt: ago(1) }, { role: "agent", content: FILE_REPLY, createdAt: ago(1) }];
  assert.equal(mediaReply("image", history, NOW), undefined);
  assert.equal(mediaReply("image", [{ role: "agent", content: FILE_REPLY, createdAt: ago(45) }], NOW), FILE_REPLY, "depois de meia hora, responde de novo");
  assert.equal(mediaReply("image", [{ role: "agent", content: FILE_REPLY }], NOW), undefined, "sem data: na dúvida, não repete");
});

test("reação, localização e contato não ganham resposta", () => {
  for (const kind of ["reaction", "location", "contact", "other"]) assert.equal(mediaReply(kind, [], NOW), undefined);
});
