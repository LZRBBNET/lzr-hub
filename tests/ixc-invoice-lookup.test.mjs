import test from "node:test";
import assert from "node:assert/strict";
import { IxcReadonlyProvider, IxcReadonlyError } from "../lib/integrations/ixc/readonly-provider.ts";
import { IxcCustomerNotAllowedError } from "../lib/integrations/ixc/guard.ts";
import { MemoryPaymentPromiseRepository, reconcilePaymentPromises } from "../lib/platform/payment-promise-service.ts";

const record = (over = {}) => ({ id: "901", id_cliente: "10", status: "R", ...over });
function fixture(body = { registros: [record()], total: "1" }, options = {}) {
  const calls = [];
  const provider = new IxcReadonlyProvider({ baseUrl: "https://ixc.invalid", token: "synthetic", allowedCustomerIds: ["10"], retryLimit: 0,
    fetcher: async (url, init) => { calls.push({ url, method: init.method, command: new Headers(init.headers).get("ixcsoft"), body: JSON.parse(init.body) }); return Response.json(body); }, ...options });
  return { provider, calls };
}

test("leitura exata usa apenas listar, fatura e cliente juntos, página limitada e retorno mínimo", async () => {
  const { provider, calls } = fixture({ registros: [record({ linha_digitavel: "NÃO-RETORNAR", valor: "100", senha: "NÃO-RETORNAR" })], total: "1" });
  assert.deepEqual(await provider.getInvoiceForCustomer("10", "901", "corr-exact"), { id: "901", customerId: "10", status: "R" });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://ixc.invalid/webservice/v1/fn_areceber");
  assert.equal(calls[0].method, "POST"); assert.equal(calls[0].command, "listar", "POST de transporte não é comando de escrita no IXC");
  assert.deepEqual(calls[0].body, { qtype: "fn_areceber.id", query: "901", oper: "=", page: "1", rp: "2", sortname: "fn_areceber.id", sortorder: "asc", grid_param: JSON.stringify([{ TB: "fn_areceber.id_cliente", OP: "=", P: "10" }]) });
});

test("consulta pontual revalida a allowlist antes de acessar rede", async () => {
  const { provider, calls } = fixture();
  await assert.rejects(provider.getInvoiceForCustomer("20", "901", "corr-denied"), IxcCustomerNotAllowedError);
  assert.equal(calls.length, 0);
});

test("IDs inválidos não alcançam rede, mesmo com base inteira liberada", async () => {
  const { provider, calls } = fixture(undefined, { fullBase: true });
  for (const id of ["", "0", "-1", "1.5", "1e2", "1 OR 1=1", "01", " 10", "9".repeat(33)]) {
    await assert.rejects(provider.getInvoiceForCustomer(id, "901", "corr-bad"), IxcReadonlyError);
    await assert.rejects(provider.getInvoiceForCustomer("10", id, "corr-bad"), IxcReadonlyError);
  }
  assert.equal(calls.length, 0);
});

test("cada chamada pontual é fresca, sem cache do snapshot", async () => {
  let calls = 0;
  const { provider } = fixture(undefined, { fetcher: async () => Response.json({ registros: [record({ status: ++calls === 1 ? "A" : "R" })], total: 1 }) });
  assert.equal((await provider.getInvoiceForCustomer("10", "901", "corr-1")).status, "A");
  assert.equal((await provider.getInvoiceForCustomer("10", "901", "corr-2")).status, "R");
  assert.equal(calls, 2);
});

test("fatura ausente é indefinida, nunca recebida", async () => {
  const { provider } = fixture({ registros: [], total: "0" });
  assert.equal(await provider.getInvoiceForCustomer("10", "901", "corr-absent"), undefined);
});

for (const [label, body] of [
  ["outro cadastro", { registros: [record({ id_cliente: "20" })], total: 1 }],
  ["outra fatura", { registros: [record({ id: "902" })], total: 1 }],
  ["identidade ausente", { registros: [record({ id_cliente: null })], total: 1 }],
  ["identidade numérica imprecisa", { registros: [record({ id: 9007199254740993 })], total: 1 }],
  ["duplicata", { registros: [record(), record()], total: 2 }],
  ["página truncada", { registros: [record()], total: 2 }],
  ["total contraditório", { registros: [record()], total: 0 }],
  ["total ausente", { registros: [record()] }],
  ["total inválido", { registros: [record()], total: "x" }],
  ["total booleano", { registros: [record()], total: true }],
  ["total fracionário", { registros: [record()], total: 1.5 }],
  ["registro inválido descartável", { registros: [record(), null], total: 1 }],
  ["registro array", { registros: [[]], total: 1 }],
  ["formato inválido", { registros: {}, total: 0 }],
]) test(`resposta sem comprovação completa é rejeitada: ${label}`, async () => {
  const { provider, calls } = fixture(body);
  await assert.rejects(provider.getInvoiceForCustomer("10", "901", "corr-incomplete"), IxcReadonlyError);
  assert.equal(calls.length, 1);
});

test("status desconhecido ou malformado não é convertido em pagamento", async () => {
  for (const status of ["X", "C", "P", undefined, null, false]) {
    const { provider } = fixture({ registros: [record({ status })], total: 1 });
    const value = await provider.getInvoiceForCustomer("10", "901", "corr-status");
    assert.equal(value.status, typeof status === "string" ? status : "");
  }
});

test("falha HTTP mantém retry limitado e erro da API não vaza conteúdo", async () => {
  let calls = 0;
  const { provider } = fixture(undefined, { retryLimit: 1, fetcher: async () => { calls++; return new Response("falha", { status: 503 }); } });
  await assert.rejects(provider.getInvoiceForCustomer("10", "901", "corr-http"), /IXC_HTTP_503/);
  assert.equal(calls, 2);
  const api = fixture({ type: "error", message: "token segredo-que-não-pode-vazar" });
  await assert.rejects(api.provider.getInvoiceForCustomer("10", "901", "corr-api"), (error) => error.code === "IXC_AUTHENTICATION_FAILED" && !error.message.includes("segredo"));
});

test("fatura fora das primeiras 20 é reconciliada pelo adaptador real com transporte falso", async () => {
  const { provider, calls } = fixture();
  provider.getSnapshot = () => assert.fail("não depende da página antiga de 20 faturas");
  const repository = new MemoryPaymentPromiseRepository();
  const created = await repository.create({ invoiceId: "901", customerId: "10", promisedFor: "2026-10-01", registeredBy: "synthetic", correlationId: "test" });
  const result = await reconcilePaymentPromises(repository, provider, "corr-integration", new Date("2026-10-27T12:00:00Z"));
  assert.deepEqual(result.fulfilled, [created.id]); assert.equal(result.lookupCount, 1); assert.equal(calls.length, 1);
  assert.equal(repository.rows[0].status, "fulfilled");
});
