import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { rolePermissions } from '../lib/platform/rbac.ts';

const require=createRequire(import.meta.url);
for(const flag of [true,false,undefined])test(`auth/me mantém estado já resolvido sem segunda consulta: ${flag}`,async()=>{
  const user=flag===undefined?undefined:{id:'synthetic-user',name:'DEMO User',email:'operator@example.invalid',role:'Supervisor',...(flag?{mustChangePassword:true}:{})};
  let extraReads=0;let resolutions=0;
  const modules={
    'next/server':require('next/server'),
    '@/db':{async getDb(){extraReads++;throw Error('synthetic-private-db-failure');}},
    '@/lib/platform/auth':{DbAuthRepository:class{}},
    '@/lib/platform/rbac':{rolePermissions},
    '@/lib/platform/session-guard':{authEnforced:()=>true,async currentUser(){resolutions++;return user;}},
  };
  const compiled={exports:{}};
  const code=transformSync(readFileSync(new URL('../app/api/auth/me/route.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];},compiled,compiled.exports);
  const response=await compiled.exports.GET(new Request('https://synthetic.invalid/api/auth/me'));
  assert.equal(response.status,200);const body=await response.json();assert.equal(resolutions,1);
  if(user){assert.equal(body.authenticated,true);assert.equal(body.mustChangePassword,flag);assert.deepEqual(body.permissions,rolePermissions.Supervisor);}
  else{assert.equal(body.authenticated,false);assert.equal(body.authRequired,true);assert.equal(body.permissions,undefined);}
  assert.equal(extraReads,0);assert.doesNotMatch(JSON.stringify(body),/private-db-failure/);
});

for(const scenario of ['valid-provisional','valid-normal','missing','malformed','expired','inactive','unknown','db-failure'])test(`auth/me com guard e resolver reais: ${scenario}`,async t=>{
  const auth=await import('../lib/platform/auth.ts');const rbac=await import('../lib/platform/rbac.ts');const diagnostics=await import('../lib/platform/session-diagnostics.ts');
  const saved={FEATURE_AUTH:process.env.FEATURE_AUTH,PILOT_MODE:process.env.PILOT_MODE};Object.assign(process.env,{FEATURE_AUTH:'true',PILOT_MODE:'disabled'});
  t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const repository=new auth.MemoryAuthRepository();repository.users.push({id:'synthetic-user',email:'operator@example.invalid',name:'DEMO User',role:'Supervisor',active:scenario!=='inactive',passwordHash:'unused',passwordSalt:'unused',mustChangePassword:scenario==='valid-provisional'});
  const token='synthetic-me-session';repository.sessions.set(auth.hashToken(token),{userId:'synthetic-user',expiresAt:scenario==='expired'?'2000-01-01T00:00:00Z':'2099-01-01T00:00:00Z'});
  let reads=0;const db={async getDb(){reads++;if(scenario==='db-failure')throw Error('synthetic-private-lookup-error');return {};}};
  const compile=(path,modules)=>{const result={exports:{}};const code=transformSync(readFileSync(new URL(path,import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];},result,result.exports);return result.exports;};
  const guard=compile('../lib/platform/session-guard.ts',{'../../db/index.ts':db,'./auth.ts':{...auth,DbAuthRepository:class{constructor(){return repository;}}},'./rbac.ts':rbac,'./session-diagnostics.ts':diagnostics});
  const route=compile('../app/api/auth/me/route.ts',{'next/server':require('next/server'),'@/lib/platform/rbac':rbac,'@/lib/platform/session-guard':guard});
  const cookie=scenario==='missing'?'':scenario==='malformed'?'lzr_session=%ZZ':scenario==='unknown'?'lzr_session=synthetic-unknown':`lzr_session=${token}`;
  const response=await route.GET(new Request('https://synthetic.invalid/api/auth/me',{headers:cookie?{cookie}:{}}));const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.authRequired,true);
  if(scenario.startsWith('valid-')){assert.equal(body.authenticated,true);assert.equal(body.mustChangePassword,scenario==='valid-provisional');assert.equal(reads,1);}
  else{assert.deepEqual(body,{authenticated:false,authRequired:true});assert.ok(reads<=1);}
  assert.doesNotMatch(JSON.stringify(body),/synthetic-private-lookup-error|synthetic-me-session|passwordHash|passwordSalt/);
});
