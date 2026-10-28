// Synthetic operator flow; real helpers/handlers with memory persistence, not live DB/UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVerifiedPaymentPromise, MemoryPaymentPromiseRepository } from '../lib/platform/payment-promise-service.ts';
import { MemoryRecoveryCasesRepository } from '../lib/platform/recovery-cases-repository.ts';
import { createRecoveryCasesHandlers } from '../lib/platform/recovery-cases-service.ts';

const now = new Date('2026-10-28T00:00:00Z');
const scope = 'synthetic-promise-link';
const actor = { id: 'synthetic-operator', role: 'Cobrança' };
function context() {
  const repository = new MemoryRecoveryCasesRepository(), calls = [];
  const source = {
    getCustomerRecord: async id => ({ id }),
    getInvoiceForCustomer: async (customerId, id) => { calls.push([customerId, id]); return { customerId, id, status: 'A' }; },
    getSnapshot: async () => assert.fail('A bounded snapshot is not the authority for this exact link'),
  };
  let activeSource = source, activeActor = actor;
  const handlers = createRecoveryCasesHandlers({ authorize: async () => ({ allowed: true, user: activeActor }), getRepository: async () => repository,
    getSource: () => activeSource, getScope: () => scope, now: () => now });
  const post = body => handlers.POST(new Request('http://fixture.invalid/api/billing/recovery/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const open = async () => {
    const response = await post({ action: 'open', customerId: '910001', reason: 'debt', idempotencyKey: 'synthetic-open-one' });
    assert.equal(response.status, 201); return (await response.json()).item;
  };
  const link = (item, promiseId) => post({ action: 'link_promise', caseId: item.id, version: item.version, promiseId, idempotencyKey: 'synthetic-link-one' });
  return { repository, source, calls, post, open, link, setSource: value => { activeSource = value; }, setActor: value => { activeActor = value; } };
}

test('visible HUB code exists in pending list and customer history with a same-customer instruction', async () => {
  const billing = await readFile(new URL('../components/modules/billing.tsx', import.meta.url), 'utf8');
  const recovery = await readFile(new URL('../components/modules/recovery.tsx', import.meta.url), 'utf8');
  const cases = await readFile(new URL('../components/modules/recovery-cases.tsx', import.meta.url), 'utf8');
  assert.match(billing, /Código da promessa no HUB: <code className="break">\{p\.id\}<\/code>/);
  assert.match(recovery, /Código da promessa no HUB: <code className="break">\{promise\.id\}<\/code>/);
  assert.match(cases, /Copie o código exibido em Promessas pendentes ou no histórico de promessas do cliente em Recuperação/);
  assert.match(cases, /O servidor confirma o mesmo cliente e a fatura/);
});

test('new promise code links through actual case handler and exact invoice lookup, never first20 snapshot', async () => {
  const ctx = context(), promises = new MemoryPaymentPromiseRepository();
  const row = await createVerifiedPaymentPromise(async () => promises, ctx.source,
    { customerId: '910001', invoiceId: '940021', promisedFor: '2026-10-29', registeredBy: 'operator@fixture.invalid', correlationId: 'synthetic' }, now);
  ctx.repository.promises.set(row.id, row);
  const item = await ctx.open(), response = await ctx.link(item, row.id);
  assert.equal(response.status, 200); const result = await response.json();
  assert.deepEqual(result.item.promiseIds, [row.id]); assert.equal(result.item.version, 2);
  assert.deepEqual(ctx.calls, [['910001', '940021'], ['910001', '940021']]);
  assert.equal(ctx.repository.events.length, 2); assert.equal(ctx.repository.events.at(-1).evidence.receiptConfirmed, false);
  assert.equal(row.status, 'pending');
});

for (const kind of ['missing-promise', 'other-customer', 'source-unavailable', 'invoice-not-found', 'wrong-invoice-client', 'lookup-throws', 'case-not-found', 'readonly']) {
  test(`copied promise code ${kind}: backend refuses without event or version change`, async () => {
    const ctx = context(), item = await ctx.open();
    const promise = { id: 'synthetic-promise', customerId: '910001', invoiceId: '940021', status: 'pending' };
    ctx.repository.promises.set(promise.id, promise);
    let expected = 503;
    if (kind === 'missing-promise') { ctx.repository.promises.clear(); expected = 409; }
    if (kind === 'other-customer') { promise.customerId = '910002'; expected = 409; }
    if (kind === 'source-unavailable') ctx.setSource(undefined);
    if (kind === 'invoice-not-found') ctx.setSource({ ...ctx.source, getInvoiceForCustomer: async () => null });
    if (kind === 'wrong-invoice-client') ctx.setSource({ ...ctx.source, getInvoiceForCustomer: async () => ({ id: '940021', customerId: '910002', status: 'R' }) });
    if (kind === 'lookup-throws') ctx.setSource({ ...ctx.source, getInvoiceForCustomer: async () => { throw new Error('synthetic upstream failure'); } });
    if (kind === 'readonly') { ctx.setActor({ id: 'synthetic-reader', role: 'Somente leitura' }); expected = 403; }
    const response = await ctx.link(kind === 'case-not-found' ? { ...item, id: 'synthetic-missing-case' } : item, promise.id);
    if (kind === 'case-not-found') expected = 404;
    assert.equal(response.status, expected); const payload = await response.json();
    assert.equal('item' in payload, false); assert.equal('replay' in payload, false);
    assert.equal(ctx.repository.events.length, 1);
    const unchanged = await ctx.repository.get(scope, item.id);
    assert.equal(unchanged.version, 1); assert.deepEqual(unchanged.promiseIds, []);
  });
}
