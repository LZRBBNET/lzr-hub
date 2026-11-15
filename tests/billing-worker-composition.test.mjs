import test from 'node:test';
import assert from 'node:assert/strict';
import {composeWorkerFixture,fixtureJob} from './helpers/billing-worker-fixture.mjs';
async function withFixture(options,run){const f=composeWorkerFixture(options);try{await run(f);}finally{await f.close();assert.equal(f.inspect().closed,true);assert.equal(f.inspect().claims,0);}}

test('fixture requires explicit opt-in and accepts no operational mode',()=>{
 assert.throws(()=>composeWorkerFixture());assert.throws(()=>composeWorkerFixture({mode:'production'}));
});
for(const scenario of ['paid','promise','incomplete'])test(`baseline executable callback completes ${scenario} without billing evidence, not delivery`,()=>withFixture({mode:'baseline-generic',scenario},async f=>{
 const result=await f.runOriginal(fixtureJob());assert.equal(typeof result.processedAt,'string');assert.equal('delivered' in result,false);assert.equal(f.inspect().reads,0);assert.equal(f.inspect().transportAttempts,0);
}));
for(const [scenario,code] of [['paid','BILLING_INVOICE_NOT_OPEN'],['promise','BILLING_PROMISE_ACTIVE'],['incomplete','BILLING_EVIDENCE_INCOMPLETE'],['stale','BILLING_EVIDENCE_STALE'],['missing-evidence','BILLING_EVIDENCE_SOURCE_UNAVAILABLE'],['missing-continuation','BILLING_CONTINUATION_UNAVAILABLE']])test(`synthetic composition blocks ${scenario} before no-send transport`,()=>withFixture({mode:'synthetic-guarded',scenario},async f=>{
 await assert.rejects(f.run(fixtureJob()),error=>(error.code??error.cause?.code)===code);assert.equal(f.inspect().transportAttempts,0);assert.equal(f.inspect().claims,0);
}));
test('bound billing queue rejects spoofed job queue and mismatched idempotency key',()=>withFixture({mode:'synthetic-guarded'},async f=>{
 const spoof=fixtureJob();spoof.queueName='other';await assert.rejects(f.run(spoof),/BILLING_JOB_INVALID/);
 const mismatch=fixtureJob();mismatch.data.idempotencyKey='other';await assert.rejects(f.run(mismatch),/BILLING_JOB_CONTEXT_MISMATCH/);assert.equal(f.inspect().reads,0);assert.equal(f.inspect().transportAttempts,0);
}));
test('guarded synthetic duplicates revalidate then share one in-memory claim before mock',()=>withFixture({mode:'synthetic-guarded'},async f=>{
 const results=await Promise.all([f.run(fixtureJob()),f.run(fixtureJob())]);assert.equal(results.filter(r=>r.duplicate).length,1);assert.ok(results.every(r=>r.simulationOnly&&r.delivered===false));assert.equal(f.inspect().reads,2);assert.equal(f.inspect().transportAttempts,1);assert.ok(f.inspect().events.indexOf('evidence')<f.inspect().events.indexOf('transport-mock'));
}));
test('uncertain mock failure retains claim and suppresses retry, demonstrating possible loss',()=>withFixture({mode:'synthetic-guarded',scenario:'transport-failure'},async f=>{
 await assert.rejects(f.run(fixtureJob()),/BILLING_CONTINUATION_FAILED/);assert.equal((await f.run(fixtureJob())).duplicate,true);assert.equal(f.inspect().transportAttempts,1);
}));
test('fresh fixture loses claims, so no durable exactly-once guarantee is claimed',async()=>{
 for(let generation=0;generation<2;generation++)await withFixture({mode:'synthetic-guarded'},async f=>{assert.equal((await f.run(fixtureJob())).duplicate,false);assert.equal(f.inspect().transportAttempts,1);});
});
test('generic queue remains metadata-only in synthetic composition',()=>withFixture({mode:'synthetic-guarded'},async f=>{
 const job=fixtureJob();job.queueName='message-inbound';const result=await f.run(job);assert.equal(result.queue,'message-inbound');assert.equal('delivered' in result,false);assert.equal(f.inspect().reads,0);assert.equal(f.inspect().transportAttempts,0);
}));

test('terminal billing refusal is mapped to injected unrecoverable worker error',()=>withFixture({mode:'synthetic-guarded',scenario:'promise'},async f=>{
 await assert.rejects(f.run(fixtureJob()),error=>error.name==='FixtureUnrecoverableError'&&error.cause.code==='BILLING_PROMISE_ACTIVE');assert.equal(f.inspect().transportAttempts,0);
}));
