import test from "node:test";
import assert from "node:assert/strict";
import { openServiceOrder, IxcWriteClientError } from "../lib/integrations/ixc/write-client.ts";
import {
  MemoryIxcWriteOperationsRepository, assertServiceOrderPolicy, requestServiceOrderOpen,
  IxcWritePolicyError, IXC_WRITE_CATALOG,
} from "../lib/platform/ixc-write-service.ts";

const options = (fetcher) => ({ baseUrl: "https://ixc-bridge.exemplo.com.br", token: "token-teste", fetcher });
const input = (over = {}) => ({
  customerId: "21857", subjectId: "27", sectorId: "1", branchId: "1", priority: "1",
  message: "Cliente relata lentidão desde ontem à noite", ...over,
});

test("monta a requisição como a coleção Postman documenta", async () => {
  let captured;
  const fetcher = async (url, init) => { captured = { url, init }; return new Response(JSON.stringify({ id: "500123" }), { status: 200 }); };
  await openServiceOrder(options(fetcher), input(), "corr-1");
  assert.equal(captured.url, "https://ixc-bridge.exemplo.com.br/webservice/v1/su_oss_chamado");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["x-correlation-id"], "corr-1");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.tipo, "C", "OS de cliente, não de estrutura");
  assert.equal(body.id_assunto, "27");
  assert.equal(body.id_cliente, "21857");
  assert.equal(body.id_filial, "1");
  assert.equal(body.origem_endereco, "M", "usa o endereço do cadastro — sem isso o técnico não sabe para onde ir");
  assert.equal(body.setor, "1");
  assert.equal(body.status, "A");
});

test("só os campos obrigatórios vão no corpo", async () => {
  let captured;
  const fetcher = async (_url, init) => { captured = init; return new Response(JSON.stringify({ id: "1" }), { status: 200 }); };
  await openServiceOrder(options(fetcher), input(), "corr-1");
  // Mandar o corpo inteiro com dezenas de vazios sobrescreveria com "" o que o
  // IXC preencheria sozinho (data de abertura, protocolo, técnico).
  const keys = Object.keys(JSON.parse(captured.body));
  assert.ok(!keys.includes("data_abertura"), keys.join(","));
  assert.ok(!keys.includes("id_tecnico"));
  assert.ok(!keys.includes("protocolo"));
});

test("recusa do IXC com HTTP 200 não vira sucesso", async () => {
  // O IXC responde 200 mesmo quando recusa; sem checar `type`, o ledger
  // registraria uma OS que não existe e ninguém iria atrás.
  const fetcher = async () => new Response(JSON.stringify({ type: "error", message: "Permissão negada" }), { status: 200 });
  await assert.rejects(openServiceOrder(options(fetcher), input(), "corr-1"), (error) => {
    assert.ok(error instanceof IxcWriteClientError);
    assert.match(error.message, /IXC_RECUSOU/);
    return true;
  });
});

test("resposta vazia ou ilegível falha alto", async () => {
  await assert.rejects(openServiceOrder(options(async () => new Response("", { status: 200 })), input(), "c"), IxcWriteClientError);
  await assert.rejects(openServiceOrder(options(async () => new Response("<html>erro</html>", { status: 200 })), input(), "c"), IxcWriteClientError);
});

const policy = (over = {}) => ({
  subjectId: "27", sectorId: "1", branchId: "1", message: "Cliente relata lentidão desde ontem",
  knownSubjectIds: new Set(["27", "5"]), knownSectorIds: new Set(["1", "6"]), openSubjects: new Set(),
  ...over,
});

test("assunto fora do catálogo do IXC é recusado", () => {
  // O catálogo tem 159 assuntos com ids salteados e muda sem avisar — validar
  // contra um enum nosso abriria chamado que ninguém sabe atender.
  assert.throws(() => assertServiceOrderPolicy(policy({ subjectId: "999" })), IxcWritePolicyError);
});

test("setor fora do catálogo do IXC é recusado", () => {
  assert.throws(() => assertServiceOrderPolicy(policy({ sectorId: "42" })), IxcWritePolicyError);
});

test("cliente sem filial no cadastro não gera OS", () => {
  // A BBNET tem 21 filiais; sem saber a do cliente, a OS iria para a empresa errada.
  assert.throws(() => assertServiceOrderPolicy(policy({ branchId: undefined })), IxcWritePolicyError);
});

test("OS sem descrição do problema é recusada", () => {
  assert.throws(() => assertServiceOrderPolicy(policy({ message: "lento" })), IxcWritePolicyError);
  assert.throws(() => assertServiceOrderPolicy(policy({ message: "          " })), IxcWritePolicyError);
});

test("cliente com OS aberta do mesmo assunto não recebe outra", () => {
  assert.throws(() => assertServiceOrderPolicy(policy({ openSubjects: new Set(["27"]) })), IxcWritePolicyError);
  assert.doesNotThrow(() => assertServiceOrderPolicy(policy({ openSubjects: new Set(["5"]) })), "assunto diferente pode");
});

const orderRequest = (over = {}) => ({
  customerId: "21857", subjectId: "27", sectorId: "1", branchId: "1", priority: "1",
  message: "Cliente relata lentidão desde ontem", idempotencyKey: "os-1", correlationId: "corr-1",
  requestedBy: "vinicius@bbnet.dev",
  knownSubjectIds: new Set(["27"]), knownSectorIds: new Set(["1"]), openSubjects: new Set(),
  ...over,
});

test("sem FEATURE_IXC_WRITE nada é enviado ao IXC, e o bloqueio fica no ledger", async () => {
  delete process.env.FEATURE_IXC_WRITE;
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamou = false;
  const result = await requestServiceOrderOpen(orderRequest(), repository, async () => { chamou = true; return { raw: {} }; });
  assert.equal(chamou, false, "a flag é a última barreira — nada sai daqui com ela desligada");
  assert.equal(result.status, "blocked");
  assert.equal(repository.rows.length, 1, "auditoria existe para provar decisão, não só sucesso");
  assert.equal(repository.rows[0].status, "blocked");
});

test("bloqueio de política também é registrado, e o IXC nem é chamado", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamou = false;
  const result = await requestServiceOrderOpen(orderRequest({ subjectId: "999" }), repository, async () => { chamou = true; return { raw: {} }; });
  assert.equal(chamou, false);
  assert.equal(result.status, "blocked");
  assert.match(repository.rows[0].detail, /catálogo/);
  delete process.env.FEATURE_IXC_WRITE;
});

test("a mesma chave nunca abre duas ordens de serviço", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamadas = 0;
  const call = async () => { chamadas += 1; return { raw: { id: "500123" } }; };
  const primeira = await requestServiceOrderOpen(orderRequest(), repository, call);
  const repetida = await requestServiceOrderOpen(orderRequest(), repository, call);
  assert.equal(primeira.status, "success");
  assert.equal(chamadas, 1, "rede oscilando não pode mandar dois técnicos ao mesmo cliente");
  assert.equal(repetida.replay, true);
  assert.equal(repetida.status, "success");
  delete process.env.FEATURE_IXC_WRITE;
});

test("falha do IXC é registrada como falha, nunca como sucesso", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestServiceOrderOpen(orderRequest(), repository, async () => { throw new Error("IXC_TIMEOUT"); });
  assert.equal(result.status, "failed");
  assert.equal(repository.rows[0].detail, "IXC_TIMEOUT");
  delete process.env.FEATURE_IXC_WRITE;
});

test("a resposta crua do IXC fica guardada — é ela que prova o formato na primeira vez", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestServiceOrderOpen(orderRequest(), repository, async () => ({ raw: { type: "success", id: "500123" } }));
  assert.match(result.detail, /500123/);
  assert.equal(result.raw.id, "500123");
  delete process.env.FEATURE_IXC_WRITE;
});

test("o catálogo declara a abertura de OS como implementada", () => {
  const entry = IXC_WRITE_CATALOG.find((item) => item.operation === "service_order.open");
  assert.equal(entry.implemented, true);
  const naoFeitas = IXC_WRITE_CATALOG.filter((item) => !item.implemented).map((item) => item.operation);
  assert.deepEqual(naoFeitas, ["negotiation.register", "customer.create"], "o catálogo não pode dizer pronto o que não está");
});
