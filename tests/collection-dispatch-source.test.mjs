import test from "node:test";
import assert from "node:assert/strict";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { loadFreshDispatchInvoices } from "../lib/platform/collection-dispatch-source.ts";
import { MemoryCollectionDispatchRepository, runTodayDispatch } from "../lib/platform/collection-dispatch-service.ts";

const invoice = (extra = {}) => ({ id: "901", id_cliente: "10", status: "A", data_vencimento: "2026-11-05", ...extra });
function providerFor(body, options = {}) {
  const calls = [];
  const provider = new IxcReadonlyProvider({ baseUrl: "https://ixc.invalid", token: "synthetic", allowedCustomerIds: ["10", "20"], retryLimit: 0,
    fetcher: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), command: new Headers(init.headers).get("ixcsoft") }); return Response.json(body); }, ...options });
  return { provider, calls };
}

test("fonte de disparo lê só faturas abertas, com página limitada e cliente vinculado", async () => {
  const { provider, calls } = providerFor({ registros: [invoice()], total: 1 });
  assert.equal((await loadFreshDispatchInvoices(provider, ["10"])).length, 1);
  assert.deepEqual(calls, [{ url: "https://ixc.invalid/webservice/v1/fn_areceber", command: "listar", body: {
    qtype: "fn_areceber.id_cliente", query: "10", oper: "=", page: "1", rp: "20", sortname: "fn_areceber.id", sortorder: "asc",
    grid_param: JSON.stringify([{ TB: "fn_areceber.status", OP: "=", P: "A" }]),
  } }]);
});

test("duas rodadas com dois clientes e dez faturas gastam quatro leituras, não sessenta", async () => {
  let calls = 0;
  const { provider } = providerFor(null, { fetcher: async (url, init) => {
    calls++;
    assert.ok(url.endsWith("/fn_areceber"));
    const body = JSON.parse(init.body);
    const rows = Array.from({ length: 10 }, (_, index) => invoice({ id: String(Number(body.query) * 100 + index), id_cliente: body.query }));
    return Response.json({ registros: rows, total: 10 });
  } });
  assert.equal((await loadFreshDispatchInvoices(provider, ["10", "20"])).length, 20);
  assert.equal((await loadFreshDispatchInvoices(provider, ["10", "20"])).length, 20);
  assert.equal(calls, 4);
  assert.equal(provider.rateLimitRemaining(), 26);
});

for (const [label, body] of [
  ["acima do limite", { registros: [invoice()], total: 21 }],
  ["total ausente", { registros: [invoice()] }],
  ["duplicata", { registros: [invoice(), invoice()], total: 2 }],
  ["outra página", { registros: [invoice()], total: 1, page: 2 }],
  ["outro cliente", { registros: [invoice({ id_cliente: "20" })], total: 1 }],
  ["identidade inválida", { registros: [invoice({ id: "invalid" })], total: 1 }],
  ["identidade numérica imprecisa", { registros: [invoice({ id: 9007199254740993 })], total: 1 }],
  ["status recebido contradiz filtro", { registros: [invoice({ status: "R" })], total: 1 }],
  ["status desconhecido", { registros: [invoice({ status: "desconhecido" })], total: 1 }],
]) test(`fonte inconclusiva ${label} rejeita o lote, nunca simula carteira vazia`, async () => {
  const { provider, calls } = providerFor(body);
  await assert.rejects(loadFreshDispatchInvoices(provider, ["10"]));
  assert.equal(calls.length, 1);
});

test("zero faturas só é aceito quando a fonte confirma lista vazia completa", async () => {
  const { provider } = providerFor({ registros: [], total: 0 });
  assert.deepEqual(await loadFreshDispatchInvoices(provider, ["10"]), []);
});

test("falha de um cliente aborta a rodada inteira antes de gravar o ledger", async () => {
  const { provider } = providerFor(null, { fetcher: async (_url, init) => {
    const body = JSON.parse(init.body);
    return body.query === "20" ? new Response("synthetic failure", { status: 503 }) : Response.json({ registros: [invoice()], total: 1 });
  } });
  const repository = new MemoryCollectionDispatchRepository();
  const rule = { id: "synthetic-rule", name: "Régua fictícia", status: "draft", version: 1, authorId: "synthetic", updatedAt: "", steps: [{ id: "synthetic-step", offsetDays: 0, channel: "WhatsApp", templateId: "synthetic-template", attempts: 1, active: true }] };
  await assert.rejects(async () => runTodayDispatch(rule, await loadFreshDispatchInvoices(provider, ["10", "20"]), repository, new Date("2026-11-05T15:00:00Z"), "synthetic"));
  assert.equal(repository.rows.length, 0);
});

test("allowlist vazia e cliente não autorizado não produzem rodada vazia bem-sucedida", async () => {
  const { provider, calls } = providerFor({ registros: [], total: 0 });
  await assert.rejects(loadFreshDispatchInvoices(provider, []), /COLLECTION_SCOPE_UNAVAILABLE/);
  await assert.rejects(loadFreshDispatchInvoices(provider, ["30"]));
  assert.equal(calls.length, 0);
});
