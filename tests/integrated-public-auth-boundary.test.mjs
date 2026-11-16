import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {MemoryAuthRepository,hashToken} from '../lib/platform/auth.ts';

// Exercise the composed public handlers with the real PR70 guard and PR68 RBAC.
// Only persistence is substituted; no application server or external transport.
const root=fileURLToPath(new URL('../',import.meta.url));
const key='__publicCompositionAuthFixture';
const built=await build({stdin:{contents:`
 export {GET as customer} from './app/api/customers/route';
 export {POST as dispatch} from './app/api/billing/collections/dispatch/route';
 export {POST as reconcile} from './app/api/conversations/reconcile/route';
`,resolveDir:root},bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent',plugins:[{name:'synthetic-auth-persistence',setup(b){
 b.onResolve({filter:/^(?:@\/db|(?:\.\.\/)+db\/index\.ts)$/},()=>({path:'db',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/auth\.ts$/},()=>({path:'auth',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',resolveDir:root,contents:a.path==='db'
  ?`export async function getDb(){const f=globalThis.${key};f.lookups++;if(f.unavailable)throw Error('SYNTHETIC_DB_UNAVAILABLE');return {};}`
  :`export * from ${JSON.stringify(root+'lib/platform/auth.ts')}; export class DbAuthRepository{constructor(){return globalThis.${key}.auth;}}`}));
}}]});
const compiled={exports:{}};
new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);
for(const scenario of ['anonymous','unavailable','expired','forbidden'])test(`composed customer/billing/handoff auth boundary: ${scenario}`,async t=>{
 const previous=process.env.FEATURE_AUTH;
 process.env.FEATURE_AUTH='true';
 const f={auth:new MemoryAuthRepository(),unavailable:scenario==='unavailable',lookups:0};
 globalThis[key]=f;
 t.mock.method(globalThis,'fetch',()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN');});
 const token='SYNTHETIC_COMPOSITION_SESSION';
 f.auth.users.push({id:'synthetic-operator',email:'operator@example.invalid',name:'Operador fictício',role:'Atendente',active:true,passwordHash:'unused',passwordSalt:'unused'});
 if(scenario==='forbidden')await f.auth.createSession(hashToken(token),'synthetic-operator','2099-01-01T00:00:00Z');
 try{
  const names=scenario==='forbidden'?['dispatch','reconcile']:['customer','dispatch','reconcile'];
  for(const name of names){
   const request=new Request('https://fixture.invalid/api/'+name,{method:name==='customer'?'GET':'POST',headers:scenario==='anonymous'?{}:{cookie:'lzr_session='+token}});
   const response=await compiled.exports[name](request);
   assert.equal(response.status,scenario==='unavailable'?503:scenario==='forbidden'?403:401);
   const body=await response.json();
   assert.equal(typeof body.error,'string');
   assert.doesNotMatch(JSON.stringify(body),/SYNTHETIC_DB_UNAVAILABLE|SYNTHETIC_COMPOSITION_SESSION/);
  }
  assert.equal(globalThis.fetch.mock.calls.length,0);
 }finally{
  delete globalThis[key];
  if(previous===undefined)delete process.env.FEATURE_AUTH;else process.env.FEATURE_AUTH=previous;
 }
});
