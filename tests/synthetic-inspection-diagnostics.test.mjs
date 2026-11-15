import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectOperational,report,unknownReport,isInspectionDiagnostic,IDENTITY_ONLY_SQL,TABLES_SQL,RESERVATION_SQL,COMPLETION_SQL,JOURNAL_SQL} from '../lib/platform/synthetic-operational-inspection.ts';
import {EMPTY_SQL,RESERVED_EMPTY_SQL} from '../lib/platform/synthetic-inspection-sql.ts';
import manifest from '../lib/platform/synthetic-schema-manifest.json' with {type:'json'};
const time=Date.parse('2026-01-01T00:00:00Z');
const canary='NEVER_EXPOSE_SQL_DATABASE_PASSWORD_OR_MARKER_789';
function fixture(kind='complete'){
 const config={mode:'inspect',host:'db.example.invalid',database:'lab',user:'lab',password:canary,oid:'12345',expires:time+600000};
 const marker={attempt:'synthetic-init-test-fixture',manifest:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),stamp:new Date(time).toISOString()};
 const table=(schema,name)=>({schema,name,kind:'r',rls:false});
 const rows=new Map([[IDENTITY_ONLY_SQL,[{database:'lab',owner:'lab',oid:'12345'}]],
  [TABLES_SQL,kind==='empty'?[]:[table('public','synthetic_init_reservation'),...(kind==='complete'?[table('public','synthetic_init_completion'),table('drizzle','__drizzle_migrations')]:[])]],
  [EMPTY_SQL,[{objects:0}]],[RESERVED_EMPTY_SQL,[{objects:0}]],
  [RESERVATION_SQL,[{...marker}]],[COMPLETION_SQL,[{...marker}]],
  [JOURNAL_SQL,manifest.map(m=>({hash:m.sha256,stamp:String(m.when)}))]]);
 const calls=[];
 const client={query:async sql=>{calls.push(sql);return {rows:rows.get(sql)??[]};}};
 return {config,rows,calls,client};
}
const phases=[['transaction','BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],['transaction','SET LOCAL search_path = pg_catalog'],['transaction',"SET LOCAL statement_timeout = '3s'"],['transaction',"SET LOCAL lock_timeout = '1s'"],['identity',IDENTITY_ONLY_SQL],['catalog',TABLES_SQL],['reservation',RESERVATION_SQL],['completion',COMPLETION_SQL],['journal',JOURNAL_SQL],['transaction','COMMIT']];
function safe(result,phase,reason){
 assert.deepEqual(result,unknownReport(phase,reason));
 assert.doesNotMatch(JSON.stringify(result),new RegExp(canary));
 for(const key of ['retryAllowed','initializationAllowed','credentialsVerified','attemptReconciled'])assert.equal(result[key],false);
}
test('closed diagnostics accept exact pairs, never arbitrary phase/reason or secret values',()=>{
 const pairs={
  'worker-start':['setup-failed'],connect:['connection-failed'],transaction:['query-failed','deadline','unexpected-shape'],
  identity:['query-failed','deadline','unexpected-shape','identity-mismatch'],catalog:['query-failed','deadline','unexpected-shape','unexpected-structure','invalid-marker-catalog','marker-without-reservation','unexpected-inventory','completion-without-journal','journal-without-completion'],
  reservation:['query-failed','deadline','unexpected-shape','marker-mismatch'],completion:['query-failed','deadline','unexpected-shape','marker-mismatch'],
  journal:['query-failed','deadline','unexpected-shape','journal-mismatch'],close:['close-failed'],ipc:['child-failed','missing-message','invalid-message'],
 };
 const reasons=[...new Set(Object.values(pairs).flat()),canary,'constructor',undefined,null,{}];
 for(const phase of [...Object.keys(pairs),canary,'constructor','__proto__',null,{}])for(const reason of reasons){
  const expected=typeof phase==='string'&&Object.hasOwn(pairs,phase)&&pairs[phase].includes(reason);
  assert.equal(isInspectionDiagnostic(phase,reason),Boolean(expected));
  if(expected)safe(unknownReport(phase,reason),phase,reason);else assert.throws(()=>unknownReport(phase,reason),/SYNTHETIC_RO_DIAGNOSTIC_INVALID/);
 }
 assert.deepEqual(report('unknown'),{state:'unknown',retryAllowed:false,initializationAllowed:false,credentialsVerified:false,attemptReconciled:false});
});
test('every query failure reports the explicit phase with four false safety flags and suppresses exception canaries',async()=>{
 for(const [phase,target]of phases){
  const f=fixture();
  const result=await inspectOperational({query:async sql=>{if(sql===target)throw Object.assign(Error(canary),{sql,password:canary,phase:'connect'});return f.client.query(sql);}},f.config,()=>time);
  safe(result,phase,'query-failed');
 }
 for(const [kind,target]of [['empty',EMPTY_SQL],['reserved',RESERVED_EMPTY_SQL]]){
  const f=fixture(kind);safe(await inspectOperational({query:async sql=>{if(sql===target)throw Error(canary);return f.client.query(sql);}},f.config,()=>time),'catalog','query-failed');
 }
});
test('deadline and malformed response are separate from backend query errors at every phase',async()=>{
 for(const [phase,target]of phases){
  const f=fixture();let now=time;
  safe(await inspectOperational({query:async sql=>{const response=await f.client.query(sql);if(sql===target)now=f.config.expires;return response;}},f.config,()=>now),phase,'deadline');
  const g=fixture();safe(await inspectOperational({query:async sql=>sql===target?{rows:canary}:g.client.query(sql)},g.config,()=>time),phase,'unexpected-shape');
 }
 const f=fixture();safe(await inspectOperational(f.client,f.config,()=>f.config.expires),'transaction','deadline');assert.equal(f.calls.length,0);
});
test('identity/catalog/marker/journal mismatches distinguish safe branch outcomes without returned values',async()=>{
 const cases=[
  ['identity','identity-mismatch',f=>f.rows.get(IDENTITY_ONLY_SQL)[0].owner=canary],
  ['catalog','invalid-marker-catalog',f=>f.rows.get(TABLES_SQL)[0].kind='v'],
  ['catalog','invalid-marker-catalog',f=>f.rows.set(TABLES_SQL,[{schema:'public',name:canary,kind:'r',rls:false}])],
  ['reservation','marker-mismatch',f=>f.rows.get(RESERVATION_SQL)[0].manifest=canary],
  ['completion','marker-mismatch',f=>f.rows.get(COMPLETION_SQL)[0].attempt=canary],
  ['journal','journal-mismatch',f=>f.rows.get(JOURNAL_SQL)[0].hash=canary],
 ];
 for(const [phase,reason,mutate]of cases){const f=fixture();mutate(f);safe(await inspectOperational(f.client,f.config,()=>time),phase,reason);}
});
test('query bytes remain pinned and success shapes do not gain diagnostics',async()=>{
 assert.equal(createHash('sha256').update(JSON.stringify([IDENTITY_ONLY_SQL,TABLES_SQL,RESERVATION_SQL,COMPLETION_SQL,JOURNAL_SQL,EMPTY_SQL,RESERVED_EMPTY_SQL])).digest('hex'),'61fa22c4fea7088ebf88793d4b036e950b1732f6c3cc54cd5732daeae6c61bf9');
 for(const [kind,state]of [['empty','absence-observed'],['reserved','reservation-structural'],['complete','completion-structural']]){
  const f=fixture(kind);assert.deepEqual(await inspectOperational(f.client,f.config,()=>time),report(state));
  assert.equal(f.calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(f.calls.at(-1),'COMMIT');
  assert.ok(f.calls.every(sql=>/^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL|COMMIT)/.test(sql)));
 }
});

test('catalog subdivisions preserve all structural refusals and suppress returned values',async()=>{
 const table=(name)=>({schema:name==='__drizzle_migrations'?'drizzle':'public',name,kind:'r',rls:false});
 const check=async(kind,mutate,reason)=>{const f=fixture(kind);mutate(f);safe(await inspectOperational(f.client,f.config,()=>time),'catalog',reason);assert.ok(!f.calls.includes('COMMIT'));};
 for(const mutate of [f=>f.rows.get(TABLES_SQL)[0].rls=true,f=>f.rows.get(TABLES_SQL)[0].kind='v',f=>f.rows.get(TABLES_SQL).push({...f.rows.get(TABLES_SQL)[0]}),f=>f.rows.get(TABLES_SQL)[0].schema=canary])await check('complete',mutate,'invalid-marker-catalog');
 for(const name of ['synthetic_init_completion','__drizzle_migrations'])await check('empty',f=>f.rows.set(TABLES_SQL,[table(name)]),'marker-without-reservation');
 for(const [kind,sql]of [['empty',EMPTY_SQL],['reserved',RESERVED_EMPTY_SQL]])for(const rows of [[],[{objects:1}],[{objects:'0'}],[{objects:canary}],[{objects:null}],[{}],[{objects:0},{objects:0}]])await check(kind,f=>f.rows.set(sql,rows),'unexpected-inventory');
 await check('reserved',f=>f.rows.get(TABLES_SQL).push(table('synthetic_init_completion')),'completion-without-journal');
 await check('reserved',f=>f.rows.get(TABLES_SQL).push(table('__drizzle_migrations')),'journal-without-completion');
});
