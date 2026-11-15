// Test-only composition. No Redis, network API, secrets, external callback or sender.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {createProcessor} from '../../services/queue-runtime/src/processor.mjs';

const source=await readFile(new URL('../../services/queue-runtime/src/worker.mjs',import.meta.url),'utf8');
const imports=source.match(/^import .*;$/gm)??[];
assert.equal(imports.length,3,'review fixture isolation when worker imports change');
const body=source.replace(/^import .*;\n/gm,'');
const instant='2026-11-13T15:00:00.000Z';
export const fixtureJob=()=>({id:'synthetic-job',queueName:'billing-reminders',name:'collection-step:step',attemptsMade:0,opts:{attempts:1},data:{idempotencyKey:'901:step:2026-11-13',payload:{schemaVersion:1,invoiceId:'901',customerId:'10',ruleId:'rule',ruleVersion:1,stepId:'step',scheduledFor:'2026-11-13',channel:'WhatsApp',templateId:'synthetic-no-send'}}});
export function composeWorkerFixture({mode,scenario='eligible'}={}){
 assert.ok(['baseline-generic','synthetic-guarded'].includes(mode),'explicit fixture mode required');
 assert.ok(['eligible','paid','promise','incomplete','stale','missing-evidence','missing-continuation','transport-failure'].includes(scenario));
 const workers=new Map(),claims=new Set(),events=[];let reads=0,transportAttempts=0,closed=false;
 const evidence=async context=>{
  reads++;events.push('evidence');
  return {complete:scenario!=='incomplete',observedAt:scenario==='stale'?'2026-11-12T15:00:00.000Z':instant,
   invoice:{id:'901',customerId:'10',status:scenario==='paid'?'R':'A',value:scenario==='paid'?0:50,valueSource:'open-balance',dueAt:'2026-11-10'},
   intent:{...context,offsetDays:3,active:true,current:true,cancelled:false},
   promises:{complete:true,customerId:'10',invoiceId:'901',items:scenario==='promise'?[{id:'synthetic-promise',customerId:'10',invoiceId:'901',status:'pending',promisedFor:'2026-11-14'}]:[]}};
 };
 const continuation=async context=>{
  events.push('claim');
  if(claims.has(context.idempotencyKey))return {simulationOnly:true,delivered:false,duplicate:true};
  claims.add(context.idempotencyKey);
  // This closed no-send stub cannot be replaced by a caller-supplied transport.
  transportAttempts++;events.push('transport-mock');
  if(scenario==='transport-failure')throw Error('SYNTHETIC_TRANSPORT_FAILURE');
  return {simulationOnly:true,delivered:false,duplicate:false};
 };
 class FixtureUnrecoverableError extends Error { constructor(message){super(message);this.name="FixtureUnrecoverableError";} }
 class FixtureWorker extends EventEmitter{
  constructor(name,original,options){super();assert.deepEqual(options.connection,{fixtureOnly:true});this.original=original;
   this.processor=mode==='synthetic-guarded'?createProcessor(name,{now:()=>new Date(instant),readEvidence:scenario==='missing-evidence'?undefined:evidence,continueEligible:scenario==='missing-continuation'?undefined:continuation},{UnrecoverableError:FixtureUnrecoverableError}):original;
   workers.set(name,this);
  }
  async close(){this.removeAllListeners();}
 }
 const runtime={connection:{fixtureOnly:true},queue:()=>{throw Error('QUEUE_ACCESS_FORBIDDEN');},close:async()=>{closed=true;}};
 vm.runInNewContext(body,{Worker:FixtureWorker,deadLetterQueueName:'dead-letter',queueNames:['billing-reminders','message-inbound'],loadConfig:()=>({prefix:'synthetic',concurrency:1}),createRuntime:()=>runtime,console:{info(){},warn(){},error(){}},process:{on(){},exit(){throw Error('PROCESS_EXIT_FORBIDDEN');}},Date},{timeout:1000});
 return {run:job=>{assert.ok(!closed);return workers.get(job.queueName==='message-inbound'?'message-inbound':'billing-reminders').processor(job);},
  runOriginal:job=>workers.get('billing-reminders').original(job),
  inspect:()=>({reads,transportAttempts,claims:claims.size,events:[...events],closed}),
  close:async()=>{for(const worker of workers.values())await worker.close();workers.clear();claims.clear();await runtime.close();}};
}
