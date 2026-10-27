// Invented customer/contact fixtures; DDD00 is intentionally invalid for real outreach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { MemoryRecoveryCasesRepository, DbRecoveryCasesRepository } from '../lib/platform/recovery-cases-repository.ts';
import { createRecoveryCasesHandlers, mutateRecoveryCase, parseRecoveryCaseMutation, parseRecoveryCaseList, presentRecoveryCase, resolveRecoveryCaseScope } from '../lib/platform/recovery-cases-service.ts';

const now = new Date('2026-10-27T02:30:00Z'); // Brasília still26 October
const actor = { id:'operator-a', role:'Cobrança' };
const other = { id:'operator-b', role:'Supervisor' };
const scope = 'bbnet-test';
const protocol = '20261027000001';
const open = (over={}) => ({action:'open',customerId:'10',reason:'debt',idempotencyKey:'request-open-001',...over});
const source = { getCustomerRecord:async(id)=>({id}), getInvoiceForCustomer:async(customerId,id)=>({customerId,id,status:'A'}) };
const ticket = (over={}) => ({id:'ticket-1',seq:1,protocol,identification:'identified',ixcCustomerId:'10',channel:'n8n-whatsapp',externalConversationId:'5500000910001',...over});
function context() {
 const repo=new MemoryRecoveryCasesRepository();repo.owners.set(actor.id,'Operador sintético');
 const run=(input,options={})=>mutateRecoveryCase(repo,options.scope??scope,options.actor??actor,options.source===null?undefined:options.source??source,input,now);
 return {repo,run};
}
const status = expected => error => error.status===expected;
const command = (item,action,over={}) => ({caseId:item.id,version:item.version,idempotencyKey:`request-${action}-001`,action,...over});

test('open creates only scoped case and immutable operator event; no action receipt',async()=>{
 const {repo,run}=context();const result=await run(open());
 assert.equal(result.item.status,'open');assert.equal(result.item.version,1);assert.equal(result.item.ownerId,null);assert.equal(result.item.customerId,'10');
 assert.equal('scopeId' in result.item,false);assert.equal(repo.cases.size,1);assert.equal(repo.events.length,1);
 assert.equal(repo.events[0].actorId,actor.id);assert.equal(repo.events[0].evidence.receiptConfirmed,false);assert.equal(repo.events[0].evidence.provenance,'operator_report');
});

test('customer identity failures cannot create case or event',async()=>{
 for(const bad of [undefined,{id:'11'},{id:9007199254740992}]){
  const {repo,run}=context();await assert.rejects(()=>run(open(),{source:{...source,getCustomerRecord:async()=>bad}}),status(503));assert.equal(repo.cases.size,0);assert.equal(repo.events.length,0);
 }
 const {repo,run}=context();await assert.rejects(()=>run(open(),{source:null}),status(503));assert.equal(repo.cases.size,0);
 await assert.rejects(()=>run(open(),{source:{...source,getCustomerRecord:async()=>{throw new Error('secret');}}}),e=>e.status===503&&!e.message.includes('secret'));
});

test('one active case per installation/customer, including concurrent open',async()=>{
 const {repo,run}=context();const results=await Promise.allSettled([run(open()),run(open({idempotencyKey:'request-open-002'}))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
 assert.equal(repo.cases.size,1);assert.equal(repo.events.length,1);
});

test('scopes isolate list detail history and idempotency; same customer can exist separately',async()=>{
 const {repo,run}=context();const first=await run(open());const second=await run(open(),{scope:'other-installation'});
 assert.notEqual(first.item.id,second.item.id);assert.equal((await repo.list(scope,{page:1,pageSize:20,status:'all'})).total,1);
 assert.equal(await repo.get('other-installation',first.item.id),undefined);assert.deepEqual(await repo.history('other-installation',first.item.id,100),[]);
 await assert.rejects(()=>run(command(first.item,'note',{text:'not mine'}),{scope:'other-installation'}),status(404));
 assert.equal(repo.events.length,2);
});

test('same-key replay precedes stale version and source availability without repeating mutation',async()=>{
 const {repo,run}=context();const created=await run(open());const request=command(created.item,'claim');await run(request);
 const result=await run(request,{source:null});assert.equal(result.replay,true);assert.equal(result.item.version,2);assert.equal(repo.events.length,2);
 const oldOpen=await run(open(),{source:null});assert.equal(oldOpen.replay,true);assert.equal(oldOpen.item.version,2);
});

test('idempotency fingerprint binds actor, scope, action, version and normalized payload',async()=>{
 const {repo,run}=context();const created=await run(open());
 await assert.rejects(()=>run(open(),{actor:other}),status(409));
 await assert.rejects(()=>run(open({reason:'both'})),status(409));
 const request=command(created.item,'note',{text:' Nota '});await run(request);
 assert.equal((await run({...request,text:'Nota'})).replay,true);
 for(const changed of [{...request,text:'Outra nota'},{...request,version:2},{...request,action:'close',reason:'Fim',text:undefined}]){
  await assert.rejects(()=>run(changed),error=>[400,409].includes(error.status));
 }
 assert.equal(repo.events.length,2);
});

test('stale version and competing owners cannot overwrite or append phantom events',async()=>{
 const {repo,run}=context();const {item}=await run(open());
 const results=await Promise.allSettled([run(command(item,'claim')),run(command(item,'claim',{idempotencyKey:'request-claim-other'}),{actor:other})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(repo.events.length,2);assert.equal((await repo.get(scope,item.id)).version,2);
 await assert.rejects(()=>run(command(item,'schedule',{nextActionOn:'2026-10-28'})),status(409));assert.equal(repo.events.length,2);
});

test('taking over needs explicit confirmation and records prior operator',async()=>{
 const {repo,run}=context();const created=await run(open());const claimed=await run(command(created.item,'claim'));
 await assert.rejects(()=>run(command(claimed.item,'claim',{idempotencyKey:'request-second-claim'}),{actor:other}),status(409));
 const result=await run(command(claimed.item,'claim',{idempotencyKey:'request-second-claim',takeOver:true}),{actor:other});
 assert.equal(result.item.ownerId,other.id);assert.equal(repo.events.at(-1).evidence.previousOwnerId,actor.id);
});

test('event failure rolls back case creation and mutation in memory transaction',async()=>{
 const {repo,run}=context();repo.failAppend=true;await assert.rejects(()=>run(open()));assert.equal(repo.cases.size,0);assert.equal(repo.events.length,0);
 repo.failAppend=false;const created=await run(open());repo.failAppend=true;await assert.rejects(()=>run(command(created.item,'claim')));
 assert.equal((await repo.get(scope,created.item.id)).version,1);assert.equal((await repo.get(scope,created.item.id)).ownerId,null);assert.equal(repo.events.length,1);
});

test('optional presentation failures happen after commit, including transaction-level replay',async()=>{
 const {repo,run}=context();const created=await run(open());
 let insideTransaction=false;const observed=[];const transaction=repo.transaction.bind(repo);
 repo.transaction=fn=>transaction(async tx=>{insideTransaction=true;try{return await fn(tx);}finally{insideTransaction=false;}});
 repo.ownerName=async()=>{observed.push(insideTransaction);throw new Error('synthetic optional lookup unavailable');};
 const claimed=await run(command(created.item,'claim'));assert.equal(claimed.item.ownerName,null);assert.equal(claimed.item.version,2);
 assert.equal(repo.events.length,2);assert.deepEqual(observed,[false]);
 const eventByKey=repo.eventByKey.bind(repo);let lookup=0;
 // Simulate an event committed between the outer replay check and the transaction.
 repo.eventByKey=(...args)=>++lookup===1?Promise.resolve(undefined):eventByKey(...args);
 const repeated=await run(open());assert.equal(repeated.replay,true);assert.equal(repo.events.length,2);
 assert.deepEqual(observed,[false,false]);assert.equal((await repo.get(scope,created.item.id)).ownerId,actor.id);
});

test('schedule validates calendar in business timezone and notes remain operator reports',async()=>{
 const {repo,run}=context();const created=await run(open());
 for(const value of ['2026-02-30','2026-10-25','2026-13-01','2026-10-27T12:00:00Z']) await assert.rejects(()=>run(command(created.item,'schedule',{nextActionOn:value})),status(400));
 const scheduled=await run(command(created.item,'schedule',{nextActionOn:'2026-10-26'}));assert.equal(scheduled.item.nextActionOn,'2026-10-26');assert.equal(scheduled.item.status,'waiting');
 await run(command(scheduled.item,'note',{text:'Relato: pago; email teste@example.invalid e telefone5500000910001.'}));
 const event=repo.events.at(-1);assert.equal(event.evidence.receiptConfirmed,false);assert.equal(event.evidence.provenance,'operator_report');assert.ok(!event.evidence.text.includes('teste@example.invalid'));
});

test('close and reopen preserve history and never claim verified payment',async()=>{
 const {repo,run}=context();const created=await run(open());const close=command(created.item,'close',{reason:'Operador concluiu acompanhamento'});
 const closed=await run(close);assert.equal(closed.item.status,'closed');assert.ok(closed.item.closedAt);assert.equal(repo.events.at(-1).evidence.outcomeVerified,false);
 assert.equal((await run(close)).replay,true);await assert.rejects(()=>run(command(closed.item,'note',{text:'não pode'})),status(409));
 const reopened=await run(command(closed.item,'reopen'));assert.equal(reopened.item.status,'open');assert.equal(reopened.item.closedAt,null);assert.equal(reopened.item.closingReason,null);assert.equal(repo.events.length,3);
});

test('reopen fails atomically if a later active case exists',async()=>{
 const {repo,run}=context();const created=await run(open());const closed=await run(command(created.item,'close',{reason:'fim'}));
 await run(open({idempotencyKey:'request-new-case'}));const count=repo.events.length;
 await assert.rejects(()=>run(command(closed.item,'reopen')),status(409));assert.equal((await repo.get(scope,closed.item.id)).status,'closed');assert.equal(repo.events.length,count);
});

test('invoice link uses exact customer pair, keeps unknown status unknown and no receipt claim',async()=>{
 const {repo,run}=context();const created=await run(open());let seen;
 const src={...source,getInvoiceForCustomer:async(...args)=>{seen=args;return {id:'901',customerId:'10',status:'unknown'};}};
 const linked=await run(command(created.item,'link_invoice',{invoiceId:'901'}),{source:src});assert.deepEqual(seen.slice(0,2),['10','901']);assert.deepEqual(linked.item.invoiceIds,['901']);
 assert.equal(repo.events.at(-1).evidence.statusCode,'unknown');assert.equal(repo.events.at(-1).evidence.receiptConfirmed,false);
 await assert.rejects(()=>run(command(linked.item,'link_invoice',{invoiceId:'902',idempotencyKey:'request-foreign'}),{source:{...source,getInvoiceForCustomer:async()=>({id:'902',customerId:'other',status:'R'})}}),status(503));
 assert.equal(repo.events.length,2);
});

test('invoice and promise links are bounded and duplicates rejected',async()=>{
 const {repo,run}=context();let {item}=await run(open());
 for(let i=0;i<20;i++)({item}=await run(command(item,'link_invoice',{invoiceId:String(100+i),idempotencyKey:`request-invoice-${i}`})));
 await assert.rejects(()=>run(command(item,'link_invoice',{invoiceId:'999',idempotencyKey:'request-over-limit'})),status(409));
 assert.equal(item.invoiceIds.length,20);assert.equal(repo.events.length,21);
 await assert.rejects(()=>run(command(item,'link_invoice',{invoiceId:'100',idempotencyKey:'request-duplicate'})),status(409));
});

test('promise requires same customer and fresh exact invoice; changed legacy link rolls back',async()=>{
 const {repo,run}=context();const {item}=await run(open());repo.promises.set('promise-1',{id:'promise-1',customerId:'11',invoiceId:'901',status:'pending'});
 await assert.rejects(()=>run(command(item,'link_promise',{promiseId:'promise-1'})),status(409));
 repo.promises.set('promise-1',{id:'promise-1',customerId:'10',invoiceId:'901',status:'pending'});
 await assert.rejects(()=>run(command(item,'link_promise',{promiseId:'promise-1'}),{source:{...source,getInvoiceForCustomer:async()=>{repo.promises.get('promise-1').customerId='11';return {id:'901',customerId:'10',status:'A'};}}}),status(409));
 assert.equal(repo.events.length,1);repo.promises.get('promise-1').customerId='10';const linked=await run(command(item,'link_promise',{promiseId:'promise-1'}));assert.deepEqual(linked.item.promiseIds,['promise-1']);assert.equal(repo.events.at(-1).evidence.receiptConfirmed,false);
});

test('visible Attendance protocol resolves only identified same customer and read revalidates navigation',async()=>{
 const {repo,run}=context();const {item}=await run(open());
 const generic='Atendimento não encontrado ou não confirmado para este cliente.';
 await assert.rejects(()=>run(command(item,'link_attendance',{protocol})),error=>error.status===409&&error.message===generic);
 for(const over of [{ixcCustomerId:'11'},{identification:'unavailable'},{protocol:null},{protocol:'20261027000002'},{channel:'unknown'},{externalConversationId:'120123@g.us'}]){
  repo.tickets.set('ticket-1',ticket(over));await assert.rejects(()=>run(command(item,'link_attendance',{protocol})),error=>error.status===409&&error.message===generic);
 }
 repo.tickets.set('ticket-1',ticket());const linked=await run(command(item,'link_attendance',{protocol}));
 assert.equal(linked.item.attendanceTicketId,'ticket-1');assert.deepEqual(linked.item.attendance,{ticketId:'ticket-1',protocol,channel:'n8n-whatsapp',conversationId:'5500000910001'});
 assert.equal(repo.events.at(-1).evidence.protocol,protocol);assert.equal(repo.events.at(-1).evidence.receiptConfirmed,false);
 assert.equal('conversationId' in [...repo.cases.values()][0],false);assert.ok(!JSON.stringify(repo.events).includes('5500000910001'));
 repo.tickets.get('ticket-1').ixcCustomerId='11';assert.equal((await presentRecoveryCase(repo,await repo.get(scope,item.id))).attendance,null);
});

test('Attendance protocol link rejects ambiguity, changed protocol/customer/ID and arbitrary ID bypass atomically',async()=>{
 for(const change of [row=>{row.protocol='20261027000002';},row=>{row.ixcCustomerId='11';},row=>{row.id='ticket-replaced';},row=>{row.identification='unidentified';}]){
  const {repo,run}=context();const {item}=await run(open());repo.tickets.set('ticket-1',ticket());
  const changingSource={...source,getCustomerRecord:async id=>{change(repo.tickets.get('ticket-1'));return {id};}};
  await assert.rejects(()=>run(command(item,'link_attendance',{protocol}),{source:changingSource}),status(409));
  assert.equal(repo.events.length,1);assert.equal((await repo.get(scope,item.id)).attendanceTicketId,null);
 }
 const {repo,run}=context();const {item}=await run(open());repo.tickets.set('ticket-1',ticket());repo.tickets.set('ticket-2',ticket({id:'ticket-2'}));
 await assert.rejects(()=>run(command(item,'link_attendance',{protocol})),status(409));
 for(const payload of [{ticketId:'ticket-1'},{protocol,ticketId:'ticket-1'},{protocol:'ticket-1'},{protocol:'1'},{protocol:'1 OR 1=1'}]){
  await assert.rejects(()=>run(command(item,'link_attendance',payload)),status(400));
 }
 assert.equal(repo.events.length,1);
});

test('historical Attendance link exposes navigation only while the latest exact conversation identifies the same customer',async()=>{
 const {repo,run}=context();const {item}=await run(open());repo.tickets.set('ticket-1',ticket());
 const linked=await run(command(item,'link_attendance',{protocol}));const stored=await repo.get(scope,item.id);assert.ok(linked.item.attendance);
 const later=ticket({id:'ticket-latest',seq:2,protocol:'20261027000002',ixcCustomerId:'11'});repo.tickets.set(later.id,later);
 assert.equal((await presentRecoveryCase(repo,stored)).attendance,null);assert.equal(stored.attendanceTicketId,'ticket-1');
 later.ixcCustomerId='10';later.identification='unavailable';assert.equal((await presentRecoveryCase(repo,stored)).attendance,null);
 later.identification='identified';assert.equal((await presentRecoveryCase(repo,stored)).attendance.protocol,protocol);
 // Another conversation/channel, even with a higher sequence, must not affect this one.
 repo.tickets.set('unrelated',ticket({id:'unrelated',seq:99,ixcCustomerId:'11',externalConversationId:'5500000910002'}));
 repo.tickets.set('other-channel',ticket({id:'other-channel',seq:100,ixcCustomerId:'11',channel:'other'}));assert.ok((await presentRecoveryCase(repo,stored)).attendance);
 repo.latestAttendance=async()=>undefined;assert.equal((await presentRecoveryCase(repo,stored)).attendance,null);
 repo.latestAttendance=async()=>{throw new Error('synthetic unavailable');};assert.equal((await presentRecoveryCase(repo,stored)).attendance,null);
});

test('mutation parser rejects spoofed scope actor receipt and prototype action fields',()=>{
 for(const extra of [{scopeId:'other'},{tenantId:'other'},{ownerId:'other'},{actorId:'other'},{receiptConfirmed:true},{conversationId:'other'}]) assert.throws(()=>parseRecoveryCaseMutation(open(extra)),status(400));
 for(const action of ['toString','__proto__','constructor','delete'])assert.throws(()=>parseRecoveryCaseMutation({action,idempotencyKey:'request-invalid'}),status(400));
 for(const value of ['0','01','-1','1e2','1 OR 1=1'])assert.throws(()=>parseRecoveryCaseMutation(open({customerId:value})),status(400));
});

function handlers(ctx,over={}){
 return createRecoveryCasesHandlers({authorize:async()=>({allowed:true,user:actor}),getRepository:async()=>ctx.repo,getSource:()=>source,getScope:()=>scope,now:()=>now,...over});
}
const request=(body)=>new Request('http://test/api/billing/recovery/cases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('HTTP requires session and permission before resolving scope repository or source',async()=>{
 for(const user of [undefined,{id:'readonly',role:'Somente leitura'}]){
  const h=handlers(context(),{authorize:async()=>({allowed:true,user}),getRepository:()=>assert.fail('noDB'),getSource:()=>assert.fail('noIXC')});
  assert.equal((await h.POST(request(open()))).status,user?403:401);
  if(!user)assert.equal((await h.GET(new Request('http://test/api/billing/recovery/cases'))).status,401);
 }
});

test('HTTP Attendance protocol mutation cannot bypass write permission or expose another customer',async()=>{
 const ctx=context();const {item}=await ctx.run(open());ctx.repo.tickets.set('ticket-1',ticket({ixcCustomerId:'11'}));
 const readonly=handlers(ctx,{authorize:async()=>({allowed:true,user:{id:'reader',role:'Somente leitura'}}),getRepository:()=>assert.fail('noDB'),getSource:()=>assert.fail('noIXC')});
 assert.equal((await readonly.POST(request(command(item,'link_attendance',{protocol})))).status,403);
 const h=handlers(ctx);const mismatched=await h.POST(request(command(item,'link_attendance',{protocol})));const mismatchBody=await mismatched.json();
 ctx.repo.tickets.clear();const absent=await h.POST(request(command(item,'link_attendance',{protocol})));assert.equal(mismatched.status,409);assert.equal(absent.status,409);assert.deepEqual(await absent.json(),mismatchBody);
 assert.equal((await h.POST(request(command(item,'link_attendance',{ticketId:'ticket-1'})))).status,400);
 assert.equal(ctx.repo.events.length,1);
});

test('missing or invalid installation scope fails closed without DB',async()=>{
 for(const value of [undefined,'','xx','../other']){
  const h=handlers(context(),{getScope:()=>value,getRepository:()=>assert.fail('noDB')});
  const get=await h.GET(new Request('http://test/api/billing/recovery/cases'));assert.equal((await get.json()).available,false);
  assert.equal((await h.POST(request(open()))).status,503);
 }
 assert.equal(resolveRecoveryCaseScope({RECOVERY_CASE_SCOPE_ID:' bbnet-test '}),'bbnet-test');
});

test('HTTP lifecycle and scoped pagination/details expose bounded safe history',async()=>{
 const ctx=context(), h=handlers(ctx);const created=await h.POST(request(open()));assert.equal(created.status,201);const {item}=await created.json();
 const list=await h.GET(new Request('http://test/api/billing/recovery/cases?page=1&pageSize=1&tenantId=other'));const body=await list.json();assert.equal(body.items.length,1);assert.equal(body.canWrite,true);assert.equal(body.currentActorId,actor.id);assert.equal(list.headers.get('cache-control'),'private, no-store');
 const detail=await (await h.GET(new Request(`http://test/api/billing/recovery/cases?id=${item.id}`))).json();assert.equal(detail.events.length,1);assert.equal('idempotencyKey' in detail.events[0],false);assert.equal('requestHash' in detail.events[0],false);assert.equal('scopeId' in detail.events[0],false);
 const otherScope=handlers(ctx,{getScope:()=> 'other-installation'});assert.equal((await otherScope.GET(new Request(`http://test/api/billing/recovery/cases?id=${item.id}`))).status,404);
 assert.equal((await (await otherScope.GET(new Request('http://test/api/billing/recovery/cases'))).json()).total,0);
 for(let i=0;i<105;i++)ctx.repo.events.push({...ctx.repo.events[0],id:`event-${i}`,idempotencyKey:`history-${i}`});
 const limited=await (await h.GET(new Request(`http://test/api/billing/recovery/cases?id=${item.id}`))).json();assert.equal(limited.events.length,100);assert.equal(limited.historyTruncated,true);
 const readOnly=handlers(ctx,{authorize:async()=>({allowed:true,user:{id:'reader',role:'Somente leitura'}})});assert.equal((await (await readOnly.GET(new Request('http://test/api/billing/recovery/cases'))).json()).canWrite,false);
});

test('pagination inputs are bounded and explicit invalid values fail',()=>{
 for(const query of ['page=0','page=-1','page=100001','pageSize=51','pageSize=1.5','customerId=abc','status=deleted'])assert.throws(()=>parseRecoveryCaseList(new URLSearchParams(query)),status(400));
 assert.deepEqual(parseRecoveryCaseList(new URLSearchParams()),{page:1,pageSize:20,status:'active'});
});

test('Postgres adapter SQL scopes every new-table query and UPDATE includes version CAS',async()=>{
 const calls=[];const db=drizzle({client:{async query(config,parameters){calls.push({sql:typeof config==='string'?config:config.text,parameters});return {rows:[]};}}});
 const repo=new DbRecoveryCasesRepository(db);
 await repo.get(scope,'case-1');await repo.history(scope,'case-1',999);await repo.eventByKey(scope,'key-1');await repo.list(scope,{page:2,pageSize:20,status:'active'});await repo.update(scope,'case-1',3,{status:'waiting',nextActionOn:'2026-10-28'});
 for(const call of calls)assert.match(call.sql,/"scope_id" = \$/);
 assert.deepEqual(calls[0].parameters,[scope,'case-1',1]);assert.ok(calls[1].parameters.includes(101));
 const update=calls.at(-1);assert.match(update.sql,/"version" = "recovery_cases"\."version" \+ 1/);assert.match(update.sql,/where .*"scope_id" = .*"id" = .*"version" =/);assert.deepEqual(update.parameters.slice(-3),[scope,'case-1',3]);
});

test('DB transaction wraps changes and events in same client, commits or rolls back',async()=>{
 const calls=[];const client={async query(config,parameters){const query=typeof config==='string'?config:config.text;calls.push({sql:query,parameters});return {rows:[]};}};
 const repo=new DbRecoveryCasesRepository(drizzle({client}));
 await repo.transaction(async tx=>{await tx.update(scope,'case-1',1,{status:'waiting'});await tx.append({id:'event',scopeId:scope,caseId:'case-1',type:'note',actorId:actor.id,createdAt:now.toISOString(),correlationId:'corr',idempotencyKey:'request-event',requestHash:'hash',evidence:{receiptConfirmed:false}});});
 assert.equal(calls[0].sql,'begin');assert.equal(calls.at(-1).sql,'commit');assert.match(calls[1].sql,/update "recovery_cases"/);assert.match(calls[2].sql,/insert into "recovery_case_events"/);
 calls.length=0;await assert.rejects(()=>repo.transaction(async tx=>{await tx.update(scope,'case-1',1,{status:'waiting'});throw new Error('test');}));assert.equal(calls.at(-1).sql,'rollback');
});

test('Attendance protocol SQL filters exact protocol customer and identified status before returning a ticket',async()=>{
 const calls=[];const repo=new DbRecoveryCasesRepository(drizzle({client:{async query(config,parameters){calls.push({sql:config.text,parameters});return {rows:[]};}}}));
 assert.equal(await repo.attendanceByProtocolForCustomer(protocol,'10'),undefined);
 assert.match(calls[0].sql,/where .*"protocol" = .*"ixc_customer_id" = .*"identification" =/);assert.deepEqual(calls[0].parameters,[protocol,'10','identified',2]);
 await repo.latestAttendance('n8n-whatsapp','5500000910001');
 assert.match(calls[1].sql,/where .*"channel" = .*"external_conversation_id" = .*order by "support_tickets"\."seq" desc limit/);
 assert.deepEqual(calls[1].parameters,['n8n-whatsapp','5500000910001',1]);assert.doesNotMatch(calls[1].sql.split(' where ')[1],/identification|ixc_customer_id/);
});

test('additive migration establishes composite uniqueness before scoped FK and active uniqueness',async()=>{
 const sql=await readFile(new URL('../drizzle/0021_supervised_recovery_cases.sql',import.meta.url),'utf8');
 assert.match(sql,/CONSTRAINT "recovery_cases_scope_id" UNIQUE\("scope_id","id"\)/);
 assert.ok(sql.indexOf('CONSTRAINT "recovery_cases_scope_id" UNIQUE')<sql.indexOf('ADD CONSTRAINT "recovery_case_events_scope_case_fk"'));
 assert.match(sql,/UNIQUE INDEX "recovery_cases_one_active_customer".*\("scope_id","customer_id"\).*<> 'closed'/);
 assert.match(sql,/UNIQUE INDEX "recovery_case_events_idempotency".*\("scope_id","idempotency_key"\)/);
 assert.match(sql,/FOREIGN KEY \("scope_id","case_id"\).*\("scope_id","id"\)/);
 assert.doesNotMatch(sql,/DROP |ALTER TABLE "(?:payment_promises|support_tickets|users)"/);
});
