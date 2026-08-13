import test from "node:test";
import assert from "node:assert/strict";
import { checkDocument } from "../lib/platform/document-check.ts";
import { createCustomer, IxcWriteClientError } from "../lib/integrations/ixc/write-client.ts";
import {
  MemoryIxcWriteOperationsRepository, assertCustomerCreatePolicy, requestCustomerCreate,
  IxcWritePolicyError, IXC_WRITE_CATALOG,
} from "../lib/platform/ixc-write-service.ts";

test("CPF válido é reconhecido e volta com máscara", () => {
  const check = checkDocument("529.982.247-25");
  assert.equal(check.valid, true);
  assert.equal(check.kind, "F");
  assert.equal(check.masked, "529.982.247-25", "o IXC guarda com máscara");
  assert.equal(checkDocument("52998224725").masked, "529.982.247-25", "sem máscara na entrada dá no mesmo");
});

test("CNPJ válido é reconhecido como pessoa jurídica", () => {
  const check = checkDocument("11.222.333/0001-81");
  assert.equal(check.valid, true);
  assert.equal(check.kind, "J");
});

test("documento com dígito errado é recusado", () => {
  // Cadastro com CPF inválido nunca fatura direito: boleto recusado pelo banco,
  // nota fiscal que não sai, e correção depois com contrato já pendurado.
  assert.equal(checkDocument("529.982.247-26").valid, false);
  assert.equal(checkDocument("11.222.333/0001-82").valid, false);
});

test("sequência de dígitos iguais não passa", () => {
  // 111.111.111-11 fecha a conta dos verificadores e não é documento de ninguém.
  assert.equal(checkDocument("11111111111").valid, false);
  assert.equal(checkDocument("00000000000000").valid, false);
});

test("tamanho errado é recusado sem tentar adivinhar", () => {
  assert.equal(checkDocument("1234").valid, false);
  assert.equal(checkDocument("").valid, false);
});

const options = (fetcher) => ({ baseUrl: "https://ixc-bridge.exemplo.com.br", token: "t", fetcher });
const customer = (over = {}) => ({
  name: "Joana Ribeiro", document: "529.982.247-25", personKind: "F", cep: "49000-000",
  street: "Rua das Flores", number: "120", neighborhood: "Centro", cityId: "1753", ufId: "28",
  phone: "(79) 99123-4567", email: "joana@exemplo.com", ...over,
});

test("monta o cadastro com os obrigatórios da coleção Postman", async () => {
  let captured;
  const fetcher = async (url, init) => { captured = { url, init }; return new Response(JSON.stringify({ id: "30111", type: "success" }), { status: 200 }); };
  const result = await createCustomer(options(fetcher), customer(), "corr-1");
  assert.equal(captured.url, "https://ixc-bridge.exemplo.com.br/webservice/v1/cliente");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.ativo, "S");
  assert.equal(body.tipo_pessoa, "F");
  assert.equal(body.cnpj_cpf, "529.982.247-25");
  assert.equal(body.cidade, "1753", "código interno do IXC, não o nome");
  assert.equal(body.uf, "28");
  assert.equal(body.tipo_localidade, "U");
  assert.equal(result.customerId, "30111");
});

test("não liga aviso de cobrança por conta própria", () => {
  // Ligar e-mail/SMS de cobrança sem a pessoa pedir é mandar mensagem em nome
  // do provedor por decisão nossa.
  return createCustomer(options(async (_u, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.cob_envia_email, "");
    assert.equal(body.cob_envia_sms, "");
    return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  }), customer(), "c");
});

test("resposta sem id não vira sucesso", async () => {
  const fetcher = async () => new Response(JSON.stringify({ type: "success", message: "ok" }), { status: 200 });
  await assert.rejects(createCustomer(options(fetcher), customer(), "c"), (error) => {
    assert.match(error.message, /IXC_SEM_ID_CLIENTE/);
    return true;
  });
});

test("recusa do IXC com HTTP 200 falha alto", async () => {
  const fetcher = async () => new Response(JSON.stringify({ type: "error", message: "CPF já cadastrado" }), { status: 200 });
  await assert.rejects(createCustomer(options(fetcher), customer(), "c"), IxcWriteClientError);
});

const policy = (over = {}) => ({
  documentValid: true, existingCustomerId: undefined, leadStage: "ganho", leadAlreadyLinked: null,
  cityId: "1753", knownCityIds: new Set(["1753", "1759"]),
  street: "Rua das Flores", number: "120", cep: "49000-000", ...over,
});

test("documento inválido não vira cadastro", () => {
  assert.throws(() => assertCustomerCreatePolicy(policy({ documentValid: false })), IxcWritePolicyError);
});

test("documento que já existe no IXC bloqueia a duplicata", () => {
  // Duplicar cliente é dois fluxos de fatura e um contrato órfão; apagar
  // cadastro com contrato pendurado não é opção.
  assert.throws(() => assertCustomerCreatePolicy(policy({ existingCustomerId: "21857" })), IxcWritePolicyError);
});

test("só lead ganho vira cadastro", () => {
  for (const stage of ["novo", "qualificado", "proposta", "perdido"]) {
    assert.throws(() => assertCustomerCreatePolicy(policy({ leadStage: stage })), IxcWritePolicyError, stage);
  }
  assert.doesNotThrow(() => assertCustomerCreatePolicy(policy({ leadStage: "ganho" })));
});

test("lead que já virou cadastro não vira outro", () => {
  assert.throws(() => assertCustomerCreatePolicy(policy({ leadAlreadyLinked: "30111" })), IxcWritePolicyError);
});

test("cidade fora do catálogo do IXC é recusada", () => {
  assert.throws(() => assertCustomerCreatePolicy(policy({ cityId: "99999" })), IxcWritePolicyError);
});

test("endereço incompleto é recusado", () => {
  // Sem rua e número o técnico não tem onde instalar.
  assert.throws(() => assertCustomerCreatePolicy(policy({ street: "R" })), IxcWritePolicyError);
  assert.throws(() => assertCustomerCreatePolicy(policy({ number: "" })), IxcWritePolicyError);
  assert.throws(() => assertCustomerCreatePolicy(policy({ cep: "4900" })), IxcWritePolicyError);
});

const serviceRequest = (over = {}) => ({
  leadId: "lead-1", idempotencyKey: "cad-1", correlationId: "corr-1",
  requestedBy: "vinicius@bbnet.dev", policy: policy(), ...over,
});

test("sem FEATURE_IXC_WRITE nada é cadastrado, e o bloqueio fica no ledger", async () => {
  delete process.env.FEATURE_IXC_WRITE;
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamou = false;
  const result = await requestCustomerCreate(serviceRequest(), repository, async () => { chamou = true; return { raw: {}, customerId: "1" }; });
  assert.equal(chamou, false);
  assert.equal(result.status, "blocked");
  assert.equal(repository.rows[0].invoiceId, "lead:lead-1", "dá para achar de qual lead era a tentativa");
});

test("a mesma chave nunca cadastra duas vezes", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamadas = 0;
  const call = async () => { chamadas += 1; return { raw: { type: "success" }, customerId: "30111" }; };
  const primeira = await requestCustomerCreate(serviceRequest(), repository, call);
  const repetida = await requestCustomerCreate(serviceRequest(), repository, call);
  assert.equal(primeira.status, "success");
  assert.equal(chamadas, 1, "clique duplo não pode criar dois cadastros da mesma pessoa");
  assert.equal(repetida.replay, true);
  delete process.env.FEATURE_IXC_WRITE;
});

test("o vínculo com o lead é gravado depois do cadastro", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  let vinculado;
  await requestCustomerCreate(serviceRequest(), repository,
    async () => ({ raw: {}, customerId: "30111" }),
    async (id) => { vinculado = id; });
  assert.equal(vinculado, "30111");
  delete process.env.FEATURE_IXC_WRITE;
});

test("se o vínculo falhar, o aviso diz que o cadastro existe mesmo assim", async () => {
  // O cadastro já está no ERP; um erro seco aqui faria alguém tentar de novo e
  // criar a duplicata que a política inteira existe para evitar.
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestCustomerCreate(serviceRequest(), repository,
    async () => ({ raw: {}, customerId: "30111" }),
    async () => { throw new Error("banco caiu"); });
  assert.equal(result.status, "success");
  assert.match(result.detail, /30111/);
  assert.match(result.detail, /vínculo com o lead não foi gravado/);
  delete process.env.FEATURE_IXC_WRITE;
});

test("o catálogo de escrita está completo", () => {
  assert.deepEqual(IXC_WRITE_CATALOG.filter((item) => !item.implemented), [], "as quatro operações do épico estão de pé");
});
