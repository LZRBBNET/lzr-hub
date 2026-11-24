import test from "node:test";
import assert from "node:assert/strict";
import { parseMetaMessages } from "../lib/integrations/meta/webhook-parser.ts";
import { downloadMetaMedia, MEDIA_MAX_BYTES } from "../lib/integrations/meta/media.ts";
import { transcribeAudio, transcriptionConfigFromEnv } from "../lib/integrations/openai/transcription.ts";
import { CHANNEL_NAME, MemoryChannelRepository, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";

const webhook = (message) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1" }, contacts: [{ wa_id: "5579991234567", profile: { name: "A" } }], messages: [{ from: "5579991234567", id: "wamid.X", timestamp: "1763480000", ...message }] } }] }] });

test("o webhook de áudio traz o id da mídia para baixar", () => {
  const [audio] = parseMetaMessages(webhook({ type: "audio", audio: { id: "123456789", mime_type: "audio/ogg; codecs=opus", voice: true } }));
  assert.equal(audio.kind, "audio");
  assert.equal(audio.mediaId, "123456789");
  const [text] = parseMetaMessages(webhook({ type: "text", text: { body: "oi" } }));
  assert.equal(text.mediaId, undefined);
});

const config = (fetcher) => ({ accessToken: "TOKEN", phoneNumberId: "9", graphVersion: "v26.0", fetcher });

test("baixa o áudio em dois passos, com o token, e só de domínio da Meta", async () => {
  const chamadas = [];
  const fetcher = async (url, init) => {
    chamadas.push({ url, auth: init.headers.Authorization });
    if (url.includes("graph.facebook.com")) return { ok: true, status: 200, json: async () => ({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "audio/ogg", file_size: 100 }) };
    return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const result = await downloadMetaMedia(config(fetcher), "123456789");
  assert.equal(result.ok, true);
  assert.equal(result.mimeType, "audio/ogg");
  assert.equal(chamadas.length, 2);
  assert.ok(chamadas.every((c) => c.auth === "Bearer TOKEN"));
});

test("não manda o token para endereço fora da Meta nem baixa arquivo grande", async () => {
  const fora = async () => ({ ok: true, status: 200, json: async () => ({ url: "https://evil.example.com/a.ogg", file_size: 10 }) });
  const r1 = await downloadMetaMedia(config(fora), "123456789");
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /fora dos domínios/);
  const grande = async () => ({ ok: true, status: 200, json: async () => ({ url: "https://lookaside.fbsbx.com/x", file_size: MEDIA_MAX_BYTES + 1 }) });
  assert.equal((await downloadMetaMedia(config(grande), "123456789")).ok, false);
  assert.equal((await downloadMetaMedia(config(grande), "../etc")).ok, false, "id que não é número é recusado");
});

test("transcrição: nasce desligada e precisa de flag e chave", () => {
  assert.equal(transcriptionConfigFromEnv({ OPENAI_API_KEY: "k" }), undefined);
  assert.equal(transcriptionConfigFromEnv({ FEATURE_AUDIO_TRANSCRIPTION: "true" }), undefined);
  const on = transcriptionConfigFromEnv({ FEATURE_AUDIO_TRANSCRIPTION: "true", OPENAI_API_KEY: "k" });
  assert.equal(on.model, "gpt-4o-mini-transcribe");
});

test("transcrição devolve o texto; silêncio e erro não viram fala do cliente", async () => {
  const base = { apiKey: "k", model: "m", baseUrl: "https://api.exemplo.com/v1" };
  let enviado;
  const ok = await transcribeAudio({ ...base, fetcher: async (url, init) => { enviado = { url, auth: init.headers.Authorization, language: init.body.get("language"), model: init.body.get("model") }; return { ok: true, status: 200, json: async () => ({ text: " minha internet caiu " }) }; } }, { bytes: new Uint8Array([1]), mimeType: "audio/ogg" });
  assert.deepEqual(ok, { ok: true, text: "minha internet caiu" });
  assert.equal(enviado.url, "https://api.exemplo.com/v1/audio/transcriptions");
  assert.equal(enviado.language, "pt");
  assert.equal((await transcribeAudio({ ...base, fetcher: async () => ({ ok: true, status: 200, json: async () => ({ text: "" }) }) }, { bytes: new Uint8Array([1]), mimeType: "audio/ogg" })).ok, false);
  const falha = await transcribeAudio({ ...base, fetcher: async () => ({ ok: false, status: 500, json: async () => ({}) }) }, { bytes: new Uint8Array([1]), mimeType: "audio/ogg" });
  assert.equal(falha.ok, false);
  assert.doesNotMatch(falha.reason, /\bk\b/, "a chave não aparece no motivo");
});

test("o atendente lê a fala marcada como áudio transcrito, e a IA lê só o texto", async () => {
  const channel = new MemoryChannelRepository();
  await processChannelMessage(channel, { externalConversationId: "5579991234567", text: "minha internet caiu", storedText: "[Áudio transcrito] minha internet caiu", idempotencyKey: "wamid.T1", correlationId: "c1" }, new MemorySupportMetricsRepository(), { autoReply: false });
  const rows = await channel.getHistory(CHANNEL_NAME, "5579991234567");
  assert.equal(rows.find((row) => row.role === "customer").content, "[Áudio transcrito] minha internet caiu");
});
