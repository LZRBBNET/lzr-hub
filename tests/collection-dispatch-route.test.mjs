import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {MemoryAuthRepository,hashToken} from '../lib/platform/auth.ts';
import {MemoryCollectionRulesRepository} from '../lib/platform/collection-rules-service.ts';
import {MemoryCollectionDispatchRepository} from '../lib/platform/collection-dispatch-service.ts';
import {MemoryPaymentPromiseRepository} from '../lib/platform/payment-promise-service.ts';
import {IxcReadonlyProvider} from '../lib/integrations/ixc/readonly-provider.ts';
import {IxcInvoiceMapper} from '../lib/integrations/ixc/mappers.ts';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const fixed=Date.parse('2026-11-13T15:00:00.000Z'),token='SYNTHETIC_DISPATCH_SESSION',key='__dispatchRouteFixture';
const real=(path)=>JSON.stringify(root+path);
const source={
 db:`export const getDb=async()=>globalThis.${key}.db;`,
 auth:`export * from ${real('lib/platform/auth.ts')}; export class DbAuthRepository{constructor(){return globalThis.${key}.auth;}}`,
 rules:`export class DbCollectionRulesRepository{constructor(){return globalThis.${key}.rules;}}`,
 ledger:`export * from ${real('lib/platform/collection-dispatch-service.ts')}; export class DbCollectionDispatchRepository{constructor(){return globalThis.${key}.ledger;}}`,
 promises:`export class DbPaymentPromiseRepository{constructor(){return globalThis.${key}.promises;}}`,
 runtime:`export function getIxcRuntime(){const f=globalThis.${key};return {config:{ixcAllowlist:f.scope},provider:f.provider};}`,
 audit:`export async function logUnauthenticatedAction(entry){globalThis.${key}.audits.push(entry);}`,
 queue:`export async function executeQueueAction(action){const f=globalThis.${key};f.queueAttempts++;if(f.queueFailure)throw Error('SYNTHETIC_QUEUE_UNCERTAIN');f.jobs.push(structuredClone(action.job));return {ok:true};}`,
};
const aliases={'@/db':'db','@/lib/integrations/ixc/runtime':'runtime','@/lib/platform/collection-rules-service':'rules','@/lib/platform/collection-dispatch-service':'ledger','@/lib/platform/payment-promise-service':'promises','@/lib/platform/audit-log':'audit'};
const built=await build({stdin:{contents:"export{GET,POST}from'./app/api/billing/collections/dispatch/route';",resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,packages:'external',logLevel:'silent',plugins:[{name:'synthetic-repositories-source-and-queue',setup(b){
 b.onResolve({filter:/^@\//},a=>aliases[a.path]?{path:aliases[a.path],namespace:'fixture'}:undefined);
 b.onResolve({filter:/^(?:\.\.\/)+db\/index\.ts$/},()=>({path:'db',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/auth\.ts$/},()=>({path:'auth',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/queue-service\.ts$/},()=>({path:'queue',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:source[a.path],loader:'js',resolveDir:root}));
}}]});
const compiled={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(require,compiled,compiled.exports);
const handler=compiled.exports;
const promise={invoiceId:'901',customerId:'10',promisedFor:'2026-11-13',registeredBy:'actor@example.invalid',correlationId:'synthetic'};
async function harness(t,run){
 t.mock.timers.enable({apis:['Date'],now:fixed});
 const old={auth:process.env.FEATURE_AUTH,fixture:globalThis[key],fetch:globalThis.fetch};process.env.FEATURE_AUTH='true';
 const f={db:{synthetic:true},auth:new MemoryAuthRepository(),rules:new MemoryCollectionRulesRepository(),ledger:new MemoryCollectionDispatchRepository(),promises:new MemoryPaymentPromiseRepository(),jobs:[],audits:[],scope:['10'],reads:[],queueAttempts:0,raw:{id:'901',id_cliente:'10',status:'A',data_vencimento:'2026-11-10',valor_aberto:'50'},fault:null,onFresh:null,onRules:null};
 f.auth.users.push({id:'synthetic-actor',email:'actor@example.invalid',name:'Operador fictício',role:'Supervisor',active:true,passwordHash:'unused',passwordSalt:'unused'});
 await f.auth.createSession(hashToken(token),'synthetic-actor','2026-11-14T15:00:00.000Z');
 await f.rules.saveVersion({name:'Régua fictícia',steps:[{offsetDays:3,channel:'WhatsApp',templateId:'synthetic-no-contact',attempts:1,active:true}]},'synthetic-actor');
 const getRule=f.rules.getLatest.bind(f.rules);f.rules.getLatest=async()=>{const result=await getRule();if(f.onRules)await f.onRules();return result;};
 f.provider=new IxcReadonlyProvider({baseUrl:'https://fixture.invalid',token:'SYNTHETIC_NOT_A_CREDENTIAL',allowedCustomerIds:['10'],retryLimit:0,rateLimitPerMinute:1000,fetcher:async(url,init)=>{
  const resource=new URL(url).pathname.split('/').at(-1),query=JSON.parse(init.body);f.reads.push({resource,fresh:!!query.grid_param});
  if(resource==='cliente')return Response.json({registros:[{id:'10',razao:'Cadastro inteiramente fictício',ativo:'S'}],total:1});
  if(resource!=='fn_areceber')return Response.json({registros:[],total:0});
  if(query.grid_param){if(f.onFresh)await f.onFresh();if(f.fault==='unavailable')return new Response(null,{status:503});}
  let rows=f.raw.status==='A'||!query.grid_param?[structuredClone(f.raw)]:[];
  if(query.grid_param&&f.fault==='foreign')rows=[{...f.raw,id_cliente:'20'}];
  return Response.json({registros:rows,...(query.grid_param&&f.fault==='missing-total'?{}:{total:query.grid_param&&f.fault==='partial'?21:rows.length})});
 }});
 globalThis[key]=f;globalThis.fetch=()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN');};
 try{
  await f.provider.getSnapshot('10','synthetic-prime');assert.equal((await f.provider.getSnapshot('10','synthetic-cache')).cache,'hit');f.reads=[];
  const request=(method='POST',authenticated=true)=>new Request('https://fixture.invalid/api/billing/collections/dispatch',{method,headers:{...(authenticated?{cookie:'lzr_session='+token}:{}),'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({action:'run'})}:{})});
  const post=async(authenticated=true)=>handler.POST(request('POST',authenticated));
  await run(f,{post,get:()=>handler.GET(request('GET'))});
 }finally{globalThis.fetch=old.fetch;globalThis[key]=old.fixture;if(old.auth===undefined)delete process.env.FEATURE_AUTH;else process.env.FEATURE_AUTH=old.auth;}
}

test('application action pauses a promise created after an earlier open preview',t=>harness(t,async(f,{get,post})=>{
 assert.equal((await(await get()).json()).today.candidates,1);await f.promises.create(promise);
 const response=await post();assert.equal(response.status,200);const body=await response.json();assert.equal(body.recorded,0);assert.equal(body.pausedByPromise,1);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,0);
}));
test('application action ignores cached open snapshot after confirmed synthetic payment',t=>harness(t,async(f,{get,post})=>{
 assert.equal((await(await get()).json()).today.candidates,1);f.raw={...f.raw,status:'R',valor_aberto:'0'};
 const response=await post();assert.equal(response.status,200);assert.equal((await response.json()).recorded,0);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,0);
}));
for(const fault of ['unavailable','missing-total','partial','foreign'])test(`application refuses fresh ${fault} before ledger or queue`,t=>harness(t,async(f,{post})=>{
 f.fault=fault;const response=await post();assert.equal(response.status,503);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,0);
}));
for(const raw of [{valor_aberto:'0'},{valor_aberto:'unknown'},{valor_aberto:undefined,valor:'50'}])test(`application refuses unconfirmed balance ${JSON.stringify(raw)}`,t=>harness(t,async(f,{post})=>{
 f.raw={...f.raw,...raw};const response=await post();assert.equal(response.status,503);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,0);
}));
test('real authorization rejects anonymous and read-only before source or ledger',t=>harness(t,async(f,{post})=>{
 assert.equal((await post(false)).status,401);f.auth.users[0].role='Somente leitura';assert.equal((await post()).status,403);assert.equal(f.reads.length,0);assert.equal(f.ledger.rows.length,0);assert.equal(f.queueAttempts,0);
}));
for(const change of ['logout','role'])test(`authorization is rechecked after awaited rule read: ${change}`,t=>harness(t,async(f,{post})=>{
 f.onRules=async()=>{if(change==='logout')await f.auth.deleteSession(hashToken(token));else f.auth.users[0].role='Somente leitura';};
 const response=await post();assert.equal(response.status,change==='logout'?401:403);assert.equal(f.ledger.rows.length,0);assert.equal(f.queueAttempts,0);
}));
test('promise recorded during fresh source read is seen before reservation',t=>harness(t,async(f,{post})=>{
 f.onFresh=async()=>{await f.promises.create(promise);f.onFresh=null;};const response=await post();assert.equal(response.status,200);assert.equal((await response.json()).pausedByPromise,1);assert.equal(f.ledger.rows.length,0);assert.equal(f.jobs.length,0);
}));
test('eligible control and concurrent repeat record and enqueue one intent in memory',t=>harness(t,async(f,{post})=>{
 const responses=await Promise.all([post(),post()]);const bodies=await Promise.all(responses.map(r=>r.json()));assert.ok(responses.every(r=>r.status===200));assert.equal(bodies.reduce((n,x)=>n+x.recorded,0),1);assert.equal(bodies.reduce((n,x)=>n+x.duplicates,0),1);assert.equal(f.ledger.rows.length,1);assert.equal(f.jobs.length,1);
 assert.equal(f.jobs[0].payload.schemaVersion,1);assert.equal(f.jobs[0].payload.ruleId,(await f.rules.getLatest()).id);
}));
test('uncertain queue failure retains ledger and repeat never retries that intent',t=>harness(t,async(f,{post})=>{
 f.queueFailure=true;assert.equal((await post()).status,200);assert.equal(f.queueAttempts,1);assert.equal(f.ledger.rows.length,1);
 assert.equal((await post()).status,200);assert.equal(f.queueAttempts,1);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,1);
}));
async function consumeCaptured(f,state){
 const {createProcessor}=await import('../services/queue-runtime/src/processor.mjs');let continuations=0;
 const queued=f.jobs[0];const job={queueName:queued.queue,name:queued.name,data:{idempotencyKey:queued.idempotencyKey,payload:queued.payload}};
 const processor=createProcessor('billing-reminders',{now:()=>new Date(fixed),readEvidence:async context=>({complete:true,observedAt:new Date(fixed).toISOString(),invoice:IxcInvoiceMapper.map(state),intent:{...context,offsetDays:queued.payload.offsetDays,active:true,current:true,cancelled:false},promises:{complete:true,customerId:context.customerId,invoiceId:context.invoiceId,items:await f.promises.listByCustomer(context.customerId)}}),continueEligible:async()=>{continuations++;return{simulationOnly:true,delivered:false,enqueued:0};}});
 return {run:()=>processor(job),count:()=>continuations};
}
test('actual application intent is blocked by consumer after payment before processing',t=>harness(t,async(f,{post})=>{
 assert.equal((await post()).status,200);assert.equal(f.jobs.length,1);const consumer=await consumeCaptured(f,{...f.raw,status:'R',valor_aberto:'0'});await assert.rejects(consumer.run,e=>e.code==='BILLING_INVOICE_NOT_OPEN');assert.equal(consumer.count(),0);
}));
test('promise after route read remains a residual window; consumer still blocks captured intent',t=>harness(t,async(f,{post})=>{
 const record=f.ledger.record.bind(f.ledger);f.ledger.record=async entries=>{await f.promises.create(promise);return record(entries);};
 assert.equal((await post()).status,200);assert.equal(f.jobs.length,1);const consumer=await consumeCaptured(f,f.raw);await assert.rejects(consumer.run,e=>e.code==='BILLING_PROMISE_ACTIVE');assert.equal(consumer.count(),0);
}));
test('captured eligible intent reaches only synthetic continuation; zero never becomes payment',t=>harness(t,async(f,{post})=>{
 await post();const eligible=await consumeCaptured(f,f.raw);assert.deepEqual(await eligible.run(),{simulationOnly:true,delivered:false,enqueued:0});assert.equal(eligible.count(),1);
 const zero=await consumeCaptured(f,{...f.raw,valor_aberto:'0'});await assert.rejects(zero.run,e=>e.code==='BILLING_INVOICE_BALANCE_UNCONFIRMED');assert.equal(zero.count(),0);
}));

test('preview does not release counts after session revocation during rule read',t=>harness(t,async(f,{get})=>{
 f.onRules=()=>f.auth.deleteSession(hashToken(token));const response=await get();assert.equal(response.status,401);assert.equal(f.jobs.length,0);assert.equal(f.audits.length,0);
}));
test('unreadable or malformed promises refuse application action before ledger',t=>harness(t,async(f,{post})=>{
 f.promises.listByCustomer=async()=>{throw Error('SYNTHETIC_PROMISE_UNAVAILABLE');};assert.equal((await post()).status,503);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,0);
 f.promises.listByCustomer=async()=>[{...promise,id:'synthetic-promise',status:'cancelled'}];assert.equal((await post()).status,503);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,0);
}));
test('expired promise permits only the existing explicit current-day step, not automatic resumption',t=>harness(t,async(f,{post})=>{
 await f.promises.create({...promise,promisedFor:'2026-11-12'});assert.equal((await post()).status,200);assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].name,'collection-step:'+(await f.rules.getLatest()).steps[0].id);assert.equal(f.jobs[0].payload.scheduledFor,'2026-11-13');
}));

for(const dueAt of ['2026-02-30','not-a-date','0000-01-01',''])test(`invalid civil due date refuses before ledger: ${JSON.stringify(dueAt)}`,t=>harness(t,async(f,{post})=>{
 f.raw.data_vencimento=dueAt;const response=await post();assert.equal(response.status,503);assert.equal(f.jobs.length,0);assert.equal(f.ledger.rows.length,0);
}));
