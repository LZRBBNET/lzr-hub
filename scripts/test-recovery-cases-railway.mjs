// Separate Railway-only runner. The original loopback gate remains unchanged.
// A reviewed manifest and separately provisioned DB marker are mandatory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DbRecoveryCasesRepository } from '../lib/platform/recovery-cases-repository.ts';
import { mutateRecoveryCase } from '../lib/platform/recovery-cases-service.ts';
import { validateRailwayRecoveryTarget, isPrivateTestAddress, assertRailwayDatabaseReady, assertNoAmbientPostgresEnvironment, RailwayGateRefusal } from './railway-recovery-gate-target.mjs';

export async function runRailwayRecoveryGate(env = process.env) {
  // pg also reads actual process.env, even when this function receives an injected env.
  assertNoAmbientPostgresEnvironment(process.env);
  const target = validateRailwayRecoveryTarget(env);
  const addresses = await lookup(target.databaseHost, { all: true });
  if (!addresses.length || addresses.some(row => !isPrivateTestAddress(row.address))) throw new RailwayGateRefusal('NOT RUN: test database DNS must resolve only to private Railway addresses.');
  // Pin the checked IP: do not resolve a second time or inherit PG* connection options.
  const address = addresses[0].address;
  const pool = new Pool({ host: address, port: target.databasePort, database: target.databaseName, user: target.databaseUser,
    password: target.password, options: '-c search_path=public', ssl: false, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 10000,
    query_timeout: 15000, application_name: 'lzr-recovery-railway-disposable-test' });
  let guard;
  try {
    guard = await pool.connect();
    const lock = await guard.query("select pg_try_advisory_lock(hashtext('lzr-recovery-disposable-gate')) as locked");
    if (lock.rows[0]?.locked !== true) throw new RailwayGateRefusal('NOT RUN: another gate runner holds this database.');
    await assertRailwayDatabaseReady(guard, target, address);
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    console.log('PASS: exact repository migration chain applied to approved empty disposable Railway database.');
    const repo = new DbRecoveryCasesRepository(db), scope = `test-${randomUUID()}`;
    const actor = { id: 'test-operator', role: 'Cobrança' };
    const source = { getCustomerRecord: async id => ({ id }), getInvoiceForCustomer: async (customerId, id) => ({ customerId, id, status: 'A' }) };
    const run = (input, repository = repo, selectedScope = scope) => mutateRecoveryCase(repository, selectedScope, actor, source, input);
    const open = (customerId, key) => ({ action: 'open', customerId, reason: 'debt', idempotencyKey: key });
    const command = (item, action, fields = {}) => ({ action, caseId: item.id, version: item.version, idempotencyKey: randomUUID(), ...fields });
    const race = await Promise.allSettled([run(open('101', 'open-first-race')), run(open('101', 'open-second-race'))]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(race.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
    const first = race.find(r => r.status === 'fulfilled').value.item;
    assert.equal((await repo.history(scope, first.id, 100)).length, 1);
    const shared = open('102', 'same-key-concurrent');
    const twins = await Promise.all([run(shared), run(shared)]);
    assert.equal(twins[0].item.id, twins[1].item.id);
    assert.equal((await repo.history(scope, twins[0].item.id, 100)).length, 1);
    const competing = await Promise.allSettled([run(command(first, 'claim')), run(command(first, 'note', { text: 'Concurrent operator note' }))]);
    assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
    let current = await repo.get(scope, first.id);
    assert.equal(current.version, 2); assert.equal((await repo.history(scope, first.id, 100)).length, 2);
    console.log('PASS: real concurrent active uniqueness, same-key replay and version CAS.');

    // Force a genuine FK failure on event INSERT after the case UPDATE, not a JS-only mock failure.
    const failing = new DbRecoveryCasesRepository(db);
    failing.transaction = fn => repo.transaction(tx => {
      const append = tx.append.bind(tx);
      tx.append = event => append({ ...event, scopeId: 'wrong-test-scope' });
      return fn(tx);
    });
    await assert.rejects(() => run(command(current, 'note', { text: 'Must roll back' }), failing));
    assert.equal((await repo.get(scope, first.id)).version, 2);
    assert.equal((await repo.history(scope, first.id, 100)).length, 2);
    assert.equal(await repo.get('other-test-scope', first.id), undefined);
    assert.deepEqual(await repo.history('other-test-scope', first.id, 100), []);
    await run(open('101', 'other-scope-open'), repo, 'other-test-scope');
    const closed = await run(command(current, 'close', { reason: 'Manual test closure, not receipt' }));
    const later = await run(open('101', 'new-active-after-close'));
    await assert.rejects(() => run(command(closed.item, 'reopen')), error => error.status === 409);
    assert.equal((await repo.get(scope, closed.item.id)).status, 'closed');
    await run(command(later.item, 'close', { reason: 'Manual closure' }));
    const reopened = await run(command(closed.item, 'reopen'));
    assert.equal(reopened.item.status, 'open'); assert.equal(reopened.item.closedAt, null);
    console.log('PASS: actual FK rollback, scoped reads and close/reopen uniqueness.');

    // Optional presentation SELECT errors must happen outside the mutation transaction.
    const presentationFailure = new DbRecoveryCasesRepository(db);
    let presentationReads = 0, committedVersionAtPresentation = null;
    presentationFailure.ownerName = async () => {
      presentationReads += 1;
      committedVersionAtPresentation = (await repo.get(scope, first.id))?.version;
      await pool.query('select * from deliberately_missing_recovery_test_table'); return null;
    };
    current = await repo.get(scope, first.id);
    const claimRequest = command(current, 'claim');
    const claimed = await run(claimRequest, presentationFailure);
    assert.equal(claimed.item.ownerId, actor.id); assert.equal(claimed.item.ownerName, null);
    assert.equal(presentationReads, 1);
    assert.equal(committedVersionAtPresentation, current.version + 1);
    assert.equal((await repo.get(scope, first.id)).version, current.version + 1);
    assert.equal((await repo.eventByKey(scope, claimRequest.idempotencyKey)).type, 'claimed');
    console.log('PASS: failed optional presentation read cannot roll back a reported successful mutation.');
    console.log('Database intentionally retained for inspection; dispose of this test database separately. No IXC or messaging connection was used.');
  } finally { if (guard) guard.release(true); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRailwayRecoveryGate().catch(error => {
    // Never print connection strings, passwords or arbitrary driver error details.
    console.error(error instanceof RailwayGateRefusal ? error.message : 'Railway gate failed. No success or cleanup assumed; inspect the isolated test database before retrying.');
    process.exitCode = 1;
  });
}
