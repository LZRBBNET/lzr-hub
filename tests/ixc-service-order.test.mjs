import test from "node:test";
import assert from "node:assert/strict";
import { openServiceOrder, IxcWriteClientError } from "../lib/integrations/ixc/write-client.ts";
import {
  MemoryIxcWriteOperationsRepository, assertServiceOrderPolicy, requestServiceOrderOpen,
  IxcWritePolicyError, IXC_WRITE_CATALOG,
} from "../lib/platform/ixc-write-service.ts";

const options = (fetcher) => ({ baseUrl: "https://ixc-bridge.exemplo.com.br", token: "token-teste", fetcher });
const input = (over = {}) => ({
  customerId: "21857", contractId: "321", confirmedContract: { id: "321", customerId: "21857", status: "A" }, subjectId: "27", sectorId: "1", branchId: "1", priority: "1",
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
  assert.equal(body.id_contrato_kit, "321");
  assert.equal(body.id_contrato, undefined);
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
  customerId: "21857", contractId: "321", confirmedContract: { id: "321", customerId: "21857", status: "A" }, subjectId: "27", sectorId: "1", branchId: "1", priority: "1",
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

test("falha do IXC mantém reserva incerta, nunca libera reenvio", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestServiceOrderOpen(orderRequest(), repository, async () => { throw new Error("IXC_TIMEOUT"); });
  assert.equal(result.status, "unknown");
  assert.match(repository.rows[0].detail, /Não reenviar/);
  delete process.env.FEATURE_IXC_WRITE;
});

test("somente o ID confirmado fica disponível no resultado", async () => {
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
  // O catálogo completo é conferido em tests/ixc-customer-create.test.mjs; aqui
  // basta a OS não voltar a se declarar pendente.
  assert.equal(IXC_WRITE_CATALOG.filter((item) => !item.implemented).length, 0);
});

test("concorrência: reserva única precede qualquer efeito remoto", async () => {
  process.env.FEATURE_IXC_WRITE="true";
  try {
    const repo=new MemoryIxcWriteOperationsRepository(); let calls=0; let release;
    const gate=new Promise(resolve=>{release=resolve});
    const call=async()=>{calls++;assert.equal(repo.rows[0].status,"pending");await gate;return {raw:{id:"42"}}};
    const first=requestServiceOrderOpen(orderRequest(),repo,call);
    await new Promise(resolve=>setImmediate(resolve));
    const second=await requestServiceOrderOpen(orderRequest(),repo,call);
    assert.equal(second.status,"pending");assert.equal(second.replay,true);assert.equal(calls,1);
    release();assert.equal((await first).status,"success");
    assert.equal(repo.rows.filter(row=>row.operation==="service_order.open").length,1);
  } finally {delete process.env.FEATURE_IXC_WRITE;}
});

test("resposta perdida e falha do ledger nunca permitem segunda chamada", async () => {
  process.env.FEATURE_IXC_WRITE="true";
  try {
    for(const ledgerFailure of [false,true]){
      const repo=new MemoryIxcWriteOperationsRepository();let calls=0;
      if(ledgerFailure)repo.finishClaim=async()=>{throw new Error("database unavailable")};
      const call=async()=>{calls++;if(!ledgerFailure)throw new Error("lost response after creation");return {raw:{id:"42"}}};
      assert.equal((await requestServiceOrderOpen(orderRequest(),repo,call)).status,"unknown");
      const replay=await requestServiceOrderOpen(orderRequest(),repo,call);
      assert.ok(["pending","unknown"].includes(replay.status));assert.equal(calls,1);
    }
  } finally {delete process.env.FEATURE_IXC_WRITE;}
});

test("reserva indisponível impede chamada; chave com payload diferente é recusada", async () => {
  process.env.FEATURE_IXC_WRITE="true";
  try {
    const repo=new MemoryIxcWriteOperationsRepository();let calls=0;
    const call=async()=>{calls++;return {raw:{id:"42",message:"sensitive"}}};
    const first=await requestServiceOrderOpen(orderRequest(),repo,call);
    assert.deepEqual(first.raw,{id:"42"});
    assert.equal((await requestServiceOrderOpen(orderRequest({message:"different description"}),repo,call)).status,"unknown");
    assert.equal(calls,1);
    repo.claim=async()=>{throw new Error("db down")};
    await assert.rejects(requestServiceOrderOpen(orderRequest({idempotencyKey:"new"}),repo,call));
    assert.equal(calls,1);
  } finally {delete process.env.FEATURE_IXC_WRITE;}
});

test("JSON sem ID confirmado permanece incerto e não é reenviado", async () => {
  process.env.FEATURE_IXC_WRITE="true";
  try {
    const repo=new MemoryIxcWriteOperationsRepository();let calls=0;
    const call=async()=>{calls++;return {raw:{type:"success"}}};
    assert.equal((await requestServiceOrderOpen(orderRequest(),repo,call)).status,"unknown");
    assert.equal((await requestServiceOrderOpen(orderRequest(),repo,call)).status,"unknown");
    assert.equal(calls,1);
  } finally {delete process.env.FEATURE_IXC_WRITE;}
});

test("different keys for one customer/subject cannot race or bypass an uncertain attempt", async () => {
 process.env.FEATURE_IXC_WRITE="true";
 try {
  const repo=new MemoryIxcWriteOperationsRepository();let calls=0;let release;
  const gate=new Promise(resolve=>{release=resolve});
  const call=async()=>{calls++;await gate;throw Error("response lost")};
  const first=requestServiceOrderOpen(orderRequest(),repo,call);
  await new Promise(resolve=>setImmediate(resolve));
  const other=await requestServiceOrderOpen(orderRequest({idempotencyKey:"different"}),repo,call);
  assert.equal(other.status,"blocked");assert.equal(calls,1);
  release();await first;
  assert.equal((await requestServiceOrderOpen(orderRequest({idempotencyKey:"third"}),repo,call)).status,"blocked");
  assert.equal(calls,1);
 } finally {delete process.env.FEATURE_IXC_WRITE;}
});

test("campos que a tela do IXC grava e a API não: liberado, impresso, comissão, horário, técnico, protocolo e endereço", async () => {
  let captured;
  const fetcher = async (_url, init) => { captured = JSON.parse(init.body); return new Response(JSON.stringify({ id: "1" }), { status: 200 }); };
  await openServiceOrder(options(fetcher), input({
    loginId: "32844", technicianId: "43", bestTime: "T", protocol: "20261124000001",
    address: { text: "SE Campo do Brito 49500-000 Centro - Rua A, 12", neighborhood: "Centro", cityId: "1771", complement: "", reference: "Praça", latitude: "-10.7", longitude: "-37.4" },
  }), "corr-1");
  assert.deepEqual(
    [captured.liberado, captured.impresso, captured.status_assinatura, captured.gera_comissao, captured.melhor_horario_agenda],
    ["1", "N", "A", "S", "T"], "como as 26 OS de atendentes medidas em 24/11",
  );
  assert.equal(captured.id_tecnico, "43");
  assert.equal(captured.protocolo, "20261124000001");
  assert.equal(captured.endereco, "SE Campo do Brito 49500-000 Centro - Rua A, 12");
  assert.equal(captured.bairro, "Centro");
  assert.equal(captured.id_cidade, "1771");
  assert.equal(captured.referencia, "Praça");
  assert.equal(captured.complemento, undefined, "vazio não sobrescreve");
  assert.deepEqual([captured.latitude, captured.longitude], ["-10.7", "-37.4"]);
  assert.equal(captured.origem_endereco, "L");
});

test("técnico ou protocolo inválidos não vão ao IXC", async () => {
  let captured;
  const fetcher = async (_url, init) => { captured = JSON.parse(init.body); return new Response(JSON.stringify({ id: "1" }), { status: 200 }); };
  await openServiceOrder(options(fetcher), input({ technicianId: "abc", protocol: "P-1" }), "corr-1");
  assert.equal(captured.id_tecnico, undefined);
  assert.equal(captured.protocolo, undefined);
  assert.equal(captured.melhor_horario_agenda, "Q", "sem pedido do cliente, qualquer horário");
});
