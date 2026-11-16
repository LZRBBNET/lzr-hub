import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import { DbConversationDelivery } from '../../lib/platform/conversation-delivery-service.ts';
import { deliveryKey,hasDelivery } from '../../lib/platform/conversation-delivery-lock.ts';
import { DbReplyRepository,sendAttendantReply } from '../../lib/platform/attendant-reply-service.ts';
import { DbConversationStateRepository,changeConversationState } from '../../lib/platform/conversation-state-service.ts';
import { metaAutoReplySender } from '../../lib/platform/meta-auto-reply-service.ts';

export async function runDeliveryQA(pool,record,runtimePool=pool){
 const db=drizzle(runtimePool),states=new DbConversationStateRepository(db),delivery=new DbConversationDelivery(db),repository=new DbReplyRepository(db);
 const actor={id:'delivery-ana',name:'Ana sintética',email:'ana@example.invalid',role:'Atendente'},other={...actor,id:'delivery-bruno',name:'Bruno sintético',email:'bruno@example.invalid'};
 const channel='synthetic-delivery';let seq=0,calls=0;
 const fixture=async()=>{const phone='55110000'+String(++seq).padStart(5,'0');await pool.query("INSERT INTO channel_messages(id,channel,external_conversation_id,role,content,created_at) VALUES($1,$2,$3,'customer','Preciso de ajuda',$4)",['delivery-'+phone,channel,phone,new Date().toISOString()]);return phone;};
 const config={accessToken:'synthetic',phoneNumberId:'synthetic',graphVersion:'v26.0',fetcher:async()=>{calls++;return {status:200,json:async()=>({messages:[{id:'synthetic-out-'+calls}]})};}};
 const input=(phone,key,who=actor)=>({channel,conversationId:phone,text:'Vamos verificar sua conexão.',idempotencyKey:key,actor:who});
 const deps={repository,delivery,enabled:true,config};
 const bot=(phone,fetcher=config.fetcher)=>metaAutoReplySender({claims:repository,delivery,channel,customerMessageAt:new Date().toISOString(),config:{...config,fetcher}})({conversationId:phone,text:'Um atendente vai ajudar.',inboundMessageId:'delivery-in-'+phone});
 const mutate=(phone,action,who=actor)=>changeConversationState(states,{channel,conversationId:phone,actor:who,action});
 // Audited assignment must persist before the first external call.
 const p=await fixture(),before=calls;
 await pool.query(`CREATE FUNCTION synthetic_delivery_deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit denied'; END $$`);
 await pool.query('CREATE TRIGGER synthetic_delivery_deny BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_delivery_deny()');
 try{assert.equal((await sendAttendantReply(deps,input(p,'delivery-failure'))).ok,false);}finally{await pool.query('DROP TRIGGER synthetic_delivery_deny ON audit_events');await pool.query('DROP FUNCTION synthetic_delivery_deny()');}
 assert.equal(calls,before);assert.equal(await states.get(channel,p),undefined);assert.equal(await hasDelivery(db,channel,p),false);
 let entered,unblock;const started=new Promise(r=>entered=r),gate=new Promise(r=>unblock=r);
 const running=sendAttendantReply({...deps,config:{...config,fetcher:async()=>{calls++;entered();await gate;return {status:200,json:async()=>({messages:[{id:'synthetic-held'}]})};}}},input(p,'delivery-failure'));
 await started;assert.equal((await states.get(channel,p)).assigneeId,actor.id);
 for(const action of ['release','resolve','reopen']){const result=await mutate(p,action);assert.ok(!result.ok||result.changed===false);}
 assert.equal((await bot(p)).sent,false);
 assert.equal((await sendAttendantReply(deps,input(p,'delivery-other-human',other))).ok,false);
 unblock();const completed=await running;assert.equal(completed.ok,true);assert.equal(completed.recorded,true);assert.equal(await hasDelivery(db,channel,p),false);
 assert.equal((await mutate(p,'release')).ok,true);assert.equal((await mutate(p,'claim',other)).ok,true);
 const count=calls,replay=await sendAttendantReply(deps,input(p,'delivery-failure'));assert.equal(replay.duplicate,true);assert.equal(calls,count);assert.equal((await states.get(channel,p)).assigneeId,other.id);
 assert.equal((await sendAttendantReply(deps,{...input(p,'delivery-failure'),text:'Outro texto'})).status,409);
 assert.equal((await sendAttendantReply(deps,input(p,'delivery-failure',other))).status,409);
 record('human_delivery_atomic_and_replay',{auditFailureSends:0,assignedBeforeSend:true,inflightBotAndHumanBlocked:true,mutationsBlocked:true,replayAfterIntermediateReleaseAndClaimPreservesOwner:true,contextMismatch:409});
 // Two fresh human sends race: one owner wins, one transport call.
 const concurrent=await fixture(),raceBefore=calls;const race=await Promise.all([sendAttendantReply(deps,input(concurrent,'delivery-race-ana')),sendAttendantReply(deps,input(concurrent,'delivery-race-bruno',other))]);assert.equal(race.filter(r=>r.ok).length,1);assert.equal(calls,raceBefore+1);
 // A previously computed bot option must recheck ownership at dispatch.
 assert.equal((await bot(concurrent)).sent,false);
 record('human_delivery_concurrency',{competingOwners:2,transportCalls:1,staleBotDispatchBlocked:true});
 // Bot wins first: human and transitions cannot overlap its in-flight transport.
 const bp=await fixture();let botEntered,botRelease;const bs=new Promise(r=>botEntered=r),bg=new Promise(r=>botRelease=r);
 const br=bot(bp,async()=>{calls++;botEntered();await bg;return {status:200,json:async()=>({messages:[{id:'synthetic-bot'}]})};});await bs;
 assert.equal((await sendAttendantReply(deps,input(bp,'delivery-bot-first'))).ok,false);assert.equal((await mutate(bp,'claim')).ok,false);
 botRelease();assert.equal((await br).sent,true);assert.equal((await sendAttendantReply(deps,input(bp,'delivery-bot-first'))).ok,true);
 record('bot_first_delivery_serialization',{humanBlockedInflight:true,claimBlockedInflight:true,humanRecoveryAfterConfirmedBot:true});
 // Ambiguous network outcomes retain durable fence; no automatic TTL or takeover.
 for(const mode of ['timeout','network','missing-id','server-error']){
  const q=await fixture();let attempts=0;const broken={...config,fetcher:async()=>{attempts++;if(mode==='timeout'){const e=Error('synthetic');e.name='AbortError';throw e;}if(mode==='network')throw Error('synthetic network');return {status:mode==='server-error'?500:200,json:async()=>({})};}};
  assert.equal((await sendAttendantReply({...deps,config:broken},input(q,'delivery-'+mode))).ok,false);assert.equal(await hasDelivery(db,channel,q),true);
  assert.equal((await sendAttendantReply({...deps,config:broken},input(q,'delivery-'+mode))).status,409);assert.equal(attempts,1);
  assert.equal((await mutate(q,'release')).ok,false);assert.equal((await bot(q)).sent,false);
  await delivery.finish(channel,q,'wrong-token');assert.equal(await hasDelivery(db,channel,q),true);
 }
 record('human_delivery_uncertain_outcomes',{cases:['timeout','network','missing-id','server-error'],repeatedTransportCalls:0,reservationRetained:true,wrongTokenCannotClear:true,manualReconciliationRequired:true});
 // Failure after the external side effect never unassigns the human.
 const f=await fixture(),failing=new DbReplyRepository(db);failing.saveSent=async()=>{throw Error('synthetic persistence failure');};
 const fr=await sendAttendantReply({...deps,repository:failing},input(f,'delivery-postsend-failure'));assert.equal(fr.ok,true);assert.equal(fr.recorded,false);assert.equal((await states.get(channel,f)).assigneeId,actor.id);assert.equal((await bot(f)).sent,false);
 assert.equal((await sendAttendantReply({...deps,repository:failing},input(f,'delivery-postsend-failure'))).recorded,false);
 const ledgerPhone=await fixture(),ledgerRepository=new DbReplyRepository(db);
 await pool.query(`CREATE FUNCTION synthetic_skip_reply_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
 await pool.query('CREATE TRIGGER synthetic_skip_reply_result BEFORE UPDATE ON channel_idempotency_keys FOR EACH ROW EXECUTE FUNCTION synthetic_skip_reply_result()');
 const ledgerInput=input(ledgerPhone,'delivery-ledger-failure');let ledgerResult;try{ledgerResult=await sendAttendantReply({...deps,repository:ledgerRepository},ledgerInput);}finally{await pool.query('DROP TRIGGER synthetic_skip_reply_result ON channel_idempotency_keys');await pool.query('DROP FUNCTION synthetic_skip_reply_result()');}
 assert.equal(ledgerResult.ok,true);assert.equal(ledgerResult.recorded,false);assert.equal(await hasDelivery(db,channel,ledgerPhone),true);
 const ledgerBefore=calls;assert.equal((await sendAttendantReply({...deps,repository:ledgerRepository},ledgerInput)).status,409);assert.equal(calls,ledgerBefore);
 record('human_delivery_ledger_failure',{externalAccepted:true,suppressedUpdateDetected:true,recorded:false,fenceRetained:true,replayBlocked:true});
 for(const fault of ['before','after']){
  const cp=await fixture(),client=await runtimePool.connect(),original=client.query.bind(client);let injected=false;
  client.query=async(...args)=>{const query=typeof args[0]==='string'?args[0]:args[0].text,commit=query.trim().toLowerCase()==='commit';if(commit&&!injected&&fault==='before'){injected=true;throw Error('synthetic before commit');}const result=await original(...args);if(commit&&!injected&&fault==='after'){injected=true;throw Error('synthetic lost ack');}return result;};
  const oldCalls=calls;
  try{assert.equal((await sendAttendantReply({...deps,delivery:new DbConversationDelivery(drizzle(client))},input(cp,'delivery-commit-'+fault))).ok,false);assert.equal(injected,true);}finally{client.query=original;client.release(true);}
  assert.equal(calls,oldCalls);assert.equal(await hasDelivery(db,channel,cp),fault==='after');
  const retry=await sendAttendantReply(deps,input(cp,'delivery-commit-'+fault));assert.equal(retry.ok,fault==='before');
  record('human_delivery_commit_'+fault,{firstTransportCalls:0,reservationPersisted:fault==='after',retrySent:fault==='before',driverInjection:true});
 }
 // Channel key isolation and stale completion token are structural, not delimiter concatenation.
 assert.notEqual(deliveryKey('a:b','c'),deliveryKey('a','b:c'));
 record('human_delivery_postsend_persistence',{recorded:false,ownerPreserved:true,botBlocked:true,replayDoesNotClaimRecorded:true,channelKeysIsolated:true,realMessages:0});
}
