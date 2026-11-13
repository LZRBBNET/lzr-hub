import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const route=await readFile(new URL('../app/api/auth/me/route.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(route.replace(/^import .*;\n/gm,'')).replaceAll('export ','');
const make=new Function('NextResponse','getDb','DbAuthRepository','rolePermissions','authEnforced','sessionState',code+';return GET;');
for(const scenario of ['unavailable','invalid','valid','provisional','second-failure','second-missing'])test('auth/me '+scenario,async()=>{
 const user={id:'synthetic',role:'Atendente'};
 const GET=make({json:(body,init)=>Response.json(body,init)},async()=>({}),class{async findUserById(){if(scenario==='second-failure')throw Error('private-dsn');if(scenario==='second-missing')return undefined;return {mustChangePassword:scenario==='provisional'};}},{Atendente:['support.write']},()=>true,async()=>({user:scenario==='invalid'||scenario==='unavailable'?undefined:user,unavailable:scenario==='unavailable'}));
 const response=await GET(new Request('https://synthetic.invalid'));const body=await response.json();
 if(['unavailable','second-failure','second-missing'].includes(scenario)){assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(body.authenticated,undefined);assert.equal(body.user,undefined);assert.doesNotMatch(JSON.stringify(body),/private-dsn/);}
 else {assert.equal(response.status,200);assert.equal(body.authenticated,scenario!=='invalid');if(scenario!=='invalid')assert.equal(body.mustChangePassword,scenario==='provisional');}
});
for(const scenario of ['503','network','invalid-json','invalid-shape','invalid-session','valid-session'])test('session consumer '+scenario,async()=>{
 const {createCustomerSessionAdmission}=await import('../lib/platform/customer-session-admission.ts');
 const window={location:{href:'unchanged'}};
 const admission=createCustomerSessionAdmission({onInvalid:()=>{window.location.href='/login';},fetchSession:async()=>{
  if(scenario==='network')throw Error('offline');
  if(scenario==='503')return Response.json({authenticated:false,authRequired:true},{status:503});
  if(scenario==='invalid-json')return new Response('bad-json');
  if(scenario==='invalid-shape')return Response.json({error:'unknown'});
  return Response.json({authenticated:scenario==='valid-session',authRequired:true});
 }});
 await admission.start();const state=admission.snapshot().session;
 if(scenario==='invalid-session'){assert.equal(window.location.href,'/login');assert.equal(state.authenticated,false);}
 else {assert.equal(window.location.href,'unchanged');assert.equal(state.unavailable,scenario==='valid-session'?undefined:true);}
 admission.stop();
});
