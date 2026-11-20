import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { DbConversationFence, fenceKey, readLedger } from "../lib/platform/conversation-fence.ts";
import { DbConversationDelivery } from "../lib/platform/conversation-delivery-service.ts";
import { DbTicketRepository, openOrContinueTicket } from "../lib/platform/triage-service.ts";
import { DbConversationStateRepository, changeConversationStateWithTicket } from "../lib/platform/conversation-state-service.ts";
import { metaAutoReplySender } from "../lib/platform/meta-auto-reply-service.ts";
import { DbReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { deliveryKey } from "../lib/platform/conversation-delivery-lock.ts";

const socket=process.env.LZR_FENCE_TEST_SOCKET;
if(socket && !/^\/tmp\/lzr-fence-[\w-]+$/.test(socket)) throw Error("Only explicitly isolated local test sockets are permitted");
test("isolated PostgreSQL: generation, handoff confirmation and dispatch boundary",{skip:!socket},async t=>{
 const pool=new Pool({host:socket,user:"postgres",database:"postgres",password:"",port:5432,max:5});
 const db=drizzle(pool);const fence=new DbConversationFence(db);const delivery=new DbConversationDelivery(db);
 const actor={id:"local-actor",name:"Local operator",email:"local@example.invalid",role:"admin"};
 try {
  await migrate(db,{migrationsFolder:"./drizzle"});
  let n=0; const run=String(Date.now());
  async function fixture(){const id=`000${run.slice(-7)}${String(++n).padStart(2,"0")}`,channel=`local-fence-${run}`;
   await db.execute(sql`insert into channel_messages(id,channel,external_conversation_id,role,content,created_at) values (${`fixture-${run}-${n}`},${channel},${id},'customer','local fixture',${new Date().toISOString()})`);
   const {ticket}=await openOrContinueTicket(new DbTicketRepository(db),{channel,conversationId:id});
   const a=await fence.capture(channel,id,`in-a-${run}-${n}`),b=await fence.capture(channel,id,`in-b-${run}-${n}`);
   const handoff=()=>new DbTicketRepository(db,b).updateTriage(ticket.id,{stage:"handoff"});
   const change=action=>db.transaction(tx=>changeConversationStateWithTicket(new DbConversationStateRepository(tx),new DbTicketRepository(tx),{channel,conversationId:id,action,actor}));
   return {channel,id,ticket,a,b,handoff,change};
  }
  await t.test("committed handoff rejects old dispatch; its confirmation is one-use; release doesn't revive retry",async()=>{
   const f=await fixture();assert.equal(await f.handoff(),true);assert.equal(f.b.kind,"confirmation");
   await assert.rejects(delivery.begin(f.channel,f.id,undefined,f.a.sendKey,f.a),/OBSOLETE/);
   const token=await delivery.begin(f.channel,f.id,undefined,f.b.sendKey,f.b);
   assert.equal(await delivery.authorizeDispatch(f.channel,f.id,token,f.b),true);
   assert.equal(await delivery.authorizeDispatch(f.channel,f.id,token,f.b),false);
   await delivery.finish(f.channel,f.id,token);
   await assert.rejects(delivery.begin(f.channel,f.id,undefined,f.b.sendKey,f.b),/OBSOLETE/);
   assert.equal((await f.change("release")).ok,true);
   const retry=await fence.capture(f.channel,f.id,`in-a-${run}-${n}`);assert.equal(retry.generation,f.a.generation);
   await assert.rejects(delivery.begin(f.channel,f.id,undefined,retry.sendKey,retry),/OBSOLETE/);
   const fresh=await fence.capture(f.channel,f.id,"new-after-release");assert.notEqual(fresh.generation,retry.generation);
   const next=await delivery.begin(f.channel,f.id,undefined,fresh.sendKey,fresh);await delivery.finish(f.channel,f.id,next);
  });
  await t.test("handoff revokes prepared reservation; stale completion cannot remove newer confirmation",async()=>{
   const f=await fixture();const old=await delivery.begin(f.channel,f.id,undefined,f.a.sendKey,f.a);
   assert.equal(await f.handoff(),true);assert.equal(await delivery.authorizeDispatch(f.channel,f.id,old,f.a),false);
   const next=await delivery.begin(f.channel,f.id,undefined,f.b.sendKey,f.b);
   await delivery.finish(f.channel,f.id,old);assert.equal((await readLedger(db,deliveryKey(f.channel,f.id))).token,next);
   await delivery.finish(f.channel,f.id,next);
  });
  await t.test("authorized-before-fetch blocks handoff/takeover until settled; uncertain stays blocked",async()=>{
   const f=await fixture();const token=await delivery.begin(f.channel,f.id,undefined,f.a.sendKey,f.a);
   assert.equal(await delivery.authorizeDispatch(f.channel,f.id,token,f.a),true);
   assert.equal(await f.handoff(),false);assert.equal((await f.change("claim")).ok,false);
   assert.notEqual((await new DbTicketRepository(db).findOpen(f.channel,f.id)).stage,"handoff");
   await delivery.settleUncertain(f.channel,f.id,token);
   const reservation=await readLedger(db,deliveryKey(f.channel,f.id));assert.equal(reservation.status,"uncertain");assert.equal(reservation.workerSettled,true);
   assert.equal((await f.change("release")).ok,false);assert.equal(await f.handoff(),false);
  });
  await t.test("takeover revokes preparation and return rotates generation; resolve gates old inbound",async()=>{
   const f=await fixture();const token=await delivery.begin(f.channel,f.id,undefined,f.a.sendKey,f.a);
   assert.equal((await f.change("claim")).ok,true);assert.equal(await delivery.authorizeDispatch(f.channel,f.id,token,f.a),false);
   assert.equal((await f.change("release")).ok,true);
   const generation=(await readLedger(db,fenceKey(f.channel,f.id))).generation;
   assert.equal((await f.change("resolve")).ok,true);
   const old=await fence.capture(f.channel,f.id,"delayed-old-event","2020-01-01T00:00:00Z");
   await assert.rejects(delivery.begin(f.channel,f.id,undefined,old.sendKey,old),/OBSOLETE/);
   const fresh=await fence.capture(f.channel,f.id,"new-after-resolve",new Date(Date.now()+1000).toISOString());
   assert.notEqual(fresh.generation,generation);
  });
  await t.test("real sender calls only local fetch stub for own confirmation and never stale turn",async()=>{
   const f=await fixture();let calls=0;
   const config={accessToken:"local-only",phoneNumberId:"local",graphVersion:"v26.0",fetcher:async()=>{calls++;return {status:200,json:async()=>({messages:[{id:"local-accepted"}]})};}};
   const sendFor=turn=>metaAutoReplySender({claims:new DbReplyRepository(db),delivery,turn,config,channel:f.channel,customerMessageAt:new Date().toISOString()});
   assert.equal(await f.handoff(),true);
   const stale=await sendFor(f.a)({conversationId:f.id,text:"Atendimento recebido.",inboundMessageId:`in-a-${run}-${n}`});assert.equal(stale.sent,false);assert.equal(calls,0);
   const confirmed=await sendFor(f.b)({conversationId:f.id,text:"Um atendente continua por aqui.",inboundMessageId:`in-b-${run}-${n}`});assert.equal(confirmed.sent,true);assert.equal(calls,1);
   const retry=await sendFor(f.b)({conversationId:f.id,text:"Um atendente continua por aqui.",inboundMessageId:`in-b-${run}-${n}`});assert.equal(retry.sent,true);assert.equal(calls,1);
  });
  await t.test("sender paused after preparation is revoked before provider invocation",async()=>{
   const f=await fixture();let calls=0,ready,proceed;
   const prepared=new Promise(resolve=>{ready=resolve;});const resumed=new Promise(resolve=>{proceed=resolve;});
   const controlled={begin:delivery.begin.bind(delivery),finish:delivery.finish.bind(delivery),settleUncertain:delivery.settleUncertain.bind(delivery),
    authorizeDispatch:async(...args)=>{ready();await resumed;return delivery.authorizeDispatch(...args);}};
   const sender=metaAutoReplySender({claims:new DbReplyRepository(db),delivery:controlled,turn:f.a,channel:f.channel,customerMessageAt:new Date().toISOString(),
    config:{accessToken:"local-only",phoneNumberId:"local",graphVersion:"v26.0",fetcher:async()=>{calls++;throw Error("must not call");}}});
   const task=sender({conversationId:f.id,text:"Atendimento recebido.",inboundMessageId:`in-a-${run}-${n}`});
   await Promise.race([prepared,task.then(()=>{throw Error("sender did not reach preparation");})]);try{assert.equal(await f.handoff(),true);}finally{proceed();}
   assert.equal((await task).sent,false);assert.equal(calls,0);
   assert.equal(await new DbTicketRepository(db,f.a).updateTriage(f.ticket.id,{stage:"routed",queue:"atendimento"}),false);
  });
  await t.test("lost authorization response makes no transport call and leaves auditable uncertainty",async()=>{
   const f=await fixture();let calls=0;
   const injected={begin:delivery.begin.bind(delivery),finish:delivery.finish.bind(delivery),settleUncertain:delivery.settleUncertain.bind(delivery),
    authorizeDispatch:async(...args)=>{await delivery.authorizeDispatch(...args);throw Error("local lost commit response");}};
   const sender=metaAutoReplySender({claims:new DbReplyRepository(db),delivery:injected,turn:f.a,channel:f.channel,customerMessageAt:new Date().toISOString(),
    config:{accessToken:"local-only",phoneNumberId:"local",graphVersion:"v26.0",fetcher:async()=>{calls++;throw Error("must not call");}}});
   const result=await sender({conversationId:f.id,text:"Atendimento recebido.",inboundMessageId:`in-a-${run}-${n}`});
   assert.equal(result.sent,false);assert.equal(result.outcome,"unknown");assert.equal(calls,0);
   const reservation=await readLedger(db,deliveryKey(f.channel,f.id));assert.equal(reservation.status,"uncertain");assert.equal(reservation.workerSettled,true);
   const retry=await sender({conversationId:f.id,text:"Atendimento recebido.",inboundMessageId:`in-a-${run}-${n}`});assert.equal(retry.sent,false);assert.equal(calls,0);
   const audit=await db.execute(sql`select count(*)::int as n from audit_events where action = 'whatsapp.fence.dispatch_uncertain' and entity = ${fenceKey(f.channel,f.id)}`);assert.ok(audit.rows[0].n>0);
  });
  await t.test("accepted transport with failed cleanup preserves uncertainty and never resends",async()=>{
   const f=await fixture();let calls=0;
   const injected={begin:delivery.begin.bind(delivery),authorizeDispatch:delivery.authorizeDispatch.bind(delivery),settleUncertain:delivery.settleUncertain.bind(delivery),finish:async()=>{throw Error("local cleanup unavailable");}};
   const sender=metaAutoReplySender({claims:new DbReplyRepository(db),delivery:injected,turn:f.a,channel:f.channel,customerMessageAt:new Date().toISOString(),
    config:{accessToken:"local-only",phoneNumberId:"local",graphVersion:"v26.0",fetcher:async()=>{calls++;return {status:200,json:async()=>({messages:[{id:"local-cleanup-accepted"}]})};}}});
   const input={conversationId:f.id,text:"Atendimento recebido.",inboundMessageId:`in-a-${run}-${n}`};
   assert.equal((await sender(input)).sent,true);
   const reservation=await readLedger(db,deliveryKey(f.channel,f.id));assert.equal(reservation.status,"uncertain");assert.equal(reservation.acceptedMessageId,"local-cleanup-accepted");
   assert.equal(await f.handoff(),false);assert.equal((await sender(input)).sent,true);assert.equal(calls,1);
  });
  await t.test("concurrent dispatch authorization versus handoff has only one winning order",async()=>{
   for(let i=0;i<8;i++){
    const f=await fixture();const token=await delivery.begin(f.channel,f.id,undefined,f.a.sendKey,f.a);
    const [authorized,handed]=await Promise.all([delivery.authorizeDispatch(f.channel,f.id,token,f.a),f.handoff()]);
    assert.notEqual(authorized,handed);
    if(authorized){assert.equal((await f.change("claim")).ok,false);await delivery.finish(f.channel,f.id,token);assert.equal(await f.handoff(),true);}
    else assert.equal(await delivery.authorizeDispatch(f.channel,f.id,token,f.a),false);
   }
  });
 } finally {await pool.end();}
});
