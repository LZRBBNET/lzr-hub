import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFailureReporter, resolveObservedSession } from '../lib/platform/session-diagnostics.ts';

test('valid user identity preserved and no success log', async () => {
 const user={id:'synthetic'}; let received;
 const value=await resolveObservedSession(()=> 'test-token', async token => { received=token; return user; },()=>assert.fail());
 assert.equal(value,user); assert.equal(received,'test-token');
});
for (const [name,read,lookup,reason] of [
 ['missing',()=>undefined,()=>assert.fail(),'missing_cookie'],
 ['empty',()=>'',()=>assert.fail(),'missing_cookie'],
 ['malformed',()=>{throw new Error('secret cookie')},()=>assert.fail(),'unreadable_cookie'],
 ['unresolved',()=> 'secret',async()=>undefined,'unresolved_session'],
 ['db exception',()=> 'secret',async()=>{throw new Error('postgres://secret')},'lookup_failed'],
]) test(name+' fails closed with coarse reason only',async()=>{
 const notes=[]; assert.equal(await resolveObservedSession(read,lookup,r=>notes.push(r)),undefined); assert.deepEqual(notes,[reason]);
});
test('reporter throws never changes resolution',async()=>{
 assert.equal(await resolveObservedSession(()=>undefined,()=>assert.fail(),()=>{throw Error('logger')}),undefined);
 const user={id:'test'}; assert.equal(await resolveObservedSession(()=> 'token',async()=>user,()=>{throw Error()}),user);
});
test('bounded throttle, fixed schema and rejected arbitrary reasons',()=>{
 let time=1000; const output=[]; const report=createSessionFailureReporter(s=>output.push(s),()=>time);
 report('missing_cookie'); report('missing_cookie'); report('lookup_failed');
 report('TOKEN-secret'); time=60999; report('missing_cookie'); time=61000; report('missing_cookie');
 assert.deepEqual(output.map(JSON.parse),[
 {event:'auth.session_unavailable',reason:'missing_cookie'},
 {event:'auth.session_unavailable',reason:'lookup_failed'},
 {event:'auth.session_unavailable',reason:'missing_cookie'},
 ]);
});
test('logger failure, invalid clock and backwards clock safe',()=>{
 const report=createSessionFailureReporter(()=>{throw Error('logger')}); assert.doesNotThrow(()=>report('lookup_failed'));
 const none=[]; createSessionFailureReporter(x=>none.push(x),()=>NaN)('missing_cookie'); assert.deepEqual(none,[]);
 let time=100; const logs=[]; const back=createSessionFailureReporter(x=>logs.push(x),()=>time);
 back('missing_cookie'); time=50; back('missing_cookie'); assert.equal(logs.length,1);
});

test('actual guard wiring preserves auth enforcement and permission checks',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {stripTypeScriptTypes}=await import('node:module');
 const source=await readFile(new URL('../lib/platform/session-guard.ts',import.meta.url),'utf8');
 const stripped=stripTypeScriptTypes(source.replace(/^import .*;\n/gm,''));
 const factory=new Function('getDb','DbAuthRepository','SESSION_COOKIE','resolveSession','can','createSessionFailureReporter','resolveObservedSession',stripped.replaceAll('export ','')+'; return { currentUser, authorize };');
 let calls=0, permission=true, fail=false;
 class Repository {}
 const reasons=[];
 const guard=factory(async()=>{calls++; if(fail)throw Error('sensitive');return {};},Repository,'lzr_session',async(_,token)=>token==='valid'?{id:'test',role:'support'}:undefined,()=>permission,()=>r=>reasons.push(r),resolveObservedSession);
 const saved=process.env.FEATURE_AUTH;
 try {
  process.env.FEATURE_AUTH='true';
  assert.deepEqual(await guard.authorize(new Request('https://test.invalid'),'support.write'),{allowed:false,status:401,error:'Sessão inválida ou expirada'});
  assert.equal(calls,0);
  const req=new Request('https://test.invalid',{headers:{cookie:'lzr_session=valid'}});
  assert.equal((await guard.authorize(req,'support.write')).allowed,true);
  permission=false; assert.equal((await guard.authorize(req,'support.write')).status,403);
  fail=true; assert.equal((await guard.authorize(req,'support.write')).status,401);
  assert.deepEqual(reasons,['missing_cookie','lookup_failed']);
  process.env.FEATURE_AUTH='false'; assert.deepEqual(await guard.authorize(req,'support.write'),{allowed:true});
 }finally{if(saved===undefined) delete process.env.FEATURE_AUTH; else process.env.FEATURE_AUTH=saved;}
});
