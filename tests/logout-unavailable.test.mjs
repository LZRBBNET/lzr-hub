import {createCustomerSessionAdmission} from '../lib/platform/customer-session-admission.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {NextResponse} from 'next/server.js';
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
const consumer=new Function('fetch','window','setLogoutState','logoutPending','admitted',action+';return signOut;');
for(const scenario of ['401','503','network','bad-json','false-ok','success'])test('logout UI '+scenario,async()=>{
 const states=[],window={location:{href:'unchanged'}},pending={current:false};
 const signOut=consumer(async()=>{if(scenario==='network')throw Error('offline');if(scenario==='bad-json')return new Response('bad');return Response.json({ok:scenario==='success'},{status:scenario==='503'?503:scenario==='401'?401:200});},window,s=>states.push(s),pending,{admission:createCustomerSessionAdmission()});
 await signOut();assert.equal(window.location.href,['success','401'].includes(scenario)?'/login':'unchanged');assert.deepEqual(states,['success','401'].includes(scenario)?['pending']:['pending','failed']);assert.equal(pending.current,false);
});
test('logout UI prevents duplicate pending requests and retries after failure',async()=>{
 let complete,calls=0;const states=[],window={location:{href:'unchanged'}};
 const signOut=consumer(()=>{calls++;return new Promise(r=>complete=r);},window,s=>states.push(s),{current:false},{admission:createCustomerSessionAdmission()});
 const first=signOut();await signOut();assert.equal(calls,1);complete(Response.json({}, {status:503}));await first;
 const retry=signOut();assert.equal(calls,2);complete(Response.json({ok:true}));await retry;assert.equal(window.location.href,'/login');
});

const guard=await readFile(new URL('../lib/platform/session-guard.ts',import.meta.url),'utf8');
const parser=stripTypeScriptTypes(guard.slice(guard.indexOf('export function readSessionToken'),guard.indexOf('export async function sessionState'))).replace('export ','');
const readToken=new Function('SESSION_COOKIE',parser+';return readSessionToken;')('lzr_session');
for(const scenario of ['malformed','absent','empty','valid','unavailable','db-init-failure'])test('logout real cookie parsing '+scenario,async()=>{
 let dbCalls=0,deleteCalls=0;
 const POST=make(NextResponse,async()=>{dbCalls++;if(scenario==='db-init-failure')throw Error('private-dsn');return {};},class{async deleteSession(){deleteCalls++;if(scenario==='unavailable')throw Error('private-dsn');}},'lzr_session',logout,readToken);
 const invalid=['malformed','absent','empty'].includes(scenario),unavailable=['unavailable','db-init-failure'].includes(scenario);
 const request=new Request('https://synthetic.invalid',{headers:scenario==='absent'?{}:{cookie:'lzr_session='+(scenario==='malformed'?'%ZZ':scenario==='empty'?'':'synthetic-valid')}});
 const response=await POST(request),body=await response.json();
 assert.equal(response.status,invalid?401:unavailable?503:200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(dbCalls,invalid?0:1);assert.equal(deleteCalls,invalid||scenario==='db-init-failure'?0:1);
 assert.equal(body.ok,invalid||unavailable?undefined:true);assert.doesNotMatch(JSON.stringify(body),/private-dsn|revogad/i);
 if(!unavailable){const cookie=response.headers.get('set-cookie');assert.match(cookie,/Max-Age=0/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Path=\//);assert.match(cookie,/SameSite=lax/i);}else assert.equal(response.headers.get('set-cookie'),null);
});
