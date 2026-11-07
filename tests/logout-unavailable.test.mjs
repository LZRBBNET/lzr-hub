import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {logout,hashToken} from '../lib/platform/auth.ts';
const source=await readFile(new URL('../app/api/auth/logout/route.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*;\n/gm,'')).replaceAll('export ','');
const make=new Function('NextResponse','getDb','DbAuthRepository','SESSION_COOKIE','logout','readSessionToken',code+';return POST;');
test('logout does not confirm revocation or clear retry token when database fails; retry revokes',async()=>{
 let unavailable=true;const token='synthetic-logout-token',sessions=new Set([hashToken(token)]),cookies=[];
 const POST=make({json:(body,init)=>{const r=Response.json(body,init);r.cookies={set:(...args)=>cookies.push(args)};return r;}},async()=>({}),class{async deleteSession(hash){if(unavailable)throw Error('private-dsn');sessions.delete(hash);}},'lzr_session',logout,()=>token);
 const failed=await POST(new Request('https://synthetic.invalid'));assert.equal(failed.status,503);assert.equal(failed.headers.get('cache-control'),'no-store');assert.equal((await failed.json()).ok,undefined);assert.equal(cookies.length,0);assert.equal(sessions.has(hashToken(token)),true);
 unavailable=false;const recovered=await POST(new Request('https://synthetic.invalid'));assert.equal(recovered.status,200);assert.equal((await recovered.json()).ok,true);assert.equal(sessions.size,0);assert.equal(cookies.length,1);assert.equal(cookies[0][2].maxAge,0);
 const repeated=await POST(new Request('https://synthetic.invalid'));assert.equal(repeated.status,200);assert.equal(sessions.size,0);
});
const app=await readFile(new URL('../components/lzr-hub-app.tsx',import.meta.url),'utf8');
const action=stripTypeScriptTypes(app.slice(app.indexOf('  async function signOut()'),app.indexOf('  if (logoutState !== "idle")')));
const consumer=new Function('fetch','window','setLogoutState','logoutPending',action+';return signOut;');
for(const scenario of ['503','network','bad-json','false-ok','success'])test('logout UI '+scenario,async()=>{
 const states=[],window={location:{href:'unchanged'}},pending={current:false};
 const signOut=consumer(async()=>{if(scenario==='network')throw Error('offline');if(scenario==='bad-json')return new Response('bad');return Response.json({ok:scenario==='success'},{status:scenario==='503'?503:200});},window,s=>states.push(s),pending);
 await signOut();assert.equal(window.location.href,scenario==='success'?'/login':'unchanged');assert.deepEqual(states,scenario==='success'?['pending']:['pending','failed']);assert.equal(pending.current,false);
});
test('logout UI prevents duplicate pending requests and retries after failure',async()=>{
 let complete,calls=0;const states=[],window={location:{href:'unchanged'}};
 const signOut=consumer(()=>{calls++;return new Promise(r=>complete=r);},window,s=>states.push(s),{current:false});
 const first=signOut();await signOut();assert.equal(calls,1);complete(Response.json({}, {status:503}));await first;
 const retry=signOut();assert.equal(calls,2);complete(Response.json({ok:true}));await retry;assert.equal(window.location.href,'/login');
});
