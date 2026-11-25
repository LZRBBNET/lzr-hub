import test from "node:test";
import assert from "node:assert/strict";
import { previewContract, validAuditId } from "../lib/platform/contract-audit-preview.ts";

const clock = () => new Date("2026-11-25T13:00:00.000Z");
function fixture({ contract = { id: "100", id_cliente: "7", status: "I" }, customer = { id: "7", telefone_celular: "", whatsapp: "79999999999", email: "privado@example.test", numero: "SN" }, remaining = [90, 89] } = {}) {
  const calls = [];
  return {
    calls, provider: {
      rateLimitRemaining: () => remaining.shift() ?? 0,
      getContractForAudit: async (...args) => { calls.push(["contract", ...args]); if (contract instanceof Error) throw contract; return contract; },
      getCustomerRecord: async (...args) => { calls.push(["customer", ...args]); if (customer instanceof Error) throw customer; return customer; },
    },
  };
}

test("conferência exata só retorna resultado cadastral, inclusive em contrato inativo", async () => {
  const { provider, calls } = fixture();
  const result = await previewContract(provider, "7", "100", "test", clock);
  assert.deepEqual(calls, [["contract", "7", "100", "test"], ["customer", "7", "test"]]);
  assert.deepEqual(result, { status: "ok", issues: [], checkedAt: "2026-11-25T13:00:00.000Z" });
});

test("vínculo incorreto não consulta cadastro de nenhum titular", async () => {
  const { provider, calls } = fixture({ contract: { id: "100", id_cliente: "8" } });
  assert.equal((await previewContract(provider, "7", "100", "test", clock)).status, "unverified");
  assert.deepEqual(calls, [["contract", "7", "100", "test"]]);
});

test("cadastro de outro titular não divulga valores nem passa na auditoria", async () => {
  const { provider } = fixture({ customer: { id: "8", razao: "OUTRO" } });
  const result = await previewContract(provider, "7", "100", "test", clock);
  assert.equal(result.status, "unverified");
  assert.equal(JSON.stringify(result).includes("OUTRO"), false);
});

test("campos omitidos ficam não verificáveis; campo explicitamente vazio é pendência", async () => {
  const base = { id: "7", telefone_celular: "79999999999", numero: "SN" };
  const missing = fixture({ customer: base });
  const empty = fixture({ customer: { ...base, email: "" } });
  assert.equal((await previewContract(missing.provider, "7", "100", "test", clock)).status, "unverified");
  assert.deepEqual((await previewContract(empty.provider, "7", "100", "test", clock)).issues, ["sem_email"]);
});

test("consulta não ultrapassa a reserva e não expõe erro interno", async () => {
  const low = fixture({ remaining: [11, 10] });
  const error = fixture({ contract: new Error("conteúdo interno") });
  assert.equal((await previewContract(low.provider, "7", "100", "test", clock)).status, "unverified");
  assert.equal(low.calls.length, 1);
  assert.equal(JSON.stringify(await previewContract(error.provider, "7", "100", "test", clock)).includes("conteúdo interno"), false);
});

test("identificador inválido não usa a integração", async () => {
  const { provider, calls } = fixture();
  for (const id of ["0", "001", "7x", "-7", "9".repeat(33), 7, null]) assert.equal(validAuditId(id), false);
  assert.equal((await previewContract(provider, "7", "0", "test", clock)).status, "unverified");
  assert.deepEqual(calls, []);
});
