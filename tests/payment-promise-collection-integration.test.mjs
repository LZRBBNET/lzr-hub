import test from "node:test";
import assert from "node:assert/strict";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { MemoryPaymentPromiseRepository, reconcilePaymentPromises } from "../lib/platform/payment-promise-service.ts";
import { loadFreshDispatchInvoices } from "../lib/platform/collection-dispatch-source.ts";
import { MemoryCollectionDispatchRepository, resolveTodayCandidates, runTodayDispatch } from "../lib/platform/collection-dispatch-service.ts";

const NOW = new Date("2026-11-05T15:00:00Z");
const rule = { id: "synthetic-rule", name: "Régua fictícia", status: "draft", version: 1, authorId: "synthetic", updatedAt: NOW.toISOString(),
  steps: [{ id: "synthetic-step", offsetDays: 0, channel: "WhatsApp", templateId: "synthetic-template", attempts: 1, active: true }] };
const row = (status = "A", extra = {}) => ({ id: "901", id_cliente: "10", status, data_vencimento: "2026-11-05", valor: "50", ...extra });

function fixture() {
  const state = { status: "A", mode: "valid" };
  const calls = [];
  const provider = new IxcReadonlyProvider({ baseUrl: "https://ixc.invalid", token: "synthetic", allowedCustomerIds: ["10"], retryLimit: 0, rateLimitPerMinute: 1000,
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path: new URL(url).pathname, body, command: new Headers(init.headers).get("ixcsoft") });
      if (url.endsWith("/cliente")) return Response.json({ registros: [{ id: "10", razao: "Cliente fictício", ativo: "S" }], total: 1 });
      if (url.endsWith("/fn_areceber")) {
        if (state.mode === "unavailable") return new Response("synthetic outage", { status: 503 });
        if (state.mode === "missing") return Response.json({ registros: [], total: 0 });
        if (state.mode === "wrong-customer") return Response.json({ registros: [row("R", { id_cliente: "20" })], total: 1 });
        if (state.mode === "partial") return Response.json({ registros: [row("R")], total: 2 });
        if (body.qtype === "fn_areceber.id_cliente" && state.status === "R") return Response.json({ registros: [], total: 0 });
        return Response.json({ registros: [row(state.status)], total: 1 });
      }
      return Response.json({ registros: [], total: 0 });
    } });
  return { provider, state, calls };
}

async function pending() {
  const repository = new MemoryPaymentPromiseRepository();
  const promise = await repository.create({ customerId: "10", invoiceId: "901", promisedFor: "2026-11-05", registeredBy: "operator@example.invalid", correlationId: "synthetic" });
  return { repository, promise };
}

test("pagamento confirmado depois do snapshot aberto cumpre promessa e sai antes do próximo lembrete", async () => {
  const { provider, state, calls } = fixture();
  const { repository, promise } = await pending();
  const before = await provider.getSnapshot("10", "synthetic-open");
  assert.equal(resolveTodayCandidates(rule, before.invoices, NOW).length, 1);
  state.status = "R";
  // Demonstrate the stale cache that the next collection round must bypass.
  const cached = await provider.getSnapshot("10", "synthetic-cached");
  assert.equal(cached.cache, "hit");
  assert.equal(cached.invoices[0].status, "A");
  const review = await reconcilePaymentPromises(repository, provider, "synthetic-review", NOW);
  assert.deepEqual(review.fulfilled, [promise.id]);
  assert.equal(repository.rows[0].status, "fulfilled");
  const current = await loadFreshDispatchInvoices(provider, ["10"]);
  assert.deepEqual(current, [], "consulta fresca só de abertas não devolve a fatura já recebida");
  const ledger = new MemoryCollectionDispatchRepository();
  const dispatch = await runTodayDispatch(rule, current, ledger, NOW, "synthetic-dispatch");
  assert.equal(dispatch.candidates, 0);
  assert.equal(dispatch.recorded, 0);
  assert.equal(dispatch.enqueued, 0);
  assert.equal(ledger.rows.length, 0);
  assert.ok(calls.every((call) => call.command === "listar"));
});

for (const mode of ["missing", "unavailable", "wrong-customer", "partial"]) {
  test(`evidência ${mode} não confirma pagamento e recuperação posterior exige leitura nova`, async () => {
    const { provider, state } = fixture();
    const { repository, promise } = await pending();
    state.mode = mode;
    const result = await reconcilePaymentPromises(repository, provider, "synthetic-inconclusive", NOW);
    assert.deepEqual(result.fulfilled, []);
    assert.deepEqual(result.broken, []);
    assert.deepEqual(result.unverified, [promise.id]);
    assert.equal(repository.rows[0].status, "pending");
    state.mode = "valid";
    state.status = "R";
    assert.deepEqual((await reconcilePaymentPromises(repository, provider, "synthetic-recovered", NOW)).fulfilled, [promise.id]);
    assert.equal(resolveTodayCandidates(rule, await loadFreshDispatchInvoices(provider, ["10"]), NOW).length, 0);
  });
}

test("carregamento da régua consulta só faturas e rejeita fatura de outro cliente", async () => {
  const calls = [];
  await assert.rejects(loadFreshDispatchInvoices({ async getOpenInvoicesForDispatch(id, correlationId) {
    calls.push({ id, correlationId });
    return [{ id: "901", customerId: "20", status: "A", dueAt: "2026-11-05" }];
  } }, ["10"]), /COLLECTION_INVOICE_SCOPE_MISMATCH/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "10");
  assert.equal(typeof calls[0].correlationId, "string");
});

test("falha fresca não reutiliza dívida antiga do cache para cobrar", async () => {
  const { provider, state } = fixture();
  assert.equal((await provider.getSnapshot("10", "synthetic-old")).invoices[0].status, "A");
  state.mode = "unavailable";
  await assert.rejects(loadFreshDispatchInvoices(provider, ["10"]), /IXC_HTTP_503/);
});
