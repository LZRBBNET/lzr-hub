import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {stagingDemoRequirements} from '../lib/runtime/staging-demo.ts';
import {inspectionPlan, report, unknownReport, IDENTITY_ONLY_SQL} from '../lib/platform/synthetic-operational-inspection.ts';
import {projectReport,runInspectionWorker,superviseInspection,runInspectionStart} from '../scripts/synthetic-inspect-start.mjs';
const time=Date.parse('2026-01-01T00:00:00Z');
const secret='CANARY-password-user-host-token-hash-stamp-88421';
function source(){return {...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_BROWSER_SETUP_ENABLED:'false',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://demo.example.invalid',SYNTHETIC_INIT_ENABLED:'false',DATABASE_URL:'postgresql://lab:invented@db.example.invalid/lab',SYNTHETIC_RO_INSPECTION_ENABLED:'true',SYNTHETIC_RO_INSPECTION_MODE:'identify',SYNTHETIC_RO_INSPECTION_NOT_BEFORE:new Date(time).toISOString(),SYNTHETIC_RO_INSPECTION_EXPIRES_AT:new Date(time+600000).toISOString(),SYNTHETIC_RO_INSPECTION_EXPECTED_HOST:'db.example.invalid',SYNTHETIC_RO_INSPECTION_EXPECTED_DATABASE:'lab',SYNTHETIC_RO_INSPECTION_EXPECTED_USER:'lab'};}
function safe(value){assert.doesNotMatch(JSON.stringify(value),new RegExp(secret));for(const key of ['retryAllowed','initializationAllowed','credentialsVerified','attemptReconciled'])assert.equal(value[key],false);return value;}
function fixture(fail){let ended=0,connected=0,options;class Client{constructor(o){options=o;if(fail==='construct')throw Error(secret);}on(){}async connect(){connected++;if(fail==='connect')throw Error(secret);}async query(sql){if(fail==='query')throw Error(secret);return {rows:sql===IDENTITY_ONLY_SQL?[{database:'lab',owner:'lab',oid:'12345'}]:[]};}async end(){ended++;if(fail==='close')throw Error(secret);}}
 return {deps:{loadClient:async()=>{if(fail==='import')throw Error(secret);return Client;},installEgress:()=>{if(fail==='egress')throw Error(secret);},now:()=>time},stats:()=>({ended,connected,options})};}
test('worker preparation/connect/query/close errors emit finite categories with four false and no raw canary',async()=>{
 for(const [failure,phase,reason]of [['egress','worker-start','setup-failed'],['import','worker-start','setup-failed'],['construct','worker-start','setup-failed'],['connect','connect','connection-failed'],['query','transaction','query-failed'],['close','close','close-failed']]){
  const f=fixture(failure),result=safe(await runInspectionWorker(source(),f.deps));assert.deepEqual(result,unknownReport(phase,reason));
  if(['connect','query','close'].includes(failure))assert.equal(f.stats().ended,1);
 }
});
test('worker success/close failure never returned before connection end settles; RO options precede connect',async()=>{
 for(const failClose of [false,true]){
  let finish;const f=fixture();const Base=await f.deps.loadClient();class Client extends Base{async end(){await new Promise((resolve,reject)=>{finish=()=>failClose?reject(Error(secret)):resolve();});}}
  const p=runInspectionWorker(source(),{...f.deps,loadClient:async()=>Client});let done=false;p.then(()=>done=true);
  while(!finish)await new Promise(r=>setImmediate(r));assert.equal(done,false);finish();const result=safe(await p);
  assert.deepEqual(result,failClose?unknownReport('close','close-failed'):report('identity-observed','12345'));
  const {options,connected}=f.stats();assert.equal(connected,1);assert.equal(options.ssl,false);assert.match(options.options,/default_transaction_read_only=on/);assert.match(options.options,/statement_timeout=3000/);assert.equal(options.connectionTimeoutMillis,3000);
 }
});
test('IPC projection accepts only exact unknown diagnostic pairs and never extra keys or success diagnostics',()=>{
 const valid=unknownReport('close','close-failed');assert.deepEqual(projectReport(valid,'inspect'),valid);
 for(const value of [{...valid,reason:secret},{...valid,phase:secret},{...valid,extra:secret},{...valid,reason:'connection-failed'},{...valid,reason:undefined},{...report('absence-observed'),phase:'close',reason:'close-failed'},{...valid,oid:'12345'},{...valid,retryAllowed:true},{...valid,detail:{message:secret}},null,secret]){
  assert.deepEqual(safe(projectReport(value,'inspect')),unknownReport('ipc','invalid-message'));
 }
 assert.deepEqual(projectReport(report('unknown'),'inspect'),report('unknown'));
});
test('supervisor absent/duplicate/malformed/error IPC classified only after child close',async()=>{
 for(const [kind,reason]of [['none','missing-message'],['duplicate','invalid-message'],['malformed','invalid-message'],['error','child-failed'],['error-before-message','child-failed'],['exit','child-failed']]){
  const s=source(),plan=inspectionPlan(s,time);let child;const p=superviseInspection(s,plan,{now:()=>time,spawn:()=>{child=new EventEmitter();child.kill=()=>{};return child;}});let done=false;p.then(()=>done=true);
  if(kind==='duplicate'){child.emit('message',report('identity-observed','12345'));child.emit('message',report('identity-observed','12345'));}
  if(kind==='malformed')child.emit('message',{...report('unknown'),secret});
  if(kind==='error'){child.emit('message',report('identity-observed','12345'));child.emit('error',Error(secret));}
  if(kind==='error-before-message'){child.emit('error',Error(secret));child.emit('message',report('identity-observed','12345'));}
  await Promise.resolve();assert.equal(done,false);child.emit('close',kind==='exit'?1:0);assert.deepEqual(safe(await p),unknownReport('ipc',reason));
 }
});
test('launcher emits exactly once and starts only after supervised child close; raw stdout discarded',async()=>{
 const s=source();let child,starts=0;const emitted=[];
 const p=runInspectionStart(s,{artifact:async()=>{},now:()=>time,inspect:(src,plan)=>superviseInspection(src,plan,{now:()=>time,spawn:(_file,_args,opts)=>{assert.deepEqual(opts.stdio,['ignore','ignore','ignore','ipc']);child=new EventEmitter();child.kill=()=>{};return child;}}),start:async()=>{starts++;},emit:v=>emitted.push(v)});
 while(!child)await new Promise(r=>setImmediate(r));child.emit('message',unknownReport('identity','identity-mismatch'));await Promise.resolve();assert.equal(starts,0);assert.equal(emitted.length,0);child.emit('close',0);await p;assert.equal(starts,1);assert.deepEqual(emitted,[unknownReport('identity','identity-mismatch')]);safe(emitted[0]);
});

test('catalog subdivision IPC accepts only closed pairs on unknown with four false fields',async()=>{
 for(const reason of ['invalid-marker-catalog','marker-without-reservation','unexpected-inventory','completion-without-journal','journal-without-completion']){
  const valid=unknownReport('catalog',reason);assert.deepEqual(safe(projectReport(valid,'inspect')),valid);
  const s=source(),plan={...inspectionPlan(s,time),mode:'inspect',oid:'12345'};let child;
  const pending=superviseInspection(s,plan,{now:()=>time,spawn:()=>{child=new EventEmitter();child.kill=()=>{};return child;}});
  child.emit('message',valid);child.emit('close',0);assert.deepEqual(safe(await pending),valid);
  for(const invalid of [{...valid,phase:'identity'},{...valid,phase:'ipc'},{...valid,reason:reason+secret},{...valid,state:'absence-observed'},{...valid,details:secret},{...valid,initializationAllowed:true}])assert.deepEqual(safe(projectReport(invalid,'inspect')),unknownReport('ipc','invalid-message'));
 }
});
