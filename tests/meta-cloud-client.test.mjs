import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GRAPH_VERSION, markAsRead, metaSendConfigFromEnv, sendTextMessage } from "../lib/integrations/meta/cloud-client.ts";

const ok = (body) => ({ status: 200, json: async () => body });
const erro = (status, error) => ({ status, json: async () => ({ error }) });
const config = (fetcher, extra = {}) => ({ accessToken: "TOKEN-SECRETO", phoneNumberId: "1377624278760819", graphVersion: "v26.0", fetcher, ...extra });

test("configuração exige token E id do número; versão tem padrão", () => {
  assert.equal(metaSendConfigFromEnv({}), undefined);
  assert.equal(metaSendConfigFromEnv({ META_ACCESS_TOKEN: "t" }), undefined, "sem id do número não há para onde enviar");
  assert.equal(metaSendConfigFromEnv({ META_PHONE_NUMBER_ID: "1" }), undefined, "sem token não há autorização");
  const completa = metaSendConfigFromEnv({ META_ACCESS_TOKEN: " t ", META_PHONE_NUMBER_ID: " 1 " });
  assert.equal(completa.accessToken, "t");
  assert.equal(completa.phoneNumberId, "1");
  assert.equal(completa.graphVersion, DEFAULT_GRAPH_VERSION);
  assert.equal(metaSendConfigFromEnv({ META_ACCESS_TOKEN: "t", META_PHONE_NUMBER_ID: "1", META_GRAPH_VERSION: "v99.0" }).graphVersion, "v99.0");
});

test("envia texto no formato da Cloud API e devolve o id da mensagem", async () => {
  let visto;
  const result = await sendTextMessage(config(async (url, init) => { visto = { url, init, body: JSON.parse(init.body) }; return ok({ messages: [{ id: "wamid.ABC" }] }); }), { to: "5579991234567", text: "Olá" });
  assert.deepEqual(result, { ok: true, messageId: "wamid.ABC" });
  assert.equal(visto.url, "https://graph.facebook.com/v26.0/1377624278760819/messages");
  assert.equal(visto.init.method, "POST");
  assert.equal(visto.init.headers.Authorization, "Bearer TOKEN-SECRETO");
  assert.deepEqual(visto.body, { messaging_product: "whatsapp", recipient_type: "individual", to: "5579991234567", type: "text", text: { preview_url: false, body: "Olá" } });
});

test("traduz o erro da janela de 24 horas, de número fora da lista e de token", async () => {
  const falha = async (error, status = 400) => sendTextMessage(config(async () => erro(status, error)), { to: "5579991234567", text: "x" });
  const janela = await falha({ code: 131047, message: "Re-engagement message" });
  assert.equal(janela.ok, false);
  assert.equal(janela.kind, "window_closed");
  assert.match(janela.reason, /24 horas/);
  assert.equal((await falha({ code: 131030, message: "not in allowed list" })).kind, "not_allowed");
  assert.equal((await falha({ code: 131026, message: "undeliverable" })).kind, "invalid_recipient");
  assert.equal((await falha({ code: 190, message: "expired" }, 401)).kind, "invalid_token");
  assert.equal((await falha({ code: 130429, message: "rate" }, 429)).kind, "rate_limited");
});

test("erro desconhecido repete a mensagem da Meta em vez de inventar causa", async () => {
  const result = await sendTextMessage(config(async () => erro(400, { code: 100, message: "Parâmetro inválido: to" })), { to: "x", text: "x" });
  assert.equal(result.kind, "rejected");
  assert.match(result.reason, /código 100/);
  assert.match(result.reason, /Parâmetro inválido/);
});

test("o token nunca aparece no resultado nem na mensagem de erro", async () => {
  const resultados = [
    await sendTextMessage(config(async () => erro(401, { code: 190, message: "Invalid OAuth access token" })), { to: "1", text: "x" }),
    await sendTextMessage(config(async () => { throw new Error("falha de rede com Bearer TOKEN-SECRETO"); }), { to: "1", text: "x" }),
  ];
  for (const resultado of resultados) assert.doesNotMatch(JSON.stringify(resultado), /TOKEN-SECRETO/);
});

test("2xx sem id de mensagem não é tratado como envio", async () => {
  const result = await sendTextMessage(config(async () => ok({ messages: [] })), { to: "5579991234567", text: "x" });
  assert.equal(result.ok, false);
});

test("falha de rede e demora viram resultado, não exceção", async () => {
  const rede = await sendTextMessage(config(async () => { throw new Error("ECONNRESET"); }), { to: "1", text: "x" });
  assert.equal(rede.kind, "unreachable");

  const lento = await sendTextMessage(
    config((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })))), { timeoutMs: 20 }),
    { to: "1", text: "x" },
  );
  assert.equal(lento.kind, "timeout");
  assert.match(lento.reason, /não sei se a mensagem saiu/i, "em timeout a mensagem pode ter saído, e o texto diz isso");
});

test("marcar como lida usa o mesmo endpoint e só é sucesso com 2xx", async () => {
  let corpo;
  assert.equal(await markAsRead(config(async (_u, init) => { corpo = JSON.parse(init.body); return ok({ success: true }); }), "wamid.IN"), true);
  assert.deepEqual(corpo, { messaging_product: "whatsapp", status: "read", message_id: "wamid.IN" });
  assert.equal(await markAsRead(config(async () => erro(400, { code: 100, message: "x" })), "wamid.IN"), false);
  assert.equal(await markAsRead(config(async () => { throw new Error("x"); }), "wamid.IN"), false);
});
