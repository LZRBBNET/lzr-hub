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
      provider: { getServiceDiagnosis: async () => ({ logins: [], contracts, openServiceOrders: [] }), getTrustUnlockFacts: async () => facts },
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
