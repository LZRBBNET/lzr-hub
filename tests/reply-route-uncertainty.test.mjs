import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({entryPoints:['app/api/conversations/reply/route.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'injected-route-deps',setup(b){
 b.onResolve({filter:/^(next\/server|@\/)/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents: ({
  'next/server':`export const NextResponse={json:(body,options={})=>({body,status:options.status??200,headers:options.headers??{}})};`,
  '@/db':`export const getDb=async()=>({});`,
  '@/lib/integrations/meta/cloud-client':`export const metaSendConfigFromEnv=()=>undefined;`,
  '@/lib/platform/attendant-reply-service':`export class DbReplyRepository{};export const attendantReplyEnabled=()=>false;export const sendAttendantReply=(...args)=>globalThis.__replyRouteFixture.send(...args);export const reconcileAttendantReply=(...args)=>globalThis.__replyRouteFixture.reconcile(...args);`,
  '@/lib/platform/n8n-channel-service':`export const CHANNEL_NAME='n8n-whatsapp';`,
  '@/lib/platform/conversation-state-service':`export class DbConversationStateRepository{};export const claimIfUnassigned=()=>globalThis.__replyRouteFixture.claim();`,
  '@/lib/platform/session-guard':`export const authorize=(...args)=>globalThis.__replyRouteFixture.auth(...args);`,
 })[path]}));
}}]});
const route=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const request=()=>new Request('https://fixture.invalid/api/conversations/reply',{method:'POST',body:JSON.stringify({conversationId:'5579991234567',text:'Olá',idempotencyKey:'attempt-1234'})});
test('post-acceptance assignment failure remains uncertain, never states nothing sent',async()=>{
 let sends=0;
 globalThis.__replyRouteFixture={auth:async()=>({allowed:true,user:{email:'fixture@example.invalid',role:'admin'}}),send:async()=>{sends++;return {ok:true,messageId:'wamid.fixture',duplicate:false,recorded:true};},claim:async()=>{throw Error('fixture only');}};
 const r=await route.POST(request());assert.equal(sends,1);assert.equal(r.status,503);assert.equal(r.body.retrySafe,false);assert.doesNotMatch(r.body.error,/Nada foi enviado/);
});
test('reconciliation preserves RBAC and requires actual session; successful read is no-store',async()=>{
 let reads=0;
 const req=new Request('https://fixture.invalid/api/conversations/reply?conversationId=5579991234567&idempotencyKey=attempt-1234');
 globalThis.__replyRouteFixture={auth:async(_r,permission)=>{assert.equal(permission,'support.write');return {allowed:false,status:403,error:'forbidden'};},reconcile:async()=>{reads++;return {state:'pending'};}};
 assert.equal((await route.GET(req)).status,403);assert.equal(reads,0);
 globalThis.__replyRouteFixture.auth=async()=>({allowed:true});assert.equal((await route.GET(req)).status,401);assert.equal(reads,0);
 globalThis.__replyRouteFixture.auth=async()=>({allowed:true,user:{email:'fixture@example.invalid',role:'admin'}});
 const r=await route.GET(req);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.body.state,'pending');assert.equal(reads,1);
});
test.after(()=>{delete globalThis.__replyRouteFixture;});
