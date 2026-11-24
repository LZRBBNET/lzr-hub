import test from "node:test";
import assert from "node:assert/strict";
import { AI_OS_SUBJECTS, aiServiceOrderSubject, openAiServiceOrder } from "../lib/platform/ai-service-order.ts";
import { MemoryIxcWriteOperationsRepository } from "../lib/platform/ixc-write-service.ts";
import { requestFooter } from "../lib/platform/triage-service.ts";
import { completionLimits, llmConfigFromEnv } from "../lib/agent/llm-classifier.ts";
import { copilotLlmConfigFromEnv } from "../lib/platform/copilot-service.ts";

/**
 * A IA abre a OS no IXC quando o atendimento técnico termina com o pedido pronto.
 * Assuntos do questionário de 18/11/2026: 14 sem internet, 116 lenta, 118 quedas, 49 roteador; setor 1.
 */

test("assunto da OS: sem internet, lenta, quedas e roteador; endereço e cancelamento não abrem OS", () => {
  assert.equal(aiServiceOrderSubject("technical_no_connection", "Sem internet desde 7h, luz LOS vermelha"), AI_OS_SUBJECTS.noConnection);
  assert.equal(aiServiceOrderSubject("technical_slow", "Lenta em todos os aparelhos; sinal fraco"), AI_OS_SUBJECTS.slow);
  assert.equal(aiServiceOrderSubject("technical_slow", "Internet cai e volta toda hora"), AI_OS_SUBJECTS.drops);
  assert.equal(aiServiceOrderSubject("technical_no_connection", "Quedas constantes à noite"), AI_OS_SUBJECTS.drops);
  assert.equal(aiServiceOrderSubject("technical_visit", "Roteador queimou, precisa trocar"), AI_OS_SUBJECTS.equipment);
  assert.equal(aiServiceOrderSubject("technical_visit", "Mudança de endereço para a Rua B"), undefined);
  assert.equal(aiServiceOrderSubject("cancellation_risk", "Quer cancelar, motivo preço"), undefined);
  assert.equal(aiServiceOrderSubject("sales_inquiry", "Cliente novo"), undefined);
});

function provider({ openOrders = [], contracts = [{ id: "48882", status: "A", internetStatus: "A", trustUnlockActive: false }], activeComplete = true, logins = [{ id: "32844", online: false }], loginsComplete = true, readBack = true } = {}) {
  return {
    getServiceDiagnosis: async () => ({ logins: [{ id: "32844", contractId: "48882", online: false }], contracts, openServiceOrders: openOrders }),
    listActiveContracts: async () => ({ ids: contracts.filter((c) => c.status === "A").map((c) => c.id), complete: activeComplete }),
    listContractLogins: async () => ({ logins, complete: loginsComplete }),
    reconcileServiceOrder: async (customerId, contractId, orderId) => { if (!readBack) throw new Error("IXC_OS_UNCONFIRMED"); return { id: orderId, customerId, contractId, status: "A" }; },
    getServiceOrderContract: async (customerId, contractId) => ({ id: contractId, customerId, status: "A" }),
    getCustomerRecord: async () => ({ id: "21857", filial_id: "1" }),
    listOsSubjects: async () => [{ id: "14" }, { id: "116" }, { id: "118" }, { id: "49" }],
    listSectors: async () => [{ id: "1" }],
  };
}
const INPUT = { customerId: "21857", ticketId: "t1", intent: "technical_no_connection", summary: "Sem internet desde 7h\nLuz LOS vermelha\nVisita à tarde\nCPF 529.982.247-25", protocol: "20261118000001" };

test("pedido técnico pronto: abre a OS com assunto, setor, login e a ficha — sem dado pessoal", async () => {
  const before = process.env.FEATURE_IXC_WRITE;
  process.env.FEATURE_IXC_WRITE = "true";
  try {
    const ledger = new MemoryIxcWriteOperationsRepository();
    const sent = [];
    const open = async (order) => { sent.push(order); return { raw: { type: "success", message: "Registro inserido com sucesso!", id: "301041" } }; };
    const result = await openAiServiceOrder({ enabled: true, provider: provider(), ledger, open, correlationId: "c1" }, INPUT);
    assert.deepEqual(result, { status: "success", orderId: "301041", detail: result.detail });
    assert.equal(sent[0].subjectId, "14");
    assert.equal(sent[0].sectorId, "1");
    assert.equal(sent[0].priority, "N");
    assert.equal(sent[0].loginId, "32844", "assunto 14 exige login");
    assert.equal(sent[0].branchId, "1");
    assert.match(sent[0].message, /Aberta pela IA do LZR HUB \(protocolo 20261118000001\)/);
    assert.match(sent[0].message, /Luz LOS vermelha/);
    assert.doesNotMatch(sent[0].message, /529\.982/, "a OS não leva CPF");
    // Webhook reentregue: a mesma chave não abre outra OS e devolve a mesma.
    const again = await openAiServiceOrder({ enabled: true, provider: provider(), ledger, open, correlationId: "c2" }, INPUT);
    assert.equal(sent.length, 1, "uma OS por atendimento");
    assert.equal(again.orderId, "301041");
  } finally {
    if (before === undefined) delete process.env.FEATURE_IXC_WRITE; else process.env.FEATURE_IXC_WRITE = before;
  }
});

test("já tem OS técnica aberta: a IA informa o número e não abre outra", async () => {
  let opened = 0;
  const result = await openAiServiceOrder({ enabled: true, provider: provider({ openOrders: [{ id: "555", status: "A", subjectId: "14" }] }), ledger: new MemoryIxcWriteOperationsRepository(), open: async () => { opened++; return { raw: {} }; }, correlationId: "c" }, INPUT);
  assert.deepEqual(result, { status: "existing", orderId: "555", detail: result.detail });
  assert.equal(opened, 0);
});

test("contrato ambíguo, flag desligada ou IXC fora: nada é aberto e a ficha fica para a equipe", async () => {
  const open = async () => { throw new Error("não devia chamar"); };
  const dois = provider({ contracts: [{ id: "1", status: "A" }, { id: "2", status: "A" }] });
  assert.equal((await openAiServiceOrder({ enabled: true, provider: dois, ledger: new MemoryIxcWriteOperationsRepository(), open, correlationId: "c" }, INPUT)).status, "blocked");
  assert.equal((await openAiServiceOrder({ enabled: false, provider: provider(), ledger: new MemoryIxcWriteOperationsRepository(), open, correlationId: "c" }, INPUT)).status, "skipped");
  const fora = { ...provider(), getServiceDiagnosis: async () => { throw new Error("IXC fora"); } };
  assert.equal((await openAiServiceOrder({ enabled: true, provider: fora, ledger: new MemoryIxcWriteOperationsRepository(), open, correlationId: "c" }, INPUT)).status, "failed");
  assert.equal(await openAiServiceOrder({ enabled: true, provider: provider(), ledger: new MemoryIxcWriteOperationsRepository(), open, correlationId: "c" }, { ...INPUT, intent: "cancellation_risk" }), undefined, "não é caso de OS");
});

test("IXC recusa (HTTP 200 com type error): bloqueado no ledger, sem afirmar OS ao cliente", async () => {
  const before = process.env.FEATURE_IXC_WRITE;
  process.env.FEATURE_IXC_WRITE = "true";
  try {
    const open = async () => { throw new Error("IXC_RECUSOU: Origem do endereço"); };
    const result = await openAiServiceOrder({ enabled: true, provider: provider(), ledger: new MemoryIxcWriteOperationsRepository(), open, correlationId: "c" }, INPUT);
    assert.equal(result.status, "unknown", "resultado incerto não vira OS nem libera nova tentativa");
    assert.equal("orderId" in result, false);
  } finally {
    if (before === undefined) delete process.env.FEATURE_IXC_WRITE; else process.env.FEATURE_IXC_WRITE = before;
  }
});

test("o que o cliente lê: OS aberta com número, OS já existente, ou pedido registrado", () => {
  const tarde = new Date("2026-11-18T17:00:00Z"); // quarta, 14h em Brasília
  assert.equal(requestFooter("P1", "tecnico", tarde, { id: "301041" }), "Abri a ordem de serviço nº 301041 (protocolo P1) para a equipe de suporte técnico, que entra em contato ainda hoje, por aqui.");
  assert.match(requestFooter("P1", "tecnico", tarde, { id: "555", existing: true }), /Você já tem uma ordem de serviço aberta, nº 555/);
  assert.match(requestFooter("P1", "comercial", tarde), /Seu pedido ficou registrado no protocolo P1, e a equipe de comercial dá continuidade/);
});

test("classificador e copiloto só no ChatGPT quando há OPENAI_API_KEY", () => {
  const openai = llmConfigFromEnv({ FEATURE_LLM_INTENT: "true", OPENAI_API_KEY: "sk-x", GROQ_API_KEY: "gsk_y" });
  assert.deepEqual(openai, { apiKey: "sk-x", model: "gpt-5.4-mini", baseUrl: "https://api.openai.com/v1" });
  assert.equal(copilotLlmConfigFromEnv({ FEATURE_COPILOT_LLM: "true", OPENAI_API_KEY: "sk-x" }).baseUrl, "https://api.openai.com/v1");
  assert.equal(llmConfigFromEnv({ FEATURE_LLM_INTENT: "true" }), undefined, "sem chave não chama nada");
  // A família gpt-5 recusa temperature.
  assert.deepEqual(completionLimits("gpt-5.4-mini", 60, 0), { max_completion_tokens: 600, reasoning_effort: "none" });
  assert.deepEqual(completionLimits("gpt-4.1-mini", 60, 0), { temperature: 0, max_tokens: 60 });
});

/* ---------------- lições do SeeNet: lista incompleta, OS antiga de outro assunto, releitura ---------------- */

async function withWrite(fn) {
  const before = process.env.FEATURE_IXC_WRITE;
  process.env.FEATURE_IXC_WRITE = "true";
  try { return await fn(); } finally { if (before === undefined) delete process.env.FEATURE_IXC_WRITE; else process.env.FEATURE_IXC_WRITE = before; }
}
const opener = (sent) => async (order) => { sent.push(order); return { raw: { type: "success", message: "Registro inserido com sucesso!", id: "301399" } }; };

test("lista de contratos incompleta: não abre (o ativo pode estar fora da página)", async () => withWrite(async () => {
  const sent = [];
  const result = await openAiServiceOrder({ enabled: true, provider: provider({ activeComplete: false }), ledger: new MemoryIxcWriteOperationsRepository(), open: opener(sent), correlationId: "c" }, INPUT);
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /lista incompleta/);
  assert.equal(sent.length, 0);
}));

test("dois contratos ativos: não escolhe por palpite", async () => withWrite(async () => {
  const sent = [];
  const contracts = [{ id: "36058", status: "A" }, { id: "48901", status: "A" }];
  const result = await openAiServiceOrder({ enabled: true, provider: provider({ contracts }), ledger: new MemoryIxcWriteOperationsRepository(), open: opener(sent), correlationId: "c" }, INPUT);
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /2 ativos/);
  assert.equal(sent.length, 0);
}));

test("vários logins no contrato: usa o único online; sem um claro, não abre o assunto que exige login", async () => withWrite(async () => {
  const sent = [];
  const umOnline = [{ id: "41895", online: true }, { id: "39938", online: false }];
  const ok = await openAiServiceOrder({ enabled: true, provider: provider({ logins: umOnline }), ledger: new MemoryIxcWriteOperationsRepository(), open: opener(sent), correlationId: "c" }, INPUT);
  assert.equal(ok.status, "success");
  assert.equal(sent[0].loginId, "41895");
  const ambiguos = [{ id: "41895", online: true }, { id: "42926", online: true }];
  const blocked = await openAiServiceOrder({ enabled: true, provider: provider({ logins: ambiguos }), ledger: new MemoryIxcWriteOperationsRepository(), open: opener(sent), correlationId: "c" }, { ...INPUT, ticketId: "t-amb" });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.detail, /Login do contrato/);
}));

test("OS antiga de outro assunto não bloqueia; OS técnica aberta sim", async () => withWrite(async () => {
  const sent = [];
  const antigas = [{ id: "209169", status: "A", subjectId: "90" }, { id: "188248", status: "A", subjectId: "33" }];
  const abre = await openAiServiceOrder({ enabled: true, provider: provider({ openOrders: antigas }), ledger: new MemoryIxcWriteOperationsRepository(), open: opener(sent), correlationId: "c" }, INPUT);
  assert.equal(abre.status, "success", "cobrança/retirada antigas não são o chamado deste problema");
  const tecnica = [{ id: "300001", status: "AG", subjectId: "118" }];
  const ja = await openAiServiceOrder({ enabled: true, provider: provider({ openOrders: tecnica }), ledger: new MemoryIxcWriteOperationsRepository(), open: opener(sent), correlationId: "c" }, { ...INPUT, ticketId: "t2" });
  assert.deepEqual([ja.status, ja.orderId], ["existing", "300001"]);
}));

test("sem releitura confirmada, não diz ao cliente que abriu", async () => withWrite(async () => {
  const sent = [];
  const result = await openAiServiceOrder({ enabled: true, provider: provider({ readBack: false }), ledger: new MemoryIxcWriteOperationsRepository(), open: opener(sent), correlationId: "c" }, INPUT);
  assert.equal(sent.length, 1, "a escrita aconteceu");
  assert.equal(result.status, "unknown");
  assert.match(result.detail, /não foi confirmada na releitura/);
}));
