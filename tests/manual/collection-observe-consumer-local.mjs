// Run only through the inspected, disposable network-none Redis/Node harness.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {lstatSync} from 'node:fs';
import {createProcessor} from '../../services/queue-runtime/src/processor.mjs';
import {createFailedJobHandler} from '../../services/queue-runtime/src/failed-job-handler.mjs';
const require=createRequire(new URL('../../services/queue-runtime/package.json',import.meta.url));
const {Queue,Worker,UnrecoverableError,RedisConnection}=require('bullmq');
assert.equal(require('bullmq/package.json').version,'5.81.2');
assert.deepEqual(process.argv.slice(2),['--local-synthetic-consumer-approved']);
assert.deepEqual(Object.keys(process.env).sort(),['NODE_ENV','PATH']);assert.equal(process.env.NODE_ENV,'test');
assert.ok(lstatSync('/socket/redis.sock').isSocket());
const connection={path:'/socket/redis.sock',maxRetriesPerRequest:null,retryStrategy:()=>null};
const probe=new RedisConnection(connection);
try{assert.equal(await(await probe.client).dbsize(),0,'DISPOSABLE_EMPTY_REDIS_REQUIRED');}finally{await probe.close();}
const prefix='synthetic-observe-consumer',queue=new Queue('billing-reminders',{connection,prefix}),dlq=new Queue('dead-letter',{connection,prefix});
const client=await queue.client;
let at='2026-11-13T15:00:00.000Z';
const counters=new Map(),logs=[],pendingHandlers=[],results=[];
const now=()=>new Date(at);
const key=context=>`${prefix}:fixture:${context.customerId}:${context.invoiceId}`;
const deps={now,readEvidence:async context=>{
 const count=counters.get(context.invoiceId);count.reads++;
 const state=JSON.parse(await client.get(key(context)));
 if(state.unavailable)throw Error('SYNTHETIC_PRIVATE_SOURCE_ERROR');
 return {...state,observedAt:now().toISOString()};
},continueEligible:async context=>{
 counters.get(context.invoiceId).continuations++;
 return {simulationOnly:true,delivered:false,enqueued:0};
}};
const worker=new Worker('billing-reminders',createProcessor('billing-reminders',deps,{UnrecoverableError}),{connection,prefix,concurrency:2,autorun:false});
const failed=createFailedJobHandler('billing-reminders',{queue:name=>{assert.equal(name,'dead-letter');return dlq;}},{warn:value=>logs.push(value),error:value=>logs.push(value)});
worker.on('failed',(job,error)=>{pendingHandlers.push(failed(job,error));});
worker.on('error',()=>{logs.push('SYNTHETIC_QUEUE_ERROR');});
let run;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitState(job,expected){const end=Date.now()+6000;while(Date.now()<end){const state=await job.getState();if(state===expected)return;await pause(10);}throw Error('JOB_STATE_TIMEOUT');}
function fixture(name){
 const invoiceId='sim-invoice-'+name,customerId='sim-customer';
 const payload={schemaVersion:1,customerId,invoiceId,ruleId:'sim-rule',ruleVersion:1,stepId:'sim-step',scheduledFor:'2026-11-13',channel:'WhatsApp',templateId:'synthetic-no-contact'};
 const idempotencyKey=`${invoiceId}:${payload.stepId}:${payload.scheduledFor}`;
 return {payload,job:{correlationId:'synthetic',idempotencyKey,payload:{...payload,status:'A',paid:false}},state:{complete:true,invoice:{id:invoiceId,customerId,status:'A',dueAt:'2026-11-10',value:50,valueSource:'open-balance'},intent:{...payload,idempotencyKey,offsetDays:3,active:true,current:true,cancelled:false},promises:{complete:true,customerId,invoiceId,items:[]}}};
}
try{
 await queue.pause();await worker.waitUntilReady();run=worker.run();
 for(const name of ['paid','promise','zero-unconfirmed','source-unavailable','eligible-control']){
  at='2026-11-13T15:00:00.000Z';await queue.pause();
  const f=fixture(name);counters.set(f.payload.invoiceId,{reads:0,continuations:0});
  await client.set(key(f.payload),JSON.stringify(f.state));
  const options={jobId:'synthetic-'+name,attempts:3,backoff:{type:'fixed',delay:20},removeOnComplete:false,removeOnFail:false};
  const [job,duplicate]=await Promise.all([queue.add('collection-step:sim-step',f.job,options),queue.add('collection-step:sim-step',f.job,options)]);
  assert.equal(job.id,duplicate.id);assert.equal((await queue.getJobCounts('paused')).paused,1);
  // Changes occur AFTER the old intention is persisted, BEFORE any consumption.
  if(name==='paid'){f.state.promises.items=[{id:'sim-promise',customerId:f.payload.customerId,invoiceId:f.payload.invoiceId,status:'pending',promisedFor:'2026-11-16'}];f.state.invoice.status='R';f.state.invoice.value=0;}
  if(name==='promise')f.state.promises.items=[{id:'sim-promise',customerId:f.payload.customerId,invoiceId:f.payload.invoiceId,status:'pending',promisedFor:'2026-11-16'}];
  if(name==='zero-unconfirmed')f.state.invoice.value=0;
  if(name==='source-unavailable')f.state.unavailable=true;
  await client.set(key(f.payload),JSON.stringify(f.state));
  const dlqBefore=await dlq.getJobCountByTypes('waiting');await queue.resume();
  const expected=name==='eligible-control'?'completed':'failed';await waitState(job,expected);await pause(80);await Promise.all(pendingHandlers);
  const saved=await queue.getJob(job.id),count=counters.get(f.payload.invoiceId);
  assert.equal(count.continuations,name==='eligible-control'?1:0);
  if(name==='paid'||name==='promise'){
   assert.equal(saved.attemptsMade,1);assert.equal(count.reads,1);assert.equal(await dlq.getJobCountByTypes('waiting'),dlqBefore);
   assert.equal(saved.failedReason,name==='paid'?'BILLING_INVOICE_NOT_OPEN':'BILLING_PROMISE_ACTIVE');
   assert.ok(!saved.returnvalue);assert.equal(await queue.getWaitingCount(),0);assert.equal(await queue.getActiveCount(),0);assert.equal(await queue.getDelayedCount(),0);
  }else if(name!=='eligible-control'){
   assert.equal(saved.attemptsMade,3);assert.equal(count.reads,3);
   assert.equal(saved.failedReason,name==='zero-unconfirmed'?'BILLING_INVOICE_BALANCE_UNCONFIRMED':'BILLING_EVIDENCE_UNAVAILABLE');
   assert.equal(await dlq.getJobCountByTypes('waiting'),dlqBefore+1);assert.equal(f.state.invoice.status,'A');
  }else assert.deepEqual(saved.returnvalue,{simulationOnly:true,delivered:false,enqueued:0});
  results.push({scenario:name,state:expected,attempts:saved.attemptsMade,reads:count.reads,continuations:count.continuations,delivered:false,subsequentReminderEnqueued:0,duplicateProducers:2,uniqueJob:1,dlqDelta:(await dlq.getJobCountByTypes('waiting'))-dlqBefore});
  if(name==='paid'||name==='promise'){
   // Deliberate laboratory-only reexecution; never an operational recommendation.
   const before=count.reads;if(name==='promise')at='2026-11-17T15:00:00.000Z';
   await saved.retry();await waitState(saved,'failed');await pause(80);await Promise.all(pendingHandlers);
   assert.equal(count.continuations,0);assert.equal((await queue.getJob(job.id)).failedReason,name==='paid'?'BILLING_INVOICE_NOT_OPEN':'BILLING_JOB_OBSOLETE');
   assert.equal(count.reads-before,name==='paid'?1:0);assert.equal(await dlq.getJobCountByTypes('waiting'),dlqBefore);
   results.push({scenario:name==='paid'?'paid-reexecution':'expired-promise-old-schedule',state:'failed',extraReads:count.reads-before,continuations:0,delivered:false,subsequentReminderEnqueued:0,dlqDelta:0});
  }
 }
 assert.ok(!logs.join('\n').includes('SYNTHETIC_PRIVATE_SOURCE_ERROR'));assert.ok(!logs.includes('SYNTHETIC_QUEUE_ERROR'));
 console.log(JSON.stringify({passed:true,bullmqVersion:'5.81.2',workerConcurrency:2,queue:'real-local-redis',results,counts:await queue.getJobCounts('waiting','active','delayed','failed','completed'),dlq:await dlq.getJobCountByTypes('waiting'),deliveryTransport:'absent'}));
}finally{
 await worker.close();if(run)await run;await Promise.all(pendingHandlers);await queue.close();await dlq.close();
}
