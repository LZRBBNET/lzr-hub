import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryReplyRepository, sendAttendantReply } from '../lib/platform/attendant-reply-service.ts';
const input = { channel:'fixture', conversationId:'5579000000000', text:'Resposta de atendimento', idempotencyKey:'fixture-key-123456', actor:{email:'operator@example.test',role:'Atendente'} };
function setup(fetcher) {
 const repository = new MemoryReplyRepository();
 repository.customerMessages.push({channel:input.channel,conversationId:input.conversationId,createdAt:new Date().toISOString()});
 return {repository,enabled:true,config:{accessToken:'fixture-only',phoneNumberId:'fixture',graphVersion:'v26.0',fetcher}};
}
test('lost response after acceptance retains reservation and cannot send twice', async()=>{
 let calls=0;
 const deps=setup(async()=>{calls++;throw new TypeError('connection lost after acceptance');});
 const first=await sendAttendantReply(deps,input);
 await sendAttendantReply(deps,input);
 assert.equal(calls,1);
 assert.equal(first.retrySafe,false);
 assert.equal((await deps.repository.claimState('reply:'+input.idempotencyKey)).status,'unknown');
});
test('2xx without receipt retains reservation',async()=>{
 let calls=0;const deps=setup(async()=>{calls++;return {status:200,json:async()=>({})};});
 assert.equal((await sendAttendantReply(deps,input)).retrySafe,false);
 await sendAttendantReply(deps,input);assert.equal(calls,1);
});

test('pre-send refusal is safe; unavailable release stays blocked',async()=>{
 let calls=0;const deps=setup(async()=>{calls++;return {status:400,json:async()=>({error:{code:131047}})};});
 assert.equal((await sendAttendantReply({...deps,enabled:false},input)).retrySafe,true);
 assert.equal(calls,0);
 deps.repository.release=async()=>{throw new Error('fixture storage unavailable');};
 assert.equal((await sendAttendantReply(deps,input)).retrySafe,false);
 assert.equal((await deps.repository.claimState('reply:'+input.idempotencyKey)).status,'pending');
});
test('accepted but persistence interrupted remains reconciliable without another send',async()=>{
 let calls=0;const deps=setup(async()=>{calls++;return {status:200,json:async()=>({messages:[{id:'wamid.fixture'}]})};});
 deps.repository.saveSent=async()=>{throw new Error('fixture storage unavailable');};
 const first=await sendAttendantReply(deps,input);
 assert.equal(first.ok,true);assert.equal(first.recorded,false);
 const {reconcileAttendantReply}=await import('../lib/platform/attendant-reply-service.ts');
 assert.deepEqual(await reconcileAttendantReply(deps.repository,input),{state:'sent',messageId:'wamid.fixture'});
 assert.equal(calls,1);
});
test('reconciliation scopes by channel and conversation, requires actor, and absent is not retry permission',async()=>{
 const {reconcileAttendantReply}=await import('../lib/platform/attendant-reply-service.ts');
 const deps=setup(async()=>{throw new Error('must not call transport');});
 assert.deepEqual(await reconcileAttendantReply(deps.repository,input),{state:'absent'});
 await deps.repository.claim('reply:'+input.idempotencyKey,input.channel,input.conversationId);
 assert.deepEqual(await reconcileAttendantReply(deps.repository,input),{state:'pending'});
 await deps.repository.setClaimState('reply:'+input.idempotencyKey,{status:'sent',messageId:'wamid.fixture'});
 for(const change of [{channel:'other'},{conversationId:'5579000000001'}]) {
   assert.deepEqual(await reconcileAttendantReply(deps.repository,{...input,...change}),{state:'absent'});
 }
 assert.deepEqual(await reconcileAttendantReply(deps.repository,{...input,actor:undefined}),{state:'unknown'});
 assert.deepEqual(await reconcileAttendantReply(deps.repository,{...input,idempotencyKey:'bad'}),{state:'unknown'});
});
test('failed acceptance-state update retains pending claim and blocks replay',async()=>{
 let calls=0;const deps=setup(async()=>{calls++;return {status:200,json:async()=>({messages:[{id:'wamid.fixture'}]})};});
 deps.repository.setClaimState=async()=>{throw new Error('fixture storage unavailable');};
 assert.equal((await sendAttendantReply(deps,input)).ok,true);
 const again=await sendAttendantReply(deps,input);assert.equal(again.retrySafe,false);
 assert.equal(calls,1);
});


test('replay confirms acceptance without claiming history persistence; unauthenticated reuse stays blocked',async()=>{
 const deps=setup(async()=>({status:200,json:async()=>({messages:[{id:'wamid.fixture'}]})}));
 await sendAttendantReply(deps,input);
 const replay=await sendAttendantReply(deps,input);
 assert.equal(replay.ok,true);assert.equal(replay.recorded,false);
 const rejected=await sendAttendantReply(deps,{...input,actor:undefined});
 assert.equal(rejected.retrySafe,false);
});
