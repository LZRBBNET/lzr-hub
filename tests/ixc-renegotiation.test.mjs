import test from "node:test";
import assert from "node:assert/strict";
import { renegotiateInvoices, IxcWriteClientError } from "../lib/integrations/ixc/write-client.ts";
import {
  MemoryIxcWriteOperationsRepository, assertRenegotiationPolicy, requestRenegotiation,
  IxcWritePolicyError, IXC_WRITE_CATALOG,
} from "../lib/platform/ixc-write-service.ts";

const options = (fetcher) => ({ baseUrl: "https://ixc-bridge.exemplo.com.br", token: "token-teste", fetcher });
const input = (over = {}) => ({
  invoiceIds: ["145366", "145367"], customerId: "21857", branchId: "1", accountId: "25972",
  contractId: "2", walletId: "1", paymentTermId: "3", originalTotal: 150, issuedOn: "13/08/2026", ...over,
});

/** Responde cada passo do wizard na ordem em que o IXC responderia. */
function wizardFetcher(overrides = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    if (url.endsWith("renegociar_selecionados")) return new Response(JSON.stringify(overrides.step1 ?? { id_renegociacao: 643, type: "success" }), { status: 200 });
    if (url.endsWith("calcula_juros_multa")) {
      if (overrides.failStep2) throw new Error("rede caiu");
      return new Response(JSON.stringify({ totalFineAndFess: "12,50", dateExpiration: "2026-09-10", type: "success" }), { status: 200 });
    }
    if (url.includes("fn_renegociacao_wiz/")) {
      if (overrides.failFinalize && JSON.parse(init.body).finalizar === "S") return new Response(JSON.stringify({ type: "error", message: "Condição inválida" }), { status: 200 });
      return new Response(JSON.stringify({ type: "success", id: "643" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  return { fetcher, calls };
}

test("executa os quatro passos na ordem, criando antes de calcular", async () => {
  const { fetcher, calls } = wizardFetcher();
  const result = await renegotiateInvoices(options(fetcher), input(), "corr-1");
  assert.deepEqual(calls.map((c) => c.url.split("/v1/")[1]), [
    "renegociar_selecionados", "calcula_juros_multa", "fn_renegociacao_wiz/643", "fn_renegociacao_wiz/643",
  ]);
  assert.equal(calls[0].body.get_id, "145366,145367", "as faturas vão juntas no passo que cria");
  assert.equal(calls[2].body.finalizar, "N", "preenche antes de finalizar");
  assert.equal(calls[3].body.finalizar, "S");
  assert.equal(result.renegotiationId, "643");
});

test("o valor vem das faturas e do cálculo do IXC, nunca de conta nossa", async () => {
  const { fetcher, calls } = wizardFetcher();
  await renegotiateInvoices(options(fetcher), input({ originalTotal: 150 }), "corr-1");
  const body = calls[3].body;
  assert.equal(body.valor_renegociado, "150.00", "o original é a soma das faturas lidas do IXC");
  assert.equal(body.valor_acrescimos, "12,50", "o acréscimo é o que o IXC calculou");
  assert.equal(body.valor_total_pagar, "162.50");
});

test("desconto é sempre zero — conceder desconto não se automatiza", async () => {
  const { fetcher, calls } = wizardFetcher();
  await renegotiateInvoices(options(fetcher), input(), "corr-1");
  assert.equal(calls[3].body.valor_descontos, "0,00");
});

test("sem id_renegociacao a sequência para logo — é o único momento sem rastro no ERP", async () => {
  const { fetcher } = wizardFetcher({ step1: { type: "success", message: "ok" } });
  await assert.rejects(renegotiateInvoices(options(fetcher), input(), "corr-1"), (error) => {
    assert.ok(error instanceof IxcWriteClientError);
    assert.match(error.message, /IXC_SEM_ID_RENEGOCIACAO/);
    return true;
  });
});

test("o progresso reporta o id assim que o IXC o devolve", async () => {
  const { fetcher } = wizardFetcher();
  const passos = [];
  await renegotiateInvoices(options(fetcher), input(), "corr-1", (p) => passos.push(p));
  const primeiroComId = passos.find((p) => p.renegotiationId);
  assert.equal(primeiroComId.renegotiationId, "643");
  assert.equal(primeiroComId.step, 1, "quem chama precisa saber do id já no passo 1, não só no fim");
});

const policy = (over = {}) => ({
  invoiceIds: ["145366"], eligibleIds: new Set(["145366", "145367"]),
  originalTotal: 150, expectedTotal: 150, walletId: "1", paymentTermId: "3",
  knownWalletIds: new Set(["1", "5"]), knownPaymentTermIds: new Set(["3", "4"]),
  branchId: "1", accountId: "25972", contractId: "2", ...over,
});

test("fatura que não é do cliente (ou já paga) não entra na renegociação", () => {
  // Renegociar fatura paga recria a dívida de quem já pagou.
  assert.throws(() => assertRenegotiationPolicy(policy({ invoiceIds: ["999999"] })), IxcWritePolicyError);
});

test("carteira e condição precisam existir no catálogo do IXC", () => {
  assert.throws(() => assertRenegotiationPolicy(policy({ walletId: "99" })), IxcWritePolicyError);
  assert.throws(() => assertRenegotiationPolicy(policy({ paymentTermId: "99" })), IxcWritePolicyError);
});

test("cadastro sem filial, conta ou contrato não renegocia", () => {
  assert.throws(() => assertRenegotiationPolicy(policy({ branchId: undefined })), IxcWritePolicyError);
  assert.throws(() => assertRenegotiationPolicy(policy({ accountId: undefined })), IxcWritePolicyError);
  assert.throws(() => assertRenegotiationPolicy(policy({ contractId: undefined })), IxcWritePolicyError);
});

test("total que não bate com o do IXC recusa a operação", () => {
  // A tela pode estar com dado velho; o número que a pessoa viu tem que ser o
  // mesmo que o servidor acabou de somar.
  assert.throws(() => assertRenegotiationPolicy(policy({ expectedTotal: 50 })), IxcWritePolicyError);
  assert.doesNotThrow(() => assertRenegotiationPolicy(policy({ expectedTotal: 150.004 })), "centavo de arredondamento passa");
});

test("nenhuma fatura, ou soma zero, não é renegociação", () => {
  assert.throws(() => assertRenegotiationPolicy(policy({ invoiceIds: [] })), IxcWritePolicyError);
  assert.throws(() => assertRenegotiationPolicy(policy({ originalTotal: 0, expectedTotal: 0 })), IxcWritePolicyError);
});

const serviceRequest = (over = {}) => ({
  customerId: "21857", invoiceIds: ["145366"], idempotencyKey: "reneg-1", correlationId: "corr-1",
  requestedBy: "vinicius@bbnet.dev", policy: policy(), ...over,
});

test("sem FEATURE_IXC_WRITE nada é enviado, e o bloqueio fica no ledger", async () => {
  delete process.env.FEATURE_IXC_WRITE;
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamou = false;
  const result = await requestRenegotiation(serviceRequest(), repository, async () => { chamou = true; return {}; });
  assert.equal(chamou, false);
  assert.equal(result.status, "blocked");
  assert.equal(repository.rows[0].invoiceId, "faturas:145366", "sem renegociação criada, o ledger guarda as faturas");
});

test("falha DEPOIS do passo 1 registra o id e o passo — o ERP ficou com coisa pela metade", async () => {
  // É a propriedade mais importante do arquivo. Um "failed" seco esconderia uma
  // renegociação real pendurada nas faturas do cliente.
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestRenegotiation(serviceRequest(), repository, async (_corr, onProgress) => {
    onProgress({ step: 1, renegotiationId: "643", note: "renegociação 643 criada no IXC" });
    onProgress({ step: 2, renegotiationId: "643", note: "pedindo cálculo de juro e multa" });
    throw new Error("IXC_TIMEOUT");
  });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /PENDENTE DE CONFERÊNCIA MANUAL/);
  assert.match(result.detail, /643/);
  assert.match(result.detail, /passo 2/);
  assert.equal(repository.rows[0].invoiceId, "renegociacao:643", "dá para achar pelo id o que ficou no ERP");
  delete process.env.FEATURE_IXC_WRITE;
});

test("falha ANTES de gravar diz isso com todas as letras", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestRenegotiation(serviceRequest(), repository, async () => { throw new Error("IXC_NETWORK_ERROR"); });
  assert.match(result.detail, /antes de gravar qualquer coisa/);
  assert.doesNotMatch(result.detail, /PENDENTE/);
  delete process.env.FEATURE_IXC_WRITE;
});

test("a mesma chave nunca renegocia duas vezes", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  let chamadas = 0;
  const call = async () => { chamadas += 1; return { raw: { type: "success" }, renegotiationId: "643", surcharge: "12,50", dueDate: "2026-09-10" }; };
  const primeira = await requestRenegotiation(serviceRequest(), repository, call);
  const repetida = await requestRenegotiation(serviceRequest(), repository, call);
  assert.equal(primeira.status, "success");
  assert.equal(chamadas, 1, "clique duplo não pode consolidar a dívida duas vezes");
  assert.equal(repetida.replay, true);
  delete process.env.FEATURE_IXC_WRITE;
});

test("sucesso guarda o id, o acréscimo e o vencimento no ledger", async () => {
  process.env.FEATURE_IXC_WRITE = "true";
  const repository = new MemoryIxcWriteOperationsRepository();
  const result = await requestRenegotiation(serviceRequest(), repository, async () => ({ raw: { type: "success" }, renegotiationId: "643", surcharge: "12,50", dueDate: "2026-09-10" }));
  assert.equal(result.status, "success");
  assert.match(repository.rows[0].detail, /643/);
  assert.match(repository.rows[0].detail, /12,50/);
  delete process.env.FEATURE_IXC_WRITE;
});

test("o catálogo agora tem três operações prontas e uma não", () => {
  const naoFeitas = IXC_WRITE_CATALOG.filter((item) => !item.implemented).map((item) => item.operation);
  assert.deepEqual(naoFeitas, ["customer.create"]);
});
