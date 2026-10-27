import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import {
  createRecoveryGetHandler, DbRecoveryPromiseRepository, loadRecovery, loadRecoveryCustomer,
  parseRecoveryPage, RECOVERY_MAX_PAGES, RECOVERY_IXC_PAGE_SIZE, RECOVERY_PROMISES_PER_CUSTOMER,
} from "../lib/platform/recovery-service.ts";

const NOW = new Date("2026-10-27T12:00:00Z");
const raw = (over = {}) => ({ id: "1", id_cliente: "10", status: "A", data_vencimento: "2026-10-01", valor_aberto: "40.50", valor: "100.00", ...over });
const emptyHistory = () => ({ available: true, rows: [], truncated: false });
const repository = { async listForCustomers(ids) { return new Map(ids.map((id) => [id, emptyHistory()])); } };
const provider = (rows = [], over = {}) => ({
  async listOverdueInvoices() { return { rows, total: rows.length, truncated: false }; },
  async getCustomerRecord(customerId) { return { id: customerId, razao: "Cliente de teste", cnpj_cpf: "não retornar", telefone_celular: "não retornar" }; },
  async getServiceDiagnosis() { return { logins: [], contracts: [], openServiceOrders: [] }; },
  ...over,
});
const load = (source, getPromises = async () => repository, options = {}) => loadRecovery(source, getPromises, { page: 1, pageSize: 20, correlationId: "corr-recovery", now: NOW, ...options });

test("recuperação agrupa por cliente, soma saldo aberto e usa dias de atraso, nunca dias bloqueado", async () => {
  const data = await load(provider([raw(), raw({ id: "2", data_vencimento: "2026-10-20", valor_aberto: "9,50" }), raw({ id: "3", id_cliente: "20", data_vencimento: "2026-09-01", valor_aberto: "30" })]));
  assert.equal(data.summary.knownOverdueValue, 80);
  assert.equal(data.totalCustomers, 2);
  assert.deepEqual(data.rows.map((row) => row.customerId), ["20", "10"], "ordem por atraso, não por score inventado");
  const row = data.rows[1];
  assert.equal(row.knownOverdueValue, 50);
  assert.equal(row.overdueInvoices, 2);
  assert.equal(row.oldestDueAt, "2026-10-01");
  assert.equal(row.daysOverdue, 26);
  for (const field of ["customerName", "blockedSince", "daysBlocked", "aiContactStatus", "predictiveRisk"]) assert.equal(row[field], null, field);
});

test("fallback nominal é declarado e saldo aberto inválido não vira valor original ou zero", async () => {
  const data = await load(provider([
    raw({ id: "1", valor_aberto: "", valor: "89.900000000" }),
    raw({ id: "2", valor_aberto: "inválido", valor: "100" }),
    raw({ id: "3", valor_aberto: null, valor: null }),
    raw({ id: "4", id_cliente: "20", valor_aberto: "-1", valor: "100" }),
  ]));
  const row = data.rows.find((item) => item.customerId === "10");
  assert.equal(row.knownOverdueValue, 89.9);
  assert.equal(row.amountIncomplete, true);
  assert.equal(row.faceValueFallbackInvoices, 1);
  assert.equal(data.summary.faceValueFallbackInvoices, 1);
  assert.equal(data.rows.find((item) => item.customerId === "20").knownOverdueValue, null);
  assert.equal(data.sources.ixc, "partial");
});

test("datas impossíveis, código desconhecido, fatura futura e duplicata não entram como dívida", async () => {
  const rows = [raw(), raw(), raw({ id: "2", status: "C" }), raw({ id: "3", status: "X" }), raw({ id: "4", data_vencimento: "2026-02-30" }), raw({ id: "5", data_vencimento: "2026-10-27" }), raw({ id: "6", id_cliente: "" }), raw({ id: "7", data_vencimento: "27/10/2026" })];
  const data = await load(provider(rows));
  assert.equal(data.summary.overdueInvoices, 1);
  assert.equal(data.summary.knownOverdueValue, 40.5);
  assert.equal(data.coverage.excludedInvoices, 7);
  assert.equal(data.sources.ixc, "partial");
});

test("data de referência respeita Brasília antes da meia-noite local", async () => {
  const data = await load(provider([raw({ data_vencimento: "2026-10-26" })]), undefined, { now: new Date("2026-10-27T01:00:00Z") });
  assert.equal(data.referenceDate, "2026-10-26");
  assert.equal(data.rows.length, 0, "a fatura de hoje ainda não está vencida");
});

test("varredura é limitada a duas páginas de 500 e truncamento aparece em cada valor", async () => {
  const calls = [];
  const source = provider([raw()], { async listOverdueInvoices(...args) { calls.push(args); return { rows: [raw()], total: 3000, truncated: true }; } });
  const data = await load(source);
  assert.deepEqual(calls, [["2026-10-27", "corr-recovery", RECOVERY_MAX_PAGES, RECOVERY_IXC_PAGE_SIZE]]);
  assert.equal(data.coverage.totalOverdueInvoices, 3000);
  assert.equal(data.coverage.scannedInvoices, 1);
  assert.equal(data.coverage.truncated, true);
  assert.equal(data.rows[0].amountIncomplete, true);
  assert.equal(data.summary.amountIncomplete, true);
  assert.equal(data.totalCustomers, 1, "é a contagem dos grupos lidos, não da carteira inteira");
});

test("paginação consulta promessas só dos clientes exibidos e não lê cadastro por linha", async () => {
  const idsRead = [];
  const rows = Array.from({ length: 45 }, (_, i) => raw({ id: String(i + 1), id_cliente: String(i + 100), data_vencimento: "2026-10-01" }));
  const source = provider(rows, { async getCustomerRecord() { assert.fail("lista não carrega cadastro"); }, async getServiceDiagnosis() { assert.fail("lista não carrega diagnóstico"); } });
  const data = await load(source, async () => ({ async listForCustomers(ids, limit) { idsRead.push({ ids, limit }); return new Map(ids.map((id) => [id, emptyHistory()])); } }), { page: 2, pageSize: 20 });
  assert.equal(data.rows.length, 20);
  assert.equal(data.totalCustomers, 45);
  assert.deepEqual(idsRead, [{ ids: data.rows.map((row) => row.customerId), limit: RECOVERY_PROMISES_PER_CUSTOMER }]);
});

test("histórico inclui pendentes, cumpridas e quebradas sem reavaliar nem enviar nada", async () => {
  const history = { available: true, truncated: true, rows: ["pending", "fulfilled", "broken"].map((status, i) => ({ id: String(i), invoiceId: "1", promisedFor: "2026-10-01", status, createdAt: "2026-10-01T00:00:00Z" })) };
  const data = await load(provider([raw()]), async () => ({ async listForCustomers() { return new Map([["10", history]]); } }));
  assert.deepEqual(data.rows[0].promises, history);
  assert.match(data.rows[0].humanReview.reason, /histórico.*quebrada.*Conferir a situação atual/i);
  assert.equal(data.sources.promises, "partial");
});

test("falha no banco de promessas não some com a fatura nem inventa que não há promessas", async () => {
  const data = await load(provider([raw()]), async () => { throw new Error("senha-secreta não deve vazar"); });
  assert.equal(data.available, true);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].promises.available, false);
  assert.equal(data.sources.promises, "unavailable");
  assert.doesNotMatch(JSON.stringify(data), /senha-secreta/);
});

test("falha do IXC retorna indisponível, não carteira zerada, e não consulta promessas", async () => {
  const data = await load(provider([], { async listOverdueInvoices() { throw new Error("IXC_TOKEN segredo"); } }), async () => assert.fail("não carrega banco sem dados"));
  assert.equal(data.available, false);
  assert.equal(data.summary, null);
  assert.equal(data.coverage.scannedInvoices, null);
  assert.equal(data.totalCustomers, null);
  assert.doesNotMatch(JSON.stringify(data), /IXC_TOKEN|segredo/);
});

test("página vazia não consulta o banco e valores ausentes permanecem nulos", async () => {
  const missing = await load(provider([raw({ valor_aberto: undefined, valor: undefined })]));
  assert.equal(missing.summary.knownOverdueValue, null);
  const empty = await load(provider([]), async () => assert.fail("sem página, sem consulta"));
  assert.equal(empty.summary.knownOverdueValue, 0, "zero só quando a consulta retornou de fato vazia");
  assert.equal(empty.sources.promises, "not-consulted");
  const invalid = await load(provider([raw({ data_vencimento: "inválida" })]));
  assert.equal(invalid.summary.knownOverdueValue, null, "descartar registros inválidos não prova saldo zero");
  for (const total of [NaN, 10]) {
    const incomplete = await load(provider([], { async listOverdueInvoices() { return { rows: [], total, truncated: false }; } }));
    assert.equal(incomplete.summary.knownOverdueValue, null, "página vazia com total desconhecido ou contraditório não prova saldo zero");
    assert.equal(incomplete.sources.ixc, "partial");
  }
});

test("parâmetros de página recusam negativos, frações e tamanho acima do limite", () => {
  assert.deepEqual(parseRecoveryPage(new URLSearchParams()), { page: 1, pageSize: 20 });
  assert.deepEqual(parseRecoveryPage(new URLSearchParams("page=2&pageSize=50")), { page: 2, pageSize: 50 });
  for (const query of ["page=-1", "page=0", "page=1.5", "page=1001", "pageSize=51", "pageSize=0", "page=1e2"]) assert.throws(() => parseRecoveryPage(new URLSearchParams(query)), undefined, query);
});

const dependencies = (over = {}) => ({
  async authorize(_request, permission) { assert.equal(permission, "customer.read"); return { allowed: true, user: { id: "test" } }; },
  getRuntime() { return { config: { ixcFullBase: true }, provider: provider([raw()]) }; },
  async getPromises() { return repository; }, now: () => NOW, ...over,
});
const request = (query = "") => new Request(`http://localhost/api/billing/recovery${query}`);

for (const status of [401, 403]) test(`API ${status} não lê runtime, IXC ou banco`, async () => {
  const handler = createRecoveryGetHandler(dependencies({ async authorize() { return { allowed: false, status, error: "negado" }; }, getRuntime() { assert.fail("guard deve vir antes"); }, getPromises() { assert.fail("guard deve vir antes"); } }));
  const response = await handler(request());
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
});

test("API sem sessão falha fechada mesmo se a flag de autenticação estiver desligada", async () => {
  const handler = createRecoveryGetHandler(dependencies({ async authorize() { return { allowed: true }; }, getRuntime() { assert.fail("sem sessão não lê"); } }));
  assert.equal((await handler(request())).status, 401);
});

test("API valida paginação antes de consultar fonte; allowlist não finge carteira inteira", async () => {
  const invalid = createRecoveryGetHandler(dependencies({ getRuntime() { assert.fail("consulta não deveria acontecer"); } }));
  assert.equal((await invalid(request("?pageSize=999"))).status, 400);
  const restricted = createRecoveryGetHandler(dependencies({ getRuntime() { return { config: { ixcFullBase: false }, provider: provider() }; } }));
  const data = await (await restricted(request())).json();
  assert.equal(data.available, false);
  assert.match(data.detail, /allowlist/);
});

test("API de recuperação devolve contrato paginado e nunca grava", async () => {
  const response = await createRecoveryGetHandler(dependencies())(request("?page=1&pageSize=10"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.rows[0].customerId, "10");
  assert.equal(data.pageSize, 10);
  assert.equal(data.fetchedAt, NOW.toISOString());
});

test("detalhe consulta sob demanda e só retorna nome e contrato, sem documentos ou contato", async () => {
  const calls = [];
  const source = provider([], {
    async getCustomerRecord(...args) { calls.push(["customer", ...args]); return { id: "10", razao: "Cliente de teste", cnpj_cpf: "DOC-SECRETO", telefone: "FONE-SECRETO", endereco: "RUA-SECRETA" }; },
    async getServiceDiagnosis(...args) { calls.push(["diagnosis", ...args]); return { logins: [{ login: "LOGIN-SECRETO" }], contracts: [{ id: "12", status: "A", internetStatus: "CA", trustUnlockActive: false, trustUnlockKnown: true }], openServiceOrders: [] }; },
  });
  const data = await loadRecoveryCustomer(source, "10", "corr-detail", NOW);
  assert.deepEqual(calls, [["customer", "10", "corr-detail"], ["diagnosis", "10", "corr-detail"]]);
  assert.equal(data.customerName, "Cliente de teste");
  assert.equal(data.blockStatus, "blocked-observed");
  assert.equal(data.contracts[0].label, "bloqueado automaticamente");
  assert.equal(data.contracts[0].contractStatus, "A");
  assert.equal(data.contracts[0].trustUnlockActive, false);
  assert.equal(data.daysBlocked, null);
  assert.doesNotMatch(JSON.stringify(data), /SECRETO|SECRETA/);
});

test("detalhe com adaptador IXC real usa quatro leituras limitadas, sem comando de escrita", async () => {
  const calls = [];
  const source = new IxcReadonlyProvider({ baseUrl: "https://ixc.invalid", token: "synthetic", allowedCustomerIds: ["10"], fullBase: true, retryLimit: 0,
    fetcher: async (url, init) => {
      const resource = String(url).split("/").at(-1), body = JSON.parse(init.body);
      calls.push({ resource, body, command: new Headers(init.headers).get("ixcsoft") });
      const rows = resource === "cliente" ? [{ id: "10", razao: "Cliente teste" }] : resource === "cliente_contrato" ? [{ id: "100", id_cliente: "10", status: "A", status_internet: "FA", desbloqueio_confianca_ativo: "N" }] : [];
      return Response.json({ registros: rows, total: rows.length });
    },
  });
  const data = await loadRecoveryCustomer(source, "10", "corr-adapter", NOW);
  assert.equal(data.blockStatus, "blocked-observed");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.resource).sort(), ["cliente", "cliente_contrato", "radusuarios", "su_oss_chamado"]);
  assert.ok(calls.every((call) => call.command === "listar"));
  assert.equal(calls.find((call) => call.resource === "cliente_contrato").body.rp, "5");
  assert.ok(calls.every((call) => call.body.query === "10"));
});

test("adaptador preserva desbloqueio desconhecido e recuperação nunca conclui bloqueio sem evidência", async () => {
  for (const value of [undefined, null, "", "X", "N", "S"]) {
    const source = new IxcReadonlyProvider({ baseUrl: "https://ixc.invalid", token: "synthetic", allowedCustomerIds: ["10"], fullBase: true, retryLimit: 0,
      fetcher: async (url) => {
        const resource = String(url).split("/").at(-1);
        const rows = resource === "cliente" ? [{ id: "10" }] : resource === "cliente_contrato" ? [{ id: "100", id_cliente: "10", status: "A", status_internet: "CA", desbloqueio_confianca_ativo: value }] : [];
        return Response.json({ registros: rows, total: rows.length });
      },
    });
    const data = await loadRecoveryCustomer(source, "10", "corr-unknown-unlock", NOW);
    assert.equal(data.blockStatus, value === "N" ? "blocked-observed" : "inconclusive", String(value));
    assert.equal(data.contracts[0].trustUnlockActive, value === "N" ? false : value === "S" ? true : null);
  }
  const legacy = provider([], { async getServiceDiagnosis() { return { contracts: [{ id: "100", status: "A", internetStatus: "CA", trustUnlockActive: false }], logins: [], openServiceOrders: [] }; } });
  const data = await loadRecoveryCustomer(legacy, "10", "corr-legacy", NOW);
  assert.equal(data.blockStatus, "inconclusive", "booleano sem marcador de origem não comprova estado conhecido");
  assert.equal(data.contracts[0].trustUnlockActive, null);
});

test("cinco contratos ativos não provam ausência global de bloqueio; códigos não conhecidos são inconclusivos", async () => {
  const source = provider([], { async getServiceDiagnosis() { return { logins: [], contracts: Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), status: "A", internetStatus: i > 4 ? "CA" : i === 0 ? "ZZ" : "A", trustUnlockActive: false, trustUnlockKnown: true })), openServiceOrders: [] }; } });
  const data = await loadRecoveryCustomer(source, "10", "corr-detail", NOW);
  assert.equal(data.contracts.length, 5);
  assert.equal(data.blockStatus, "inconclusive");
  assert.equal(data.contracts[0].label, "código ZZ");
  assert.equal(data.contractsLimit, 5);
});

test("código de bloqueio em contrato inativo, cancelado ou sem ciclo conhecido não comprova bloqueio atual", async () => {
  for (const status of ["I", "C", "", "X"]) {
    for (const internetStatus of ["CA", "CM", "FA"]) {
      const source = provider([], { async getServiceDiagnosis() { return { logins: [], contracts: [{ id: "12", status, internetStatus, trustUnlockActive: false, trustUnlockKnown: true }], openServiceOrders: [] }; } });
      const data = await loadRecoveryCustomer(source, "10", "corr-detail", NOW);
      assert.equal(data.blockStatus, "inconclusive", `${status}/${internetStatus}`);
      assert.equal(data.contracts[0].blocked, false);
      assert.equal(data.contracts[0].contractStatus, status);
      assert.equal(data.contracts[0].internetStatus, internetStatus, "código original permanece como contexto, não como conclusão");
    }
  }
});

test("desbloqueio de confiança ativo impede concluir bloqueio mesmo com contrato ativo e código de bloqueio", async () => {
  for (const internetStatus of ["CA", "CM", "FA"]) {
    for (const trustUnlockActive of [true, false]) {
      const source = provider([], { async getServiceDiagnosis() { return { logins: [], contracts: [{ id: "12", status: "A", internetStatus, trustUnlockActive, trustUnlockKnown: true }], openServiceOrders: [] }; } });
      const data = await loadRecoveryCustomer(source, "10", "corr-detail", NOW);
      assert.equal(data.blockStatus, trustUnlockActive ? "inconclusive" : "blocked-observed");
      assert.equal(data.contracts[0].blocked, !trustUnlockActive);
      assert.equal(data.contracts[0].trustUnlockActive, trustUnlockActive);
      assert.equal(data.contracts[0].internetStatus, internetStatus);
    }
  }
});

test("detalhe parcial preserva informação disponível e não vaza erro da fonte", async () => {
  const data = await loadRecoveryCustomer(provider([], { async getCustomerRecord() { throw new Error("segredo"); } }), "10", "corr-detail", NOW);
  assert.equal(data.available, true);
  assert.equal(data.customerName, null);
  assert.equal(data.sources.customer, "unavailable");
  assert.equal(data.blockStatus, "inconclusive");
  assert.doesNotMatch(JSON.stringify(data), /segredo/);
});

test("API de detalhe recusa ID inválido e também exige sessão e full-base", async () => {
  const handler = createRecoveryGetHandler(dependencies({ getRuntime() { assert.fail("id inválido não consulta"); } }), true);
  for (const id of ["", "abc", "-1", "0", "1 OR 1=1"]) assert.equal((await handler(request(`?customerId=${encodeURIComponent(id)}`))).status, 400);
  const denied = createRecoveryGetHandler(dependencies({ async authorize() { return { allowed: true }; }, getRuntime() { assert.fail("sem sessão"); } }), true);
  assert.equal((await denied(request("?customerId=10"))).status, 401);
});

test("repositório de promessas usa recorte por cliente e janela por grupo, sem criar ou atualizar", async () => {
  const calls = [];
  const ranked = { position: "position", customerId: "customer_id", createdAt: "created_at", id: "id" };
  const resultRows = Array.from({ length: 3 }, (_, i) => ({ id: String(i), customerId: "10", invoiceId: "1", promisedFor: "2026-10-01", status: ["pending", "fulfilled", "broken"][i], createdAt: `2026-10-0${3 - i}T00:00:00Z` }));
  const db = { select(fields) {
    calls.push(fields ? "ranked-select" : "bounded-select");
    if (fields) return { from() { return { where() { calls.push("filtered-customers"); return { as() { return ranked; } }; } }; } };
    return { from(table) { assert.equal(table, ranked); return { where() { calls.push("bounded-per-customer"); return { async orderBy() { return resultRows; } }; } }; } };
  } };
  const result = await new DbRecoveryPromiseRepository(db).listForCustomers(["10"], 2);
  assert.deepEqual(calls, ["ranked-select", "filtered-customers", "bounded-select", "bounded-per-customer"]);
  assert.equal(result.get("10").rows.length, 2);
  assert.equal(result.get("10").truncated, true);
  assert.deepEqual(result.get("10").rows.map((row) => row.status), ["pending", "fulfilled"]);
});

test("SQL real de promessas é SELECT parametrizado, filtrado antes da janela e limitado por cliente", async () => {
  const calls = [];
  const db = drizzle({ client: { async query(config, parameters) { calls.push({ sql: config.text, parameters }); return { rows: [] }; } } });
  const histories = await new DbRecoveryPromiseRepository(db).listForCustomers(["10", "20"], 20);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /row_number\(\) over \(partition by/);
  assert.match(calls[0].sql, /"payment_promises"\."customer_id" in \(\$1, \$2\)/);
  assert.match(calls[0].sql, /"position" <= \$3/);
  assert.deepEqual(calls[0].parameters, ["10", "20", 21]);
  assert.doesNotMatch(calls[0].sql, /insert|update|delete/i);
  assert.equal(histories.get("10").available, true);
});
