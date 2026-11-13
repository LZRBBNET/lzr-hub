// Isolated controller threats. Every credential, cookie, password and transport is fake.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {createBrowserInitialization} from '../lib/platform/browser-initialization.ts';
import {stagingDemoRequirements} from '../lib/runtime/staging-demo.ts';
const ORIGIN='https://synthetic-browser.onrender.com',token='a'.repeat(64),cookie='b'.repeat(64),attempt='synthetic-init-browser-review-20261106';
const hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const state={time:Date.parse('2026-11-06T12:00:00Z'),postError:false,deriveError:false,status:'absence-observed',deriveWait:undefined};
 const source={...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_BROWSER_SETUP_ENABLED:'true',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:ORIGIN,SYNTHETIC_INIT_ENABLED:'true',SYNTHETIC_INIT_CAPABILITY_SHA256:hash(token),SYNTHETIC_INIT_EXPIRES_AT:new Date(state.time+900000).toISOString()};
 const calls=[];let derives=0,randoms=0;
 const deps={source:()=>source,now:()=>state.time,random:()=>{randoms++;return cookie;},derive:async password=>{derives++;assert.equal(password,'invented-only-password');if(state.deriveWait)await state.deriveWait;if(state.deriveError)throw Error('private-error-not-for-response');return{hash:'c'.repeat(128),salt:'d'.repeat(32)};},initialize:async request=>{
  calls.push({method:request.method,url:request.url,body:request.method==='POST'?await request.json():undefined});
  assert.equal(request.headers.get('x-synthetic-init-capability'),token);
  if(request.method==='POST'){if(state.postError)throw Error('synthetic-uncertain-write');return Response.json({status:'confirmed',retryAllowed:false},{status:201});}
  if(new URL(request.url).searchParams.has('status'))return Response.json({state:state.status,reservationObserved:state.status!=='absence-observed',completionObserved:state.status==='completion-observed',manifestMatches:state.status!=='absence-observed',retryAllowed:false,credentialsVerified:false,targetHostMatches:true,expectedManifestSha256:'97a9ec8b31e619eba5de6ac9acf4525ab5002761f2320c5fa45451bf29df4702'});
  return Response.json({processId:'synthetic-process-review',databaseOid:'12345',available:true,freshManualApprovalRequired:true,retryAllowed:false});
 }};
 const make=()=>createBrowserInitialization(deps),handle=make();
 const request=(method='GET',options={})=>new Request(ORIGIN+'/api/demo/browser-setup'+(options.status?'?status=1':''),{method,headers:{'x-synthetic-init-capability':token,'x-browser-init-attempt':attempt,...(method==='POST'?{origin:ORIGIN,'content-type':'application/json'}:{}),...(options.cookie?{cookie:`__Host-lzr-browser-init=${options.cookie}`} :{}),...options.headers},...(method==='POST'?{body:options.raw??JSON.stringify({password:'invented-only-password',confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1'})}:{})});
 return{deps,state,source,calls,handle,make,request,get derives(){return derives;},get randoms(){return randoms;},ready:async()=>{const r=await handle(request());assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict; Path=\//);assert.equal((await r.json()).state,'ready');return cookie;}};
}
test('off/missing flag, capability, deadline and wrong origin never reach DB/derivation',async()=>{
 for(const mode of ['off','missing','production','expired','bad-token','cross-origin']){
  const f=fixture();if(mode==='production')f.source.LZR_ENV='production';if(mode==='off')f.source.SYNTHETIC_BROWSER_SETUP_ENABLED='false';if(mode==='missing')delete f.source.SYNTHETIC_BROWSER_SETUP_ENABLED;if(mode==='expired')f.state.time+=900001;
  const r=await f.handle(f.request('GET',{headers:mode==='bad-token'?{'x-synthetic-init-capability':'e'.repeat(64)}:mode==='cross-origin'?{origin:'https://attacker.invalid'}:{}}));
  assert.notEqual(r.status,200);assert.equal(f.calls.length,0);assert.equal(f.derives,0);assert.equal(f.randoms,0);
 }
});
test('ready uses only GETs and binds cookie, attempt, origin, process and target',async()=>{
 const f=fixture();await f.ready();assert.deepEqual(f.calls.map(c=>c.method),['GET','GET']);
 for(const options of [{},{cookie:'e'.repeat(64)},{cookie,headers:{'x-browser-init-attempt':'synthetic-init-another-review'}},{cookie,headers:{origin:'https://attacker.invalid'}},{cookie,headers:{cookie:`__Host-lzr-browser-init=${cookie}; __Host-lzr-browser-init=${cookie}`}}])assert.notEqual((await f.handle(f.request('POST',options))).status,201);
 assert.equal(f.derives,0);assert.equal(f.calls.length,2);
 const fresh=f.make();assert.equal((await fresh(f.request('POST',{cookie}))).status,409,'restart loses admission; never replay');
 f.source.DATABASE_URL='postgresql://synthetic:fake@database.invalid/lzr_synthetic_demo';
 assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(f.derives,0);
});
test('one POST derives server-side and passes no password to initializer, never repeats',async()=>{
 const f=fixture();await f.ready();const r=await f.handle(f.request('POST',{cookie}));assert.equal(r.status,201);assert.deepEqual(await r.json(),{state:'completion-confirmed',retryAllowed:false});assert.equal(r.headers.get('set-cookie'),null,'não renova nem remove cookie antes da confirmação do corpo');
 assert.equal(f.derives,1);assert.equal(f.calls.length,3);assert.deepEqual(Object.keys(f.calls[2].body).sort(),['attempt','confirmation','databaseOid','hash','processId','salt']);assert.equal(f.calls[2].body.processId,'synthetic-process-review');
 assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(f.calls.length,3);
});
test('reservation/unknown observation cannot offer password admission',async()=>{
 const f=fixture();f.state.status='reservation-observed';assert.equal((await f.handle(f.request())).status,503);assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(f.derives,0);
});
test('uncertain write exposes only fixed result; status stays read-only and cannot reset used',async()=>{
 const f=fixture();await f.ready();f.state.postError=true;const r=await f.handle(f.request('POST',{cookie}));assert.deepEqual(await r.json(),{state:'not-confirmed',retryAllowed:false});assert.equal(r.status,503);
 f.state.status='completion-observed';assert.equal((await f.handle(f.request('GET',{cookie,status:true}))).status,200);
 assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('expiration during derivation and concurrent POST cannot pass',async()=>{
 const f=fixture();await f.ready();let release;f.state.deriveWait=new Promise(r=>{release=r;});const pending=f.handle(f.request('POST',{cookie}));
 await new Promise(r=>setTimeout(r,0));assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);f.state.time+=900001;release();assert.equal((await pending).status,503);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('oversize/invalid password burns admission without derivation or write',async()=>{
 for(const raw of ['x'.repeat(4097),JSON.stringify({password:'short',confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1'}),JSON.stringify({password:'invented-only-password',confirmation:'wrong'})]){
  const f=fixture();await f.ready();assert.equal((await f.handle(f.request('POST',{cookie,raw}))).status,503);assert.equal(f.derives,0);assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(f.calls.length,2);
 }
});
test('ponte real: preflight/status/initializer/schema e fixtures em Simulator, sem SQL real',async()=>{
 const {createInitializationController}=await import('../lib/platform/synthetic-initialization-controller.ts');
 const {loadSyntheticSchema}=await import('../scripts/prepare-synthetic-initialization.mjs');
 const {Simulator,fresh}=await import('./helpers/synthetic-init-simulator.mjs');
 const f=fixture(),store=fresh();f.state.time=Date.now();f.source.SYNTHETIC_INIT_EXPIRES_AT=new Date(f.state.time+900000).toISOString();
 f.source.SYNTHETIC_INIT_DATABASE_HOST='db.example.invalid';f.source.DATABASE_URL='postgresql://lzr_synthetic_demo:invented@db.example.invalid/lzr_synthetic_demo';
 f.deps.initialize=createInitializationController({source:()=>f.source,processId:'synthetic-bridge-process',schema:loadSyntheticSchema,now:()=>new Date(f.state.time),connect:async()=>new Simulator(store)});
 await f.ready();assert.equal(store.completed,false);assert.equal(store.reserved,false);
 assert.equal((await f.handle(f.request('POST',{cookie}))).status,201);
 assert.equal(store.completed,true);assert.equal(store.reserved,true);
 const users=store.rows.filter(r=>r.sql.startsWith('INSERT INTO public.users'));assert.equal(users.length,1);assert.equal(users[0].values.includes('invented-only-password'),false);
 assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(store.rows.filter(r=>r.sql.startsWith('INSERT INTO public.users')).length,1);
});
test('outro visitante e o verificador público não autenticam contra a chave aprovada',async()=>{
 const f=fixture();
 for(const candidate of ['e'.repeat(64),hash('e'.repeat(64)),hash(token)]){
  assert.equal((await f.handle(f.request('GET',{headers:{'x-synthetic-init-capability':candidate}}))).status,404);
 }
 assert.equal(f.calls.length,0);assert.equal(f.randoms,0);
 await f.ready();
 assert.equal((await f.handle(f.request('GET'))).status,409,'mesmo a capability sem cookie não toma sessão já vinculada');
 assert.equal((await f.handle(f.request('POST',{headers:{'x-synthetic-init-capability':hash(token)}}))).status,404);
 assert.equal(f.derives,0);
});
test('CSRF sem Origin ou com Fetch Metadata cross-site nunca chega à derivação',async()=>{
 const f=fixture();await f.ready();
 const noOrigin=f.request('POST',{cookie});noOrigin.headers.delete('origin');
 assert.notEqual((await f.handle(noOrigin)).status,201);
 for(const site of ['cross-site','same-site'])assert.equal((await f.handle(f.request('POST',{cookie,headers:{'sec-fetch-site':site}}))).status,403);
 assert.equal(f.derives,0);assert.equal(f.calls.length,2);
});
test('resposta 201 cujo corpo se perde mantém cookie para reconciliação, sem reabrir POST',async()=>{
 const f=fixture();await f.ready();
 const response=await f.handle(f.request('POST',{cookie}));assert.equal(response.status,201);
 // Browser can apply Set-Cookie before JSON/body fails. Do not consume its body.
 const cookieStillPresent=!/Max-Age=0/.test(response.headers.get('set-cookie')??'');
 f.state.status='completion-observed';
 const status=await f.handle(f.request('GET',{status:true,...(cookieStillPresent?{cookie}:{})}));
 assert.equal(status.status,200);assert.equal((await status.json()).state,'completion-observed');
 assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('modo navegador não admite prazo maior que 15 minutos no relógio do servidor',async()=>{
 const f=fixture();f.source.SYNTHETIC_INIT_EXPIRES_AT=new Date(f.state.time+16*60000).toISOString();
 assert.equal((await f.handle(f.request())).status,404);assert.equal(f.calls.length,0);assert.equal(f.randoms,0);
});
test('commit confirmado no Simulator mas corpo incerto permite só observar conclusão',async()=>{
 const {createInitializationController}=await import('../lib/platform/synthetic-initialization-controller.ts');
 const {loadSyntheticSchema}=await import('../scripts/prepare-synthetic-initialization.mjs');
 const {Simulator,fresh}=await import('./helpers/synthetic-init-simulator.mjs');
 const f=fixture(),store=fresh();f.state.time=Date.now();f.source.SYNTHETIC_INIT_EXPIRES_AT=new Date(f.state.time+900000).toISOString();
 f.source.SYNTHETIC_INIT_DATABASE_HOST='db.example.invalid';f.source.DATABASE_URL='postgresql://lzr_synthetic_demo:invented@db.example.invalid/lzr_synthetic_demo';
 const real=createInitializationController({source:()=>f.source,processId:'synthetic-uncertain-process',schema:loadSyntheticSchema,now:()=>new Date(f.state.time),connect:async()=>new Simulator(store)});
 let posts=0;f.deps.initialize=async request=>{const response=await real(request);if(request.method==='POST'){posts++;assert.equal(response.status,201);return new Response('synthetic-lost-body',{status:201});}return response;};
 await f.ready();const response=await f.handle(f.request('POST',{cookie}));assert.equal(response.status,503);assert.equal(store.completed,true);
 const status=await f.handle(f.request('GET',{cookie,status:true}));assert.equal(status.status,200);assert.equal((await status.json()).state,'completion-observed');
 assert.equal((await f.handle(f.request('POST',{cookie}))).status,409);assert.equal(posts,1);assert.equal(store.rows.filter(r=>r.sql.startsWith('INSERT INTO public.users')).length,1);
});
test('cookie não relacionado não bloqueia navegador legítimo, mas cookie antigo de setup bloqueia restart',async()=>{
 const f=fixture();assert.equal((await f.handle(f.request('GET',{headers:{cookie:'unrelated=synthetic-public-marker'}}))).status,200);
 for(const prior of [`__Host-lzr-browser-init=${cookie}`,'__Host-lzr-browser-init=malformed']){
  const g=fixture();assert.equal((await g.handle(g.request('GET',{headers:{cookie:prior}}))).status,409);assert.equal(g.calls.length,0);assert.equal(g.randoms,0);
 }
});
