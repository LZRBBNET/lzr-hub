import test from "node:test";
import assert from "node:assert/strict";
import { trustUnlockDecision, previousMonthStart } from "../lib/platform/trust-unlock-shared.ts";
import { aiTrustUnlock, TRUST_UNLOCK_OPERATION } from "../lib/platform/ai-trust-unlock.ts";
import { MemoryIxcWriteOperationsRepository } from "../lib/platform/ixc-write-service.ts";

/** Regra da BBNET (18/11/2026) para a IA liberar a internet em confiança. */

const QUARTA = new Date("2026-11-18T13:00:00Z");
const SABADO = new Date("2026-11-21T13:00:00Z");
const FERIADO = new Date("2026-11-20T13:00:00Z"); // Consciência Negra, sexta
const base = { internetStatus: "CA", trustUnlockActive: false, lastUnlockAt: null, paidAfterUnlock: [] };

test("quem não usou no mês passado nem neste é liberado", () => {
  assert.equal(previousMonthStart(QUARTA), "2026-10-01");
  assert.deepEqual(trustUnlockDecision(base, QUARTA), { allowed: true, reason: "never_used_recently" });
  assert.deepEqual(trustUnlockDecision({ ...base, lastUnlockAt: "2026-09-10" }, QUARTA), { allowed: true, reason: "never_used_recently" });
});

test("usou no mês passado: só libera se aquela vez foi paga em dia; no fim de semana e feriado, libera mesmo assim", () => {
  const emDia = { ...base, lastUnlockAt: "2026-10-12", paidAfterUnlock: [{ dueAt: "2026-10-15", paidAt: "2026-10-15" }] };
  const atrasado = { ...base, lastUnlockAt: "2026-10-12", paidAfterUnlock: [{ dueAt: "2026-10-15", paidAt: "2026-10-20" }] };
  const naoPagou = { ...base, lastUnlockAt: "2026-10-12", paidAfterUnlock: [] };
  assert.deepEqual(trustUnlockDecision(emDia, QUARTA), { allowed: true, reason: "paid_on_time" });
  assert.deepEqual(trustUnlockDecision(atrasado, QUARTA), { allowed: false, reason: "used_last_month_late" });
  assert.deepEqual(trustUnlockDecision(naoPagou, QUARTA), { allowed: false, reason: "used_last_month_late" });
  assert.deepEqual(trustUnlockDecision(atrasado, SABADO), { allowed: true, reason: "weekend_override" });
  assert.deepEqual(trustUnlockDecision(atrasado, FERIADO), { allowed: true, reason: "weekend_override" });
});

test("não bloqueado, bloqueio manual ou desbloqueio já valendo: nada a liberar", () => {
  assert.equal(trustUnlockDecision({ ...base, internetStatus: "A" }, QUARTA).reason, "not_blocked");
  assert.equal(trustUnlockDecision({ ...base, internetStatus: "CM" }, SABADO).reason, "manual_block", "nem no fim de semana");
  assert.equal(trustUnlockDecision({ ...base, trustUnlockActive: true }, QUARTA).reason, "already_active");
});

function deps({ facts = base, unlock, contracts = [{ id: "48882", status: "A", internetStatus: "CA", trustUnlockActive: false }] } = {}) {
  const ledger = new MemoryIxcWriteOperationsRepository();
  const chamadas = [];
  return {
    ledger, chamadas,
    deps: {
      enabled: true, ledger, correlationId: "c", now: () => QUARTA,
      provider: { listTrustUnlockContracts: async () => contracts, getTrustUnlockFacts: async () => ({ contractId: "48882", ...facts }) },
      unlock: unlock ?? (async (contractId) => { chamadas.push(contractId); return { raw: { type: "success" } }; }),
    },
  };
}
const ENTRADA = { customerId: "21857", ticketId: "t1", holderVerified: true, promisedDate: "sexta" };

test("libera pelo IXC com o titular confirmado, uma vez por atendimento, e registra no ledger", async () => {
  const before = process.env.FEATURE_IXC_WRITE;
  process.env.FEATURE_IXC_WRITE = "true";
  try {
    const { deps: d, ledger, chamadas } = deps();
    const r1 = await aiTrustUnlock(d, ENTRADA);
    assert.equal(r1.status, "done");
    assert.match(r1.text, /liberei sua internet em confiança/);
    assert.deepEqual(chamadas, ["48882"]);
    assert.equal(ledger.rows.find((row) => row.operation === TRUST_UNLOCK_OPERATION).status, "success");
    const r2 = await aiTrustUnlock(d, ENTRADA);
    assert.equal(r2.status, "done");
    assert.equal(chamadas.length, 1, "webhook reentregue não libera de novo");
  } finally {
    if (before === undefined) delete process.env.FEATURE_IXC_WRITE; else process.env.FEATURE_IXC_WRITE = before;
  }
});

test("sem CPF confirmado pede o CPF; regra negada explica; recusa do IXC não vira liberação", async () => {
  const before = process.env.FEATURE_IXC_WRITE;
  process.env.FEATURE_IXC_WRITE = "true";
  try {
    assert.equal((await aiTrustUnlock(deps().deps, { ...ENTRADA, holderVerified: false })).status, "needs_cpf");
    const negado = deps({ facts: { ...base, lastUnlockAt: "2026-10-12", paidAfterUnlock: [] } });
    const r = await aiTrustUnlock(negado.deps, ENTRADA);
    assert.equal(r.status, "denied");
    assert.match(r.text, /pago com atraso|paga com atraso/);
    assert.equal(negado.chamadas.length, 0);
    assert.equal(negado.ledger.rows[0].status, "blocked", "negado também fica no ledger");
    const recusado = deps({ unlock: async () => { throw new Error("IXC_RECUSOU: contrato ativo"); } });
    const rr = await aiTrustUnlock(recusado.deps, ENTRADA);
    assert.equal(rr.status, "refused");
    assert.doesNotMatch(rr.text, /liberei/);
  } finally {
    if (before === undefined) delete process.env.FEATURE_IXC_WRITE; else process.env.FEATURE_IXC_WRITE = before;
  }
});

test("flag desligada ou contrato sem bloqueio: nada é chamado no IXC", async () => {
  const off = deps();
  assert.equal((await aiTrustUnlock({ ...off.deps, enabled: false }, ENTRADA)).status, "skipped");
  const ativo = deps({ contracts: [{ id: "48882", status: "A", internetStatus: "A", trustUnlockActive: false }] });
  assert.equal((await aiTrustUnlock(ativo.deps, ENTRADA)).status, "denied");
  assert.equal(off.chamadas.length + ativo.chamadas.length, 0);
});

test("confirma identidade antes da consulta e encontra o bloqueio na sétima posição sem misturar pagamentos", async () => {
  const contracts = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), status: "A", internetStatus: "A" }));
  contracts.push({ id: "48882", status: "A", internetStatus: "CA" });
  const { deps: d, chamadas } = deps({ contracts });
  const reads = [];
  d.provider.listTrustUnlockContracts = async id => { reads.push(["contracts", id]); return contracts; };
  d.provider.getTrustUnlockFacts = async (owner, contract, _corr, allowHistory) => {
    reads.push(["facts", owner, contract, allowHistory]);
    return { ...base, contractId: contract };
  };
  const old = process.env.FEATURE_IXC_WRITE;
  process.env.FEATURE_IXC_WRITE = "true";
  try {
    assert.equal((await aiTrustUnlock(d, { ...ENTRADA, holderVerified: false })).status, "needs_cpf");
    assert.deepEqual(reads, []);
    assert.equal((await aiTrustUnlock(d, ENTRADA)).status, "done");
    assert.deepEqual(reads, [["contracts", ENTRADA.customerId], ["facts", ENTRADA.customerId, "48882", false]]);
    assert.deepEqual(chamadas, ["48882"]);
  } finally {
    if (old === undefined) delete process.env.FEATURE_IXC_WRITE; else process.env.FEATURE_IXC_WRITE = old;
  }
});
test("mais de um bloqueio, contrato divergente ou consulta incompleta nunca liberam", async () => {
  const mix = deps({contracts: [{ id: "1", status: "A", internetStatus: "CM" }, { id: "2", status: "A", internetStatus: "FA" }]});
  assert.equal((await aiTrustUnlock(mix.deps, ENTRADA)).reason, "multiple_blocked_contracts");
  const wrong = deps({facts: { ...base, contractId: "999" }});
  assert.equal((await aiTrustUnlock(wrong.deps, ENTRADA)).reason, "contract_scope_unverified");
  const partial = deps();
  partial.deps.provider.listTrustUnlockContracts = async () => { throw Error("IXC_CONTRACT_UNCONFIRMED"); };
  assert.equal((await aiTrustUnlock(partial.deps, ENTRADA)).reason, "contract_evidence_unavailable");
  assert.equal(mix.chamadas.length + wrong.chamadas.length + partial.chamadas.length, 0);
});

test("o adaptador IXC lê somente os contratos e recusa paginação parcial, outro titular e código desconhecido", async () => {
  const { IxcReadonlyProvider } = await import("../lib/integrations/ixc/readonly-provider.ts");
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), id_cliente: "10", status: "A", status_internet: i === 6 ? "CA" : "A" }));
  for (const [records, total, expected] of [
    [rows, 7, true], [rows.slice(0, 5), 7, false],
    [[...rows.slice(0, 6), { ...rows[6], id_cliente: "11" }], 7, false],
    [[...rows.slice(0, 6), { ...rows[6], status_internet: "?" }], 7, false],
  ]) {
    let reads = 0;
    const provider = new IxcReadonlyProvider({ baseUrl:"https://test.example.invalid", token:"synthetic", allowedCustomerIds:["10"], retryLimit:0,
      fetcher: async (url, init) => {
        reads++;
        assert.match(url, /\/cliente_contrato$/);
        assert.equal(new Headers(init.headers).get("ixcsoft"), "listar");
        const body=JSON.parse(init.body);
        assert.equal(body.qtype,"cliente_contrato.id_cliente");
        assert.equal(body.query,"10");
        return Response.json({ registros:records,total,page:1 });
      } });
    if (expected) assert.deepEqual((await provider.listTrustUnlockContracts("10","fixture")).at(-1), { id:"7",status:"A",internetStatus:"CA" });
    else await assert.rejects(provider.listTrustUnlockContracts("10","fixture"), /IXC_CONTRACT_UNCONFIRMED/);
    assert.equal(reads,1);
  }
});
