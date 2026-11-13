import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {stagingDemoRequirements} from '../lib/runtime/staging-demo.ts';
import {inspectionPlan,inspectOperational,report,IDENTITY_ONLY_SQL,TABLES_SQL,RESERVATION_SQL,COMPLETION_SQL,JOURNAL_SQL} from '../lib/platform/synthetic-operational-inspection.ts';
import {EMPTY_SQL,RESERVED_EMPTY_SQL} from '../lib/platform/synthetic-inspection-sql.ts';
import manifest from '../lib/platform/synthetic-schema-manifest.json' with {type:'json'};
import {runInspectionStart,superviseInspection,projectReport} from '../scripts/synthetic-inspect-start.mjs';
const time=Date.parse('2026-01-01T00:00:00Z');
function source(){return {...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_BROWSER_SETUP_ENABLED:'false',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://demo.example.invalid',SYNTHETIC_INIT_ENABLED:'false',DATABASE_URL:'postgresql://lab:invented@db.example.invalid/lab',SYNTHETIC_RO_INSPECTION_ENABLED:'true',SYNTHETIC_RO_INSPECTION_MODE:'inspect',SYNTHETIC_RO_INSPECTION_NOT_BEFORE:new Date(time).toISOString(),SYNTHETIC_RO_INSPECTION_EXPIRES_AT:new Date(time+600000).toISOString(),SYNTHETIC_RO_INSPECTION_EXPECTED_HOST:'db.example.invalid',SYNTHETIC_RO_INSPECTION_EXPECTED_DATABASE:'lab',SYNTHETIC_RO_INSPECTION_EXPECTED_USER:'lab',SYNTHETIC_RO_INSPECTION_EXPECTED_OID:'12345'};}
function fixture(kind='empty'){
 const s=source(),config=inspectionPlan(s,time),calls=[],digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 const marker={attempt:'synthetic-init-unknown-fixture',manifest:digest,stamp:'2026-01-01T00:00:00.000Z'};
 const table=(schema,name)=>({schema,name,kind:'r',rls:false});
 const rows=new Map([[IDENTITY_ONLY_SQL,[{database:'lab',owner:'lab',oid:'12345'}]],[TABLES_SQL,kind==='empty'?[]:[table('public','synthetic_init_reservation'),...(kind==='complete'?[table('public','synthetic_init_completion'),table('drizzle','__drizzle_migrations')]:[])]],[EMPTY_SQL,[{objects:0}]],[RESERVED_EMPTY_SQL,[{objects:0}]],[RESERVATION_SQL,[{...marker}]],[COMPLETION_SQL,[{...marker}]],[JOURNAL_SQL,manifest.map(m=>({hash:m.sha256,stamp:String(m.when)}))]]);
 const client={query:async sql=>{calls.push(sql);assert.match(sql,/^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL|COMMIT)/);return {rows:rows.get(sql)??[]};}};
 return {s,config,calls,rows,client};
}
test('opt-in absent/false or outside absolute window: zero inspection calls, launcher still starts',async()=>{
 for(const alteration of [s=>delete s.SYNTHETIC_RO_INSPECTION_ENABLED,s=>s.SYNTHETIC_RO_INSPECTION_ENABLED='false',s=>s.SYNTHETIC_RO_INSPECTION_EXPIRES_AT=new Date(time).toISOString()]){
  const s=source();alteration(s);let connects=0,starts=0;const outputs=[];
  await runInspectionStart(s,{artifact:async()=>{},inspect:async()=>{connects++;},start:async()=>{starts++;},emit:r=>outputs.push(r),now:()=>time+1});assert.equal(connects,0);assert.equal(starts,1);assert.equal(outputs.length,1);
 }
});
test('old flags, capability, auth, external integration and runtime injection refuse launcher before inspection',async()=>{
 for(const [key,value]of Object.entries({SYNTHETIC_INIT_ENABLED:'true',SYNTHETIC_BROWSER_SETUP_ENABLED:'true',SYNTHETIC_INIT_CAPABILITY_SHA256:'',SYNTHETIC_INIT_EXPIRES_AT:'',FEATURE_AUTH:'false',FEATURE_N8N_CHANNEL:'true',NODE_OPTIONS:'--trace-warnings',NODE_EXTRA_CA_CERTS:'fixture'})){
  const s=source();s[key]=value;let called=false;await assert.rejects(runInspectionStart(s,{artifact:async()=>{called=true;}}));assert.equal(called,false);
 }
});
test('invalid target, mode, OID, URL overrides and renewable/oversize window refused',()=>{
 for(const [key,value]of Object.entries({SYNTHETIC_RO_INSPECTION_MODE:'auto',SYNTHETIC_RO_INSPECTION_EXPECTED_HOST:'wrong.invalid',SYNTHETIC_RO_INSPECTION_EXPECTED_DATABASE:'wrong',SYNTHETIC_RO_INSPECTION_EXPECTED_USER:'wrong',SYNTHETIC_RO_INSPECTION_EXPECTED_OID:'4294967296',DATABASE_URL:'postgresql://lab:invented@db.example.invalid/lab?options=unsafe',SYNTHETIC_RO_INSPECTION_EXPIRES_AT:new Date(time+600001).toISOString()})){
  const s=source();s[key]=value;assert.throws(()=>inspectionPlan(s,time));
 }
 const s=source();delete s.SYNTHETIC_RO_INSPECTION_EXPECTED_OID;assert.throws(()=>inspectionPlan(s,time));
});
test('identification reads identity only, never promotes discovered OID or reads application markers',async()=>{
 const f=fixture();f.s.SYNTHETIC_RO_INSPECTION_MODE='identify';assert.throws(()=>inspectionPlan(f.s,time));delete f.s.SYNTHETIC_RO_INSPECTION_EXPECTED_OID;
 const result=await inspectOperational(f.client,inspectionPlan(f.s,time),()=>time);assert.deepEqual(result,report('identity-observed','12345'));assert.deepEqual(f.calls.filter(s=>s.startsWith('SELECT')),[IDENTITY_ONLY_SQL]);assert.equal(f.s.SYNTHETIC_RO_INSPECTION_EXPECTED_OID,undefined);
});
test('inspect requires pinned identity: divergence or cardinality refuses before markers',async()=>{
 for(const rows of [[{database:'wrong',owner:'lab',oid:'12345'}],[{database:'lab',owner:'lab',oid:'12346'}],[],[{database:'lab',owner:'lab',oid:'12345'},{database:'lab',owner:'lab',oid:'12345'}]]){
  const f=fixture();f.rows.set(IDENTITY_ONLY_SQL,rows);assert.equal((await inspectOperational(f.client,f.config,()=>time)).state,'unknown');assert.ok(!f.calls.includes(TABLES_SQL));
 }
});
test('snapshot states remain structural, attempt unknown and credentials/write never authorized',async()=>{
 for(const [kind,state]of [['empty','absence-observed'],['reserved','reservation-structural'],['complete','completion-structural']]){
  const f=fixture(kind);assert.deepEqual(await inspectOperational(f.client,f.config,()=>time),report(state));assert.equal(f.calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(f.calls.at(-1),'COMMIT');
 }
});
test('unknown marker/cardinality/manifest/RLS/view/journal mismatches fail closed',async()=>{
 const cases=[f=>f.rows.get(RESERVATION_SQL).push({...f.rows.get(RESERVATION_SQL)[0]}),f=>f.rows.get(RESERVATION_SQL)[0].manifest='wrong',f=>f.rows.get(COMPLETION_SQL)[0].attempt='synthetic-init-other-fixture',f=>f.rows.get(TABLES_SQL)[0].rls=true,f=>f.rows.get(TABLES_SQL)[0].kind='v',f=>f.rows.get(JOURNAL_SQL).pop(),f=>f.rows.get(RESERVATION_SQL)[0].stamp='2026-01-01',f=>f.rows.get(JOURNAL_SQL)[0].stamp=null,f=>f.rows.get(TABLES_SQL).push({schema:'other',name:'secret',kind:'r',rls:false})];
 for(const mutate of cases){const f=fixture('complete');mutate(f);assert.equal((await inspectOperational(f.client,f.config,()=>time)).state,'unknown');}
 const f=fixture();f.rows.set(EMPTY_SQL,[{objects:1}]);assert.equal((await inspectOperational(f.client,f.config,()=>time)).state,'unknown');
});
test('concurrent/repeated read-only snapshots do not consume or write any state',async()=>{
 const f=fixture('reserved');const results=await Promise.all(Array.from({length:3},()=>inspectOperational(f.client,f.config,()=>time)));assert.ok(results.every(r=>r.state==='reservation-structural'));assert.ok(f.calls.every(s=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|LOCK|COPY)/.test(s)));
});
test('expired before query and expiry during response never advance inspection',async()=>{
 const f=fixture();assert.equal((await inspectOperational(f.client,f.config,()=>f.config.expires)).state,'unknown');assert.equal(f.calls.length,0);
 let clock=time;const g=fixture();const client={query:async sql=>{const r=await g.client.query(sql);clock=g.config.expires;return r;}};
 assert.equal((await inspectOperational(client,g.config,()=>clock)).state,'unknown');assert.equal(g.calls.length,1);
});
test('raw DB exception and arbitrary report keys never escape projection',async()=>{
 const f=fixture();const r=await inspectOperational({query:async()=>{throw Error('invented-private-value');}},f.config,()=>time);assert.deepEqual(r,report('unknown'));
 for(const value of [{...report('identity-observed','12345'),secret:'invented-private-value'},report('identity-observed','oops'),{...report('unknown'),oid:'12345'},report('identity-observed','12345')])assert.deepEqual(projectReport(value,'inspect'),report('unknown'));
});
test('supervisor waits for closed child, suppresses streams and rejects duplicate IPC',async()=>{
 for(const duplicate of [false,true]){const f=fixture();let child,options;const pending=superviseInspection(f.s,f.config,{now:()=>time,spawn:(_file,args,opts)=>{assert.deepEqual(args,['--worker']);options=opts;child=new EventEmitter();child.kill=()=>{};return child;}});
 assert.deepEqual(options.stdio,['ignore','ignore','ignore','ipc']);assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.PGPASSFILE,undefined);
 let settled=false;pending.then(()=>settled=true);child.emit('message',report('absence-observed'));if(duplicate)child.emit('message',report('absence-observed'));await Promise.resolve();assert.equal(settled,false);child.emit('close',0);assert.equal((await pending).state,duplicate?'unknown':'absence-observed');}
});
test('supervisor deadline kills stalled child and reports only after cleanup close',async()=>{
 const f=fixture();let killed=false;const p=superviseInspection(f.s,{...f.config,expires:time+1005},{now:()=>time,spawn:()=>{const c=new EventEmitter();c.kill=()=>{killed=true;setImmediate(()=>c.emit('close',null));};return c;}});assert.equal((await p).state,'timeout');assert.equal(killed,true);
});
test('inspection error does not restart service; artifact/security failures do not start it',async()=>{
 const s=source();let started=0;const emitted=[];await runInspectionStart(s,{artifact:async()=>{},inspect:async()=>{throw Error('private');},start:async()=>{started++;},emit:r=>emitted.push(r),now:()=>time});assert.equal(started,1);assert.deepEqual(emitted,[report('refused')]);
 await assert.rejects(runInspectionStart(s,{artifact:async()=>{throw Error('artifact');},start:async()=>{started++;}}));assert.equal(started,1);
});
test('CLI refusal never prints environment/exception; no default script references inspection',()=>{
 const r=spawnSync(process.execPath,['--experimental-strip-types','--disable-warning=ExperimentalWarning','scripts/synthetic-inspect-start.mjs'],{env:{DATABASE_URL:'invented-private-value'},encoding:'utf8'});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'SYNTHETIC_RO_START_REFUSED');
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));assert.ok(Object.values(pkg.scripts).every(s=>!s.includes('synthetic-inspect-start')));
 const sql=readFileSync(new URL('../lib/platform/synthetic-inspection-sql.ts',import.meta.url),'utf8');assert.doesNotMatch(sql,/\bimport\s|INSERT|UPDATE|DELETE|CREATE TABLE/);
});
test('exception after spawn never releases launcher until child close',async()=>{
 const f=fixture();let child,killed=false;
 const pending=superviseInspection(f.s,f.config,{now:()=>time,spawn:()=>{child=new EventEmitter();const on=child.on;child.on=function(name,fn){if(name==='message')throw Error('fixture');return on.call(this,name,fn);};child.kill=()=>{killed=true;};return child;}});
 let done=false;pending.then(()=>done=true);await Promise.resolve();assert.equal(killed,true);assert.equal(done,false);child.emit('close',null);assert.equal((await pending).state,'unknown');
});
test('projection bounds reject excess instead of truncating marker evidence; RO connection fixed before connect',()=>{
 for(const sql of [RESERVATION_SQL,COMPLETION_SQL,JOURNAL_SQL]){assert.match(sql,/CASE WHEN length/);assert.doesNotMatch(sql,/\bleft\(/);}
 const worker=readFileSync(new URL('../scripts/synthetic-inspect-start.mjs',import.meta.url),'utf8');assert.match(worker,/default_transaction_read_only=on/);assert.ok(worker.indexOf('default_transaction_read_only=on')<worker.indexOf('await client.connect()'));assert.doesNotMatch(worker,/Pool|createSyntheticInitializer|db:migrate/);
});
test('supervisor too close to expiry does not spawn, and closed child error discards result',async()=>{
 const f=fixture();let spawned=false;assert.equal((await superviseInspection(f.s,{...f.config,expires:time+999},{now:()=>time,spawn:()=>{spawned=true;}})).state,'outside-window');assert.equal(spawned,false);
 let child;const p=superviseInspection(f.s,f.config,{now:()=>time,spawn:()=>{child=new EventEmitter();child.kill=()=>{};return child;}});child.emit('message',report('absence-observed'));child.emit('error',Error('raw-private'));child.emit('close',1);assert.equal((await p).state,'unknown');
});
test('valid expired and future windows emit outside-window with zero inspection and one launcher',async()=>{
 for(const clock of [time-1,time+600000,time+600001]){
  let inspections=0,starts=0;const outputs=[];
  await runInspectionStart(source(),{artifact:async()=>{},inspect:async()=>{inspections++;},start:async()=>{starts++;},emit:r=>outputs.push(r),now:()=>clock});
  assert.deepEqual(outputs,[report('outside-window')]);assert.equal(inspections,0);assert.equal(starts,1);
 }
});
