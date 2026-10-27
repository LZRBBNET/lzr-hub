import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { markerBootstrapTarget, provisionDisposableMarker } from '../scripts/bootstrap-recovery-railway-marker.mjs';
import { PROJECT_ID, PROTECTED_ID_TEST_SENTINEL, RailwayGateRefusal } from '../scripts/railway-recovery-gate-target.mjs';

const now = new Date('2026-10-27T21:00:00Z');
const manifest = { version: 1, projectId: PROJECT_ID, environmentId: '10000000-0000-0000-0000-000000000001', environmentName: 'lzr-qa-fixture',
  runnerServiceId: '10000000-0000-0000-0000-000000000002', databaseServiceId: '10000000-0000-0000-0000-000000000003', databaseVolumeId: '10000000-0000-0000-0000-000000000004',
  databaseHost: 'lzr-qa-db-fixture.railway.internal', databasePort: 5432, databaseName: 'lzr_recovery_test_1234567890abcdef12345678', databaseUser: 'postgres',
  sourceCommit: 'a'.repeat(40), branch: 'test/recovery-gate', nonce: '1234567890abcdef12345678', approvedAt: '2026-10-27T20:59:00Z', expiresAt: '2026-10-28T20:59:00Z',
  maxAdditionalUsd: 5, approvalReference: 'approved-synthetic-fixture' };
function environment() { return { RECOVERY_CASE_RAILWAY_TARGET_JSON: JSON.stringify(manifest), RAILWAY_PROJECT_ID: manifest.projectId,
  RAILWAY_ENVIRONMENT_ID: manifest.environmentId, RAILWAY_ENVIRONMENT_NAME: manifest.environmentName, RAILWAY_SERVICE_ID: manifest.runnerServiceId,
  RAILWAY_GIT_COMMIT_SHA: manifest.sourceCommit, RAILWAY_GIT_BRANCH: manifest.branch, RAILWAY_GIT_REPO_OWNER: 'LZRBBNET', RAILWAY_GIT_REPO_NAME: 'lzr-hub',
  RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL: `postgres://postgres:synthetic-fixture@${manifest.databaseHost}/${manifest.databaseName}`,
  RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION: `${manifest.environmentId}:${manifest.databaseServiceId}:${manifest.nonce}`,
  RECOVERY_CASE_RAILWAY_ALLOW_MARKER_BOOTSTRAP: `verified-empty:${manifest.environmentId}:${manifest.databaseServiceId}:${manifest.databaseVolumeId}:${manifest.nonce}` }; }
const target = () => markerBootstrapTarget(environment(), now);
function fakeClient(change = {}) {
  const t = target(), calls = [];
  const identity = { database: t.databaseName, username: t.databaseUser, address: '10.0.0.8', port: 5432, marker: null, ...change.identity };
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.includes('current_database() as database')) return { rows: [identity] };
    if (sql.includes('from pg_class')) return { rowCount: change.nonempty ? 1 : 0 };
    if (sql.startsWith('COMMENT ON DATABASE')) return { rowCount: 0 };
    return { rows: [{ marker: change.unconfirmed ? null : t.marker }] };
  } };
}
test('marker bootstrap requires separate acknowledgement, actual runtime identity and existing fail-closed gate guards', () => {
  assert.equal(target().databaseName, manifest.databaseName);
  for (const extra of [{ RECOVERY_CASE_RAILWAY_ALLOW_MARKER_BOOTSTRAP: '' }, { RAILWAY_ENVIRONMENT_ID: PROTECTED_ID_TEST_SENTINEL }, { DATABASE_URL: 'inherited' }, { PGOPTIONS: 'inherited' }])
    assert.throws(() => markerBootstrapTarget({ ...environment(), ...extra }, now), RailwayGateRefusal);
});
test('marker bootstrap writes only one comment on verified empty unmarked database and confirms it', async () => {
  const client = fakeClient(); await provisionDisposableMarker(client, target(), '10.0.0.8', now);
  assert.equal(client.calls.filter(sql => sql.startsWith('COMMENT ON DATABASE')).length, 1);
  assert.equal(client.calls.length, 4);
  assert.ok(client.calls.every(sql => /^select |^COMMENT ON DATABASE/.test(sql)));
});
test('marker bootstrap refuses pre-existing marker, identity mismatch, public IP and nonempty database without writes', async () => {
  for (const change of [{ identity: { marker: target().marker } }, { identity: { marker: 'existing unrelated comment' } }, { identity: { database: 'postgres' } },
    { identity: { username: 'other' } }, { identity: { address: '10.0.0.9' } }, { identity: { address: '8.8.8.8' } }, { identity: { port: 6432 } }, { nonempty: true }]) {
    const client = fakeClient(change); await assert.rejects(() => provisionDisposableMarker(client, target(), '10.0.0.8', now), RailwayGateRefusal);
    assert.equal(client.calls.some(sql => sql.startsWith('COMMENT')), false);
  }
});
test('marker bootstrap checks expiry and SQL literal alphabets before writing', async () => {
  for (const changed of [{ expiresAt: now.toISOString() }, { databaseName: 'test"; drop database postgres;--' }, { marker: "test'; drop database postgres;--" }]) {
    const t = { ...target(), ...changed }, client = fakeClient({ identity: { database: t.databaseName } });
    await assert.rejects(() => provisionDisposableMarker(client, t, '10.0.0.8', now), RailwayGateRefusal);
    assert.equal(client.calls.some(sql => sql.startsWith('COMMENT')), false);
  }
});
test('marker bootstrap refuses unconfirmed write, and executable holds same transaction lock without migrating or resetting', async () => {
  const client = fakeClient({ unconfirmed: true });
  await assert.rejects(() => provisionDisposableMarker(client, target(), '10.0.0.8', now), RailwayGateRefusal);
  const source = await readFile(new URL('../scripts/bootstrap-recovery-railway-marker.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("await client.query('begin')")); assert.ok(source.includes('pg_try_advisory_xact_lock'));
  assert.ok(source.includes("await client.query('rollback')")); assert.ok(source.includes("await client.query('commit')"));
  assert.doesNotMatch(source, /await migrate\(|drop database|delete from|truncate /i);
  assert.ok(source.includes('assertNoAmbientPostgresEnvironment(process.env)'));
  assert.ok(source.includes("options: '-c search_path=public'"));
});
