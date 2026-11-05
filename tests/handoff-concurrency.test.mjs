import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryConversationStateRepository, changeConversationState, botMayReplyNow, stateKey } from '../lib/platform/conversation-state-service.ts';
import { loadConversationSummary } from '../lib/platform/copilot-summary-service.ts';
import { prepareSyntheticHandoffFixture } from '../lib/platform/synthetic-handoff-fixture.ts';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';
const actors=[{id:'synthetic-ana',name:'DEMO Ana',email:'ana@example.invalid',role:'Supervisor'},
  {id:'synthetic-bia',name:'DEMO Bia',email:'bia@example.invalid',role:'Supervisor'}];
const now=new Date('2026-11-05T15:00:00Z');
function fixture(){
 const plan=prepareSyntheticHandoffFixture({...stagingDemoRequirements,FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1'},now);
 const {channel,externalConversationId:id}=plan.message,repository=new MemoryConversationStateRepository();
 repository.conversations.set(stateKey(channel,id),plan.message.createdAt);
 const conversations={getMessages:async(c,i)=>{assert.equal(c,channel);assert.equal(i,id);return[plan.message];},getAudit:async()=>plan.outcome};
 const act=(action,actor,extra={})=>changeConversationState(repository,{channel,conversationId:id,action,actor,now:()=>now.getTime(),...extra});
 return{plan,channel,id,repository,conversations,act};
}
test('handoff → disputa de assumir → resumo tem um único responsável e IA permanece bloqueada',async()=>{
 const f=fixture();assert.match(await loadConversationSummary(f.conversations,f.repository,f.channel,f.id),/ainda não atribuído/);
 const results=await Promise.all(actors.map(actor=>f.act('claim',actor)));
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>!r.ok&&r.status===409).length,1);
 assert.equal(f.repository.audits.length,1);assert.equal(await botMayReplyNow(f.repository,f.channel,f.id),false);
 const owner=(await f.repository.get(f.channel,f.id)).assigneeId,winner=actors.find(a=>a.id===owner),loser=actors.find(a=>a.id!==owner);
 assert.match(await loadConversationSummary(f.conversations,f.repository,f.channel,f.id),new RegExp(`Responsável atual: ${winner.name}`));
 assert.equal((await f.act('claim',loser)).status,409);
 assert.equal((await f.act('claim',loser,{takeOver:true})).ok,true);
 assert.equal((await f.repository.get(f.channel,f.id)).assigneeId,loser.id);
 assert.equal(f.repository.audits.length,2);
 assert.match(f.repository.audits[1].reason,new RegExp(winner.name));
});
test('disputa sobre linha já existente não sobrescreve nem duplica auditoria',async()=>{
 const f=fixture();await f.act('claim',actors[0]);await f.act('release',actors[0]);
 const prior=f.repository.audits.length;const results=await Promise.all(actors.map(actor=>f.act('claim',actor)));
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>!r.ok&&r.status===409).length,1);
 assert.equal(f.repository.audits.length,prior+1);
});
test('concorrência em canais diferentes conserva responsáveis independentes',async()=>{
 const f=fixture(),other='synthetic-other-channel';f.repository.conversations.set(stateKey(other,f.id),f.plan.message.createdAt);
 const results=await Promise.all([f.act('claim',actors[0]),f.act('claim',actors[1],{channel:other})]);
 assert.ok(results.every(r=>r.ok));assert.equal((await f.repository.get(f.channel,f.id)).assigneeId,actors[0].id);
 assert.equal((await f.repository.get(other,f.id)).assigneeId,actors[1].id);
});

test('repositório PostgreSQL constrói INSERT sem takeover e UPDATE condicionado ao estado/canal completos',async()=>{
 const {DbConversationStateRepository}=await import('../lib/platform/conversation-state-service.ts');
 const {PgDialect}=await import('drizzle-orm/pg-core');const dialect=new PgDialect(),calls=[];
 let affected=[];
 const db={insert(){return{values(value){calls.push({kind:'insert',value});return{onConflictDoNothing(options){calls.at(-1).conflict=options;return{returning:async()=>affected};}};}};},
   update(){return{set(value){calls.push({kind:'update',value});return{where(condition){calls.at(-1).where=dialect.sqlToQuery(condition);return{returning:async()=>affected};}};}};}};
 const {conversationStates}=await import('../db/schema.ts');
 const repository=new DbConversationStateRepository(db);
 const unassigned={status:'open',assigneeId:null,assigneeName:null,assignedAt:null,resolvedAt:null,resolvedBy:null};
 const next={...unassigned,assigneeId:actors[0].id,assigneeName:actors[0].name,assignedAt:now.toISOString()};
 assert.equal(await repository.saveIfCurrent('synthetic-channel','synthetic-conversation',undefined,next),false);
 assert.deepEqual(calls[0].conflict.target,[conversationStates.channel,conversationStates.externalConversationId]);
 affected=[{id:'synthetic-conversation'}];assert.equal(await repository.saveIfCurrent('synthetic-channel','synthetic-conversation',unassigned,next),true);
 const where=calls[1].where;
 assert.deepEqual(where.params,['synthetic-channel','synthetic-conversation','open']);
 for(const field of ['assignee_id','assignee_name','assigned_at','resolved_at','resolved_by'])assert.match(where.sql,new RegExp(`"${field}" is null`));
 assert.match(where.sql,/"channel" = \$1/);assert.match(where.sql,/"external_conversation_id" = \$2/);
 affected=[];assert.equal(await repository.saveIfCurrent('synthetic-channel','synthetic-conversation',next,{...next,assigneeId:actors[1].id}),false);
 assert.ok(calls[2].where.params.includes(actors[0].id),'old owner remains part of compare');
});

test('falha de gravação não faz retry, auditoria ou retorno de sucesso',async()=>{
 const f=fixture();let writes=0;f.repository.saveIfCurrent=async()=>{writes++;throw new Error('synthetic-unknown-write');};
 await assert.rejects(f.act('claim',actors[0]),/synthetic-unknown-write/);assert.equal(writes,1);assert.equal(f.repository.audits.length,0);
});

test('POST real devolve 200/409 na disputa, conserva canal do servidor e resumo do vencedor',async()=>{
 const {readFileSync}=await import('node:fs');const {transformSync}=await import('esbuild');
 const {changeConversationState}=await import('../lib/platform/conversation-state-service.ts');
 const f=fixture(),modules={
  'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/db':{getDb:async()=>({})},
  '@/lib/platform/n8n-channel-service':{CHANNEL_NAME:f.channel},
  '@/lib/platform/session-guard':{authorize:async request=>{const actor=actors.find(a=>a.id===request.headers.get('x-test-actor'));return actor?{allowed:true,user:actor}:{allowed:false,status:401,error:'Sessão necessária'};}},
  '@/lib/platform/conversation-state-service':{changeConversationState,DbConversationStateRepository:class{constructor(){return f.repository;}}},
 };
 const compiled={exports:{}};const code=transformSync(readFileSync(new URL('../app/api/conversations/state/route.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
 new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];},compiled,compiled.exports);
 const request=actor=>new Request('https://synthetic.example.invalid/api/conversations/state',{method:'POST',headers:{'content-type':'application/json','x-test-actor':actor.id},body:JSON.stringify({conversationId:f.id,action:'claim',channel:'client-cannot-select-this-channel'})});
 const responses=await Promise.all(actors.map(actor=>compiled.exports.POST(request(actor))));
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 const result=await responses.find(r=>r.status===200).json();assert.equal(result.changed,true);
 const summary=await loadConversationSummary(f.conversations,f.repository,f.channel,f.id);assert.match(summary,new RegExp(result.state.assigneeName));
 assert.equal(await f.repository.get('client-cannot-select-this-channel',f.id),undefined);
 assert.equal(f.repository.audits.length,1);assert.equal(await botMayReplyNow(f.repository,f.channel,f.id),false);
});
