import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessor} from '../services/queue-runtime/src/processor.mjs';
import {BillingReminderBlockedError} from '../services/queue-runtime/src/billing-reminders.mjs';

test('consumer binding does not apply billing policy to another queue',async()=>{
 let reads=0,continuations=0;
 const processor=createProcessor('message-inbound',{readEvidence:async()=>{reads++;throw Error('MUST_NOT_READ');},continueEligible:async()=>{continuations++;}});
 const result=await processor({queueName:'billing-reminders',data:{correlationId:'synthetic'}});
 assert.equal(reads,0);assert.equal(continuations,0);assert.equal(result.queue,'message-inbound');assert.ok(Number.isFinite(Date.parse(result.processedAt)));
});
test('billing consumer rejects malformed foreign job before evidence or continuation',async()=>{
 let reads=0,continuations=0;
 const processor=createProcessor('billing-reminders',{readEvidence:async()=>{reads++;},continueEligible:async()=>{continuations++;}});
 await assert.rejects(processor({queueName:'message-inbound',data:{}}),e=>e instanceof BillingReminderBlockedError&&e.code==='BILLING_JOB_INVALID');
 assert.equal(reads,0);assert.equal(continuations,0);
});
