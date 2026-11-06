import assert from 'node:assert/strict';
import {hashToken} from '../../lib/platform/auth.ts';
import {drizzle} from 'drizzle-orm/node-postgres';
import {DbConversationDelivery} from '../../lib/platform/conversation-delivery-service.ts';
import {DbDeliveryReconciliation} from '../../lib/platform/delivery-reconciliation-service.ts';
import {DbReplyRepository,sendAttendantReply} from '../../lib/platform/attendant-reply-service.ts';
export async function runReconciliationQA(pool,runtime,record){
 const db=drizzle(runtime),delivery=new DbConversationDelivery(db),repository=new DbReplyRepository(db),reconciliation=new DbDeliveryReconciliation(db),channel='synthetic-reconciliation';
 const actor={id:'rec-agent',name:'Operador QA',email:'rec-agent@example.invalid',role:'Atendente'},supervisor={id:'rec-supervisor',name:'Supervisor QA',email:'rec-supervisor@example.invalid',role:'Supervisor'},other={...supervisor,id:'rec-other',email:'rec-other@example.invalid'};
 for(const user of [supervisor,other]){await pool.query("INSERT INTO users(id,email,name,role,password_hash,password_salt,created_at,updated_at) VALUES($1,$2,$3,$4,'synthetic-unused','synthetic-unused',$5,$5)",[user.id,user.email,user.name,user.role,new Date().toISOString()]);await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)",[hashToken('synthetic-session-'+user.id),user.id,new Date(Date.now()+3600000).toISOString(),new Date().toISOString()]);}
 let seq=0,calls=0;const fixture=async()=>{const phone='55112222'+String(++seq).padStart(5,'0');await pool.query("INSERT INTO channel_messages(id,channel,external_conversation_id,role,content,created_at) VALUES($1,$2,$1,'customer','Caso de conferência',$3)",[phone,channel,new Date().toISOString()]);return phone;};
 const config={accessToken:'synthetic',phoneNumberId:'synthetic',graphVersion:'v26.0',fetcher:async()=>{calls++;const e=Error('synthetic timeout');e.name='AbortError';throw e;}};
 const send=phone=>sendAttendantReply({repository,delivery,config,enabled:true},{channel,conversationId:phone,text:'Vou conferir sua conexão.',idempotencyKey:'reconcile-key-'+phone,actor});
 const request=async phone=>({channel,conversationId:phone,reservationId:(await reconciliation.status(channel,phone)).reservationId,outcome:'not_sent',evidence:'Protocolo sintético de conferência 20261106',actor:supervisor,sessionToken:"synthetic-session-"+supervisor.id});
 const total=async()=>Number((await pool.query("SELECT count(*) FROM audit_events WHERE action='conversation.delivery.reconciled'")).rows[0].count);
 const p=await fixture();await send(p);assert.equal((await reconciliation.status(channel,p)).eligible,true);const input=await request(p),before=await total();
 await assert.rejects(()=>reconciliation.reconcile({...input,actor}),e=>e.status===403);
 await assert.rejects(()=>reconciliation.reconcile({...input,evidence:'curta'}),e=>e.status===400);
 await pool.query('REVOKE INSERT ON audit_events FROM synthetic_delivery_runtime');try{await assert.rejects(()=>reconciliation.reconcile(input));}finally{await pool.query('GRANT INSERT ON audit_events TO synthetic_delivery_runtime');}
 assert.ok(await reconciliation.status(channel,p));assert.equal((await repository.claimState('reply:reconcile-key-'+p)).status,'unknown');assert.equal(await total(),before);
 const races=await Promise.allSettled([reconciliation.reconcile(input),reconciliation.reconcile({...input,actor:other,sessionToken:"synthetic-session-"+other.id})]);assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(await total(),before+1);assert.equal(await reconciliation.status(channel,p),null);
 const winner=races[0].status==='fulfilled'?input:{...input,actor:other,sessionToken:"synthetic-session-"+other.id};assert.equal((await reconciliation.reconcile(winner)).duplicate,true);const oldCalls=calls;assert.equal((await send(p)).status,409);assert.equal(calls,oldCalls);
 // A replay of the old resolution must not clear a new reservation on the same conversation.
 await repository.claim('reply:new-operation-'+p,channel,p,'synthetic-context');const token=await delivery.begin(channel,p,actor,'reply:new-operation-'+p);assert.equal((await reconciliation.reconcile(winner)).duplicate,true);assert.equal((await reconciliation.status(channel,p)).reservationId,token);
 await assert.rejects(()=>reconciliation.reconcile({...input,reservationId:token}),e=>e.status===409);
 await delivery.finish(channel,p,token);
 record('reconciliation_atomic_permission_race',{attendantDenied:true,auditFailureRolledBack:true,competingSupervisors:2,winners:1,auditRows:1,replayNoResend:true,oldReplayPreservesNewReservation:true,pendingWorkerCannotBeReleased:true});
 const live=await fixture();let entered,finishTransport;const started=new Promise(r=>entered=r),gate=new Promise(r=>finishTransport=r);
 const active=sendAttendantReply({repository,delivery,enabled:true,config:{...config,fetcher:async()=>{entered();await gate;return config.fetcher();}}},{channel,conversationId:live,text:'Vamos conferir o atendimento.',idempotencyKey:'reconcile-key-'+live,actor});
 await started;assert.equal((await reconciliation.status(channel,live)).eligible,false);
 const liveRequest=await request(live);await assert.rejects(()=>reconciliation.reconcile(liveRequest),e=>e.status===409);finishTransport();assert.equal((await active).status,502);assert.equal((await reconciliation.status(channel,live)).eligible,true);await reconciliation.reconcile(liveRequest);
 record('reconciliation_live_worker',{pausedTransportCannotBeReleased:true,eligibleOnlyAfterReturn:true,reconciliationSendsNothing:true});
 // Original old-format reservations never gain clearance from an operator assertion.
 const legacy=await fixture();const legacyToken=await delivery.begin(channel,legacy,actor);await assert.rejects(async()=>reconciliation.reconcile({...await request(legacy),reservationId:legacyToken}),e=>e.status===409);await delivery.finish(channel,legacy,legacyToken);
 // Every durable write, including deleting the fence, must be confirmed and atomic.
 for(const target of ['operation','ledger','delete']){
  const q=await fixture();await send(q);const body=await request(q),auditBefore=await total();
  const event=target==='operation'?'UPDATE':target==='ledger'?'INSERT':'DELETE';
  const predicate=target==='ledger'?"NEW.idempotency_key LIKE 'delivery-resolution:%'":target==='delete'?"OLD.idempotency_key LIKE 'delivery:%'":"NEW.idempotency_key LIKE 'reply:%'";
  const returnRow=target==='delete'?'OLD':'NEW';
  await pool.query(`CREATE FUNCTION synthetic_suppress_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RETURN NULL; END IF; RETURN ${returnRow}; END $$`);
  await pool.query(`CREATE TRIGGER synthetic_suppress_reconcile BEFORE ${event} ON channel_idempotency_keys FOR EACH ROW EXECUTE FUNCTION synthetic_suppress_reconcile()`);
  try{await assert.rejects(()=>reconciliation.reconcile(body));}finally{await pool.query('DROP TRIGGER synthetic_suppress_reconcile ON channel_idempotency_keys');await pool.query('DROP FUNCTION synthetic_suppress_reconcile()');}
  assert.ok(await reconciliation.status(channel,q));assert.equal(await total(),auditBefore);assert.equal((await repository.claimState('reply:reconcile-key-'+q)).status,'unknown');
  assert.equal((await reconciliation.reconcile(body)).duplicate,false);assert.equal(await total(),auditBefore+1);
 }
 record('reconciliation_suppressed_writes',{operationUpdate:true,ledgerInsert:true,fenceDelete:true,allRolledBack:true,recovery:true});
 for(const fault of ['before','after']){
  const q=await fixture();await send(q);const body=await request(q),auditBefore=await total(),client=await runtime.connect(),original=client.query.bind(client);let injected=false;
  client.query=async(...args)=>{const sql=typeof args[0]==='string'?args[0]:args[0].text,commit=sql.trim().toLowerCase()==='commit';if(commit&&!injected&&fault==='before'){injected=true;throw Error('synthetic before commit');}const value=await original(...args);if(commit&&!injected&&fault==='after'){injected=true;throw Error('synthetic lost ack');}return value;};
  try{await assert.rejects(()=>new DbDeliveryReconciliation(drizzle(client)).reconcile(body));assert.equal(injected,true);}finally{client.query=original;client.release(true);}
  assert.equal((await reconciliation.reconcile(body)).duplicate,fault==='after');assert.equal(await total(),auditBefore+1);
 }
 record('reconciliation_commit_recovery',{beforeAndAfterCommit:true,singleAuditPerReservation:true,driverInjection:true});
 const known=await fixture();await repository.claim('reply:known-'+known,channel,known,'known-context');const kt=await delivery.begin(channel,known,actor,'reply:known-'+known);await delivery.settleUncertain(channel,known,kt,'synthetic-known-id');
 const kb={...await request(known),reservationId:kt};await assert.rejects(()=>reconciliation.reconcile(kb),e=>e.status===409);await assert.rejects(()=>reconciliation.reconcile({...kb,outcome:'accepted',messageId:'different'}),e=>e.status===409);
 await reconciliation.reconcile({...kb,outcome:'accepted',messageId:'synthetic-known-id'});
 record('reconciliation_known_acceptance',{cannotDeclareNotSent:true,requiresMatchingProviderId:true,doesNotInventDeliveredHistory:true,realMessages:0});
}
