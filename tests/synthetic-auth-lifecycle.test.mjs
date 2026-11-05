import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as auth from '../lib/platform/auth.ts';
import * as rbac from '../lib/platform/rbac.ts';
import * as diagnostics from '../lib/platform/session-diagnostics.ts';
import * as throttle from '../lib/platform/login-throttle.ts';

const require=createRequire(import.meta.url);
const compile=(file,modules)=>{
  const result={exports:{}};
  const code=transformSync(readFileSync(new URL(file,import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name),`Unexpected dependency ${name}`);return modules[name];},result,result.exports);
  return result.exports;
};
for(const [role,allowed]of [['Supervisor',true],['Somente leitura',false]])test(`login real → cookie → RBAC → logout com persistência em memória: ${role}`,async t=>{
  const flags={FEATURE_AUTH:'true',PILOT_MODE:'disabled',NODE_ENV:'production'};
  const previous=Object.fromEntries(Object.keys(flags).map(key=>[key,process.env[key]]));Object.assign(process.env,flags);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const repository=new auth.MemoryAuthRepository();const password=randomUUID();const email=`${randomUUID()}@example.invalid`;
  const user=await repository.addUser(email,password,role,'Pessoa sintética');
  const authModule={...auth,DbAuthRepository:class{constructor(){return repository;}}};
  const db={async getDb(){return {};}};
  const guard=compile('../lib/platform/session-guard.ts',{'../../db/index.ts':db,'./auth.ts':authModule,'./rbac.ts':rbac,'./session-diagnostics.ts':diagnostics});
  const modules={'next/server':require('next/server'),'@/db':db,'@/lib/platform/auth':authModule,
    '@/lib/platform/audit-log':{async logUnauthenticatedAction(){}},'@/lib/platform/login-throttle':throttle,'@/lib/platform/session-guard':guard};
  const login=compile('../app/api/auth/login/route.ts',modules);const logout=compile('../app/api/auth/logout/route.ts',modules);
  const request=(body,cookie)=>new Request('https://synthetic.invalid/api/auth',{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const denied=await login.POST(request({email,password:'synthetic-wrong'}));assert.equal(denied.status,401);assert.equal(repository.sessions.size,0);
  const response=await login.POST(request({email,password}));assert.equal(response.status,200);
  const header=response.headers.get('set-cookie');assert.match(header,/HttpOnly/i);assert.match(header,/Secure/i);assert.match(header,/SameSite=lax/i);
  const cookie=header.split(';')[0];const body=await response.json();assert.equal(body.user.id,user.id);
  assert.equal(body.token,undefined);assert.equal(repository.sessions.size,1);
  assert.ok(![...repository.sessions.keys()].some(hash=>cookie.includes(hash)),'repository persists a hash, not cookie token');
  const authorized=await guard.authorize(request(null,cookie),'billing.write-demo');assert.equal(authorized.allowed,allowed);
  if(allowed)assert.equal(authorized.user.id,user.id);else assert.equal(authorized.status,403);
  assert.equal((await logout.POST(request(null,cookie))).status,200);assert.equal(repository.sessions.size,0);
  assert.equal((await guard.authorize(request(null,cookie),'customer.read')).status,401);
  // A restarted empty repository cannot recover the in-memory account/session.
  assert.equal(await auth.resolveSession(new auth.MemoryAuthRepository(),cookie.split('=')[1]),undefined);
});
