import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectSyntheticInitialization, STATUS_TABLES_SQL, STATUS_RESERVATION_SQL, STATUS_COMPLETION_SQL, STATUS_JOURNAL_SQL } from '../lib/platform/synthetic-initialization-status.ts';
import { IDENTITY_SQL } from '../lib/platform/synthetic-initialization.ts';
const manifest=JSON.parse(readFileSync(new URL('../lib/platform/synthetic-schema-manifest.json',import.meta.url)));
const digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
const attempt='synthetic-init-status-review',at='2026-11-05T15:00:00.000Z';
function fixture(change=()=>{}) {
  const responses=new Map([
    [IDENTITY_SQL,[{database:'lzr_synthetic_demo',owner:'lzr_synthetic_demo',oid:'12345',peers:0}]],
    [STATUS_TABLES_SQL,['synthetic_init_reservation','synthetic_init_completion','__drizzle_migrations'].map(relname=>({relname,relkind:'r'}))],
    [STATUS_RESERVATION_SQL,[{attempt,manifest:digest,created_at:at}]],
    [STATUS_COMPLETION_SQL,[{attempt,manifest:digest,completed_at:at}]],
    [STATUS_JOURNAL_SQL,manifest.map(m=>({hash:m.sha256,created_at:String(m.when)}))],
  ]);change(responses);const calls=[];let destroyed=0;
  return {calls,get destroyed(){return destroyed;},async query(sql){calls.push(sql);assert.ok(sql.startsWith('SELECT ')||sql.startsWith('SET LOCAL ')||['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT','ROLLBACK'].includes(sql));return{rows:responses.get(sql)??[]};},async destroy(){destroyed++;}};
}
test('status não transforma marcadores/catálogos inconsistentes em conclusão',async()=>{
  const good=fixture();const result=await inspectSyntheticInitialization(good,{databaseOid:'12345',attempt});
  assert.equal(result.state,'completion-observed');assert.equal(result.targetHostMatches,undefined,'helper does not attest host configuration');
  assert.equal(good.destroyed,1);
  for(const change of [
    m=>m.get(STATUS_TABLES_SQL)[0].relkind='v',
    m=>m.get(STATUS_TABLES_SQL).push({...m.get(STATUS_TABLES_SQL)[0]}),
    m=>m.set(STATUS_TABLES_SQL,m.get(STATUS_TABLES_SQL).slice(1)),
    m=>m.get(STATUS_COMPLETION_SQL)[0].attempt='synthetic-init-other-review',
    m=>m.get(STATUS_COMPLETION_SQL)[0].manifest='wrong',
    m=>m.get(STATUS_COMPLETION_SQL)[0].completed_at='2026-11-06T00:00:00Z',
    m=>m.get(STATUS_RESERVATION_SQL)[0].created_at='invalid',
    m=>m.get(STATUS_COMPLETION_SQL).push({...m.get(STATUS_COMPLETION_SQL)[0]}),
    m=>m.get(STATUS_JOURNAL_SQL).pop(),
    m=>m.get(STATUS_JOURNAL_SQL).reverse(),
    m=>m.get(IDENTITY_SQL)[0].owner='other',
  ]) {
    const client=fixture(change);
    await assert.rejects(inspectSyntheticInitialization(client,{databaseOid:'12345',attempt}),/^Error: SYNTHETIC_STATUS_UNKNOWN$/);
    assert.equal(client.destroyed,1);assert.equal(client.calls.at(-1),'ROLLBACK');
  }
});
