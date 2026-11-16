import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {evaluatePromiseHold} from '../services/queue-runtime/src/promise-hold.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),key='__promiseReviewFixture',require=createRequire(import.meta.url);
const sources={
 db:`export const getDb=async()=>({});`,
 repository:`export * from ${JSON.stringify(root+'lib/platform/payment-promise-service.ts')};export class DbPaymentPromiseRepository{constructor(){return globalThis.${key}.repository;}}`,
 auth:`export const authorize=async()=>globalThis.${key}.denied?({allowed:false,status:403,error:'SYNTHETIC_DENIED'}):({allowed:true,user:{email:'synthetic@example.invalid'}});`,
 runtime:`export const getIxcRuntime=()=>({provider:globalThis.${key}.provider});`,
 audit:`export const logUnauthenticatedAction=async()=>{};`,
};
const aliases={'@/db':'db','@/lib/platform/payment-promise-service':'repository','@/lib/platform/session-guard':'auth','@/lib/integrations/ixc/runtime':'runtime','@/lib/platform/audit-log':'audit'};
const built=await build({stdin:{contents:"export{POST}from'./app/api/billing/promises/route';",resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,packages:'external',logLevel:'silent',plugins:[{name:'authorized-synthetic-review',setup(b){b.onResolve({filter:/^@\//},a=>aliases[a.path]?{path:aliases[a.path],namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:sources[a.path],loader:'js',resolveDir:root}));}}]});
const compiled={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(require,compiled,compiled.exports);
const now=Date.parse('2026-11-15T15:00:00Z');
const invoice=()=>({id:'901',customerId:'10',status:'A',value:50,valueSource:'open-balance'});
const snapshot=()=>({customer:{id:'10'},cache:'miss',fetchedAt:new Date(now).toISOString(),partialSources:[],coverage:{invoices:{read:1,total:1,complete:true,limit:100}},invoices:[invoice()]});
async function exercise(t,modify,expected='pending'){
 t.mock.timers.enable({apis:['Date'],now});
 const rows=['2026-11-14','2026-11-16'].map((promisedFor,i)=>({id:'promise-'+i,invoiceId:'901',customerId:'10',promisedFor,status:'pending',registeredBy:'synthetic',correlationId:'synthetic',createdAt:new Date(now).toISOString()}));
 const updates=[],reads=[],f={rows,repository:{listPending:async()=>rows.filter(r=>r.status==='pending'),updateStatus:async(id,status)=>{updates.push({id,status});rows.find(r=>r.id===id).status=status;}},provider:{getSnapshot:async(...args)=>{reads.push(args);return f.snapshot;}},snapshot:snapshot()};
 modify(f);
 const old=globalThis[key],oldFetch=globalThis.fetch;globalThis[key]=f;globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};
 try{
  const response=await compiled.exports.POST(new Request('https://fixture.invalid/api/billing/promises',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'review'})}));
  assert.equal(response.status,200);
  const result=await response.json();assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_CANARY'));
  assert.deepEqual(updates,expected==='pending'?[]:expected==='open'?[{id:'promise-0',status:'broken'}]:rows.map(r=>({id:r.id,status:'fulfilled'})));
  assert.deepEqual(rows.map(r=>r.status),expected==='open'?['broken','pending']:[expected,expected]);
  if(expected==='pending'){assert.deepEqual(updates,[]);assert.equal(evaluatePromiseHold({complete:true,customerId:'10',invoiceId:'901',items:rows},'10','901',new Date(now)).state,'paused');}
  for(const args of reads){assert.equal(args[0],'10');assert.equal(args[2],true,'review must force fresh snapshot');}
 }finally{globalThis[key]=old;globalThis.fetch=oldFetch;}
}
const uncertain={
 absent:f=>{f.provider=undefined;},
 error:f=>{f.provider.getSnapshot=async()=>{throw Error('SYNTHETIC_PRIVATE_CANARY');};},
 partial:f=>{f.snapshot.coverage.invoices.complete=false;},
 partialSource:f=>{f.snapshot.partialSources=['invoices'];},
 wrongCustomer:f=>{f.snapshot.customer.id='20';},
 missingTotal:f=>{delete f.snapshot.coverage.invoices.total;},
 empty:f=>{f.snapshot.invoices=[];f.snapshot.coverage.invoices={read:0,total:0,complete:true,limit:100};},
 missingInvoice:f=>{f.snapshot.invoices[0].id='902';},
 foreign:f=>{f.snapshot.invoices[0].customerId='20';},
 duplicate:f=>{f.snapshot.invoices.push(invoice());f.snapshot.coverage.invoices.read=2;f.snapshot.coverage.invoices.total=2;},
 cacheHit:f=>{f.snapshot.cache='hit';},
 stale:f=>{f.snapshot.fetchedAt=new Date(now-1).toISOString();},
 future:f=>{f.snapshot.fetchedAt=new Date(now+1).toISOString();},
 malformedTimestamp:f=>{f.snapshot.fetchedAt='invalid';},
 unknown:f=>{f.snapshot.invoices[0].status='unknown';},
 cancelled:f=>{f.snapshot.invoices[0].status='C';},
 unverifiedPaidCode:f=>{f.snapshot.invoices[0].status='P';},
 receivedPositive:f=>{f.snapshot.invoices[0].status='R';},
 receivedMissingBalance:f=>{Object.assign(f.snapshot.invoices[0],{status:'R',value:0,valueSource:'face-value'});},
};
for(const [name,modify] of Object.entries(uncertain))test(`review preserves active and expired promises on ${name}`,t=>exercise(t,modify));
test('review breaks only expired promise on confirmed open positive balance',t=>exercise(t,()=>{},'open'));
test('review fulfills active and expired promises on confirmed received zero balance',t=>exercise(t,f=>{Object.assign(f.snapshot.invoices[0],{status:'R',value:0});},'fulfilled'));

test('review keeps customer-scoped evidence separate for identical invoice IDs',async t=>{
 t.mock.timers.enable({apis:['Date'],now});
 const rows=['10','20'].map((customerId,i)=>({id:'scoped-'+i,customerId,invoiceId:'901',promisedFor:'2026-11-16',status:'pending'}));
 const updates=[],reads=[],f={repository:{listPending:async()=>rows,updateStatus:async(id,status)=>{updates.push({id,status});}},provider:{getSnapshot:async(customerId,correlationId,force)=>{reads.push({customerId,force});const s=snapshot();s.customer.id=customerId;s.invoices[0].customerId=customerId;if(customerId==='10')Object.assign(s.invoices[0],{status:'R',value:0});return s;}}};
 const old=globalThis[key],oldFetch=globalThis.fetch;globalThis[key]=f;globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};
 try{const response=await compiled.exports.POST(new Request('https://fixture.invalid/api/billing/promises',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'review'})}));assert.equal(response.status,200);assert.deepEqual(updates,[{id:'scoped-0',status:'fulfilled'}]);assert.deepEqual(reads.map(r=>r.customerId).sort(),['10','20']);assert.ok(reads.every(r=>r.force===true));}finally{globalThis[key]=old;globalThis.fetch=oldFetch;}
});

test('review rechecks authorization after evidence and performs no updates on revocation',async t=>{
 t.mock.timers.enable({apis:['Date'],now});const updates=[];
 const f={denied:false,repository:{listPending:async()=>[{id:'revoked',customerId:'10',invoiceId:'901',promisedFor:'2026-11-14',status:'pending'}],updateStatus:async(...args)=>updates.push(args)},provider:{getSnapshot:async()=>{f.denied=true;const s=snapshot();Object.assign(s.invoices[0],{status:'R',value:0});return s;}}};
 const old=globalThis[key],oldFetch=globalThis.fetch;globalThis[key]=f;globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};
 try{const response=await compiled.exports.POST(new Request('https://fixture.invalid/api/billing/promises',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'review'})}));assert.equal(response.status,403);assert.deepEqual(updates,[]);}finally{globalThis[key]=old;globalThis.fetch=oldFetch;}
});
