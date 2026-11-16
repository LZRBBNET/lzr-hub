import test from 'node:test';
import assert from 'node:assert/strict';
import { runReplyAttempt } from '../lib/platform/reply-attempt-client.ts';
const input = {journalKey:'opaque-conversation-digest',conversationId:'5579991234567',text:'Olá!'};
const response = (payload,ok=true) => ({ok,json:async()=>payload});
function setup(fetcher) {
 const data = new Map(); const calls=[];
 return {data,calls,deps:{storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},uuid:()=> 'attempt-unique-123',lock:async(_n,fn)=>fn(),fetch:async(...args)=>{calls.push(args); return fetcher(...args);}}};
}
test('lost POST response: repeated click and reload reconcile only, even with changed draft',async()=>{
 const f=setup(async(_url,init)=>{if(init?.method==='POST')throw Error('lost response');return response({state:'unknown'});});
 assert.equal((await runReplyAttempt(f.deps,input)).accepted,false);
 assert.equal((await runReplyAttempt({...f.deps},{...input,text:'Outro texto'})).accepted,false);
 assert.equal((await runReplyAttempt({...f.deps},{...input,text:'',reconcileOnly:true})).accepted,false);
 assert.equal(f.calls.filter(c=>c[1]?.method==='POST').length,1);
 assert.equal(f.data.size,1);
 assert.deepEqual([...f.data.values()],['attempt-unique-123']);
});
test('acceptance recovered from existing claim does not resend or claim delivery/history',async()=>{
 const f=setup(async()=>response({state:'sent',messageId:'wamid.test'}));f.data.set(input.journalKey,'attempt-unique-123');
 assert.deepEqual(await runReplyAttempt(f.deps,input),{accepted:true,recovered:true,recorded:false});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][1]?.method,undefined);assert.equal(f.data.size,0);
});
for(const state of ['absent','pending','unknown','invalid'])test(`reconciliation ${state} never permits new POST`,async()=>{
 const f=setup(async()=>response({state}));f.data.set(input.journalKey,'attempt-unique-123');
 assert.equal((await runReplyAttempt(f.deps,input)).accepted,false);assert.equal(f.data.size,1);assert.equal(f.calls[0][1]?.method,undefined);
});
test('explicit safe pre-send refusal permits corrected new attempt',async()=>{
 const f=setup(async()=>response({error:'janela fechada',retrySafe:true},false));
 assert.equal((await runReplyAttempt(f.deps,input)).accepted,false);assert.equal(f.data.size,0);
});
test('malformed success, refusal without safety proof and corrupt JSON preserve reservation',async()=>{
 for(const r of [response({ok:true}),response({error:'falhou'},false),{ok:true,json:async()=>{throw Error();}}]){
 const f=setup(async()=>r);assert.equal((await runReplyAttempt(f.deps,input)).accepted,false);assert.equal(f.data.size,1);
 }
});
test('journal unavailable fails before transport; read-only reconciliation without journal sends nothing',async()=>{
 const f=setup(async()=>{throw Error('must not call');});
 assert.equal((await runReplyAttempt(f.deps,{...input,reconcileOnly:true})).accepted,false);
 f.deps.storage.setItem=()=>{throw Error('quota');};
 assert.equal((await runReplyAttempt(f.deps,input)).accepted,false);assert.equal(f.calls.length,0);
});
test('exclusive nonqueued lock rejects simultaneous caller without second transport',async()=>{
 let release;let busy=false;
 const f=setup(()=>new Promise(r=>{release=()=>r(response({ok:true,messageId:'wamid.test',recorded:true}));}));
 f.deps.lock=async(_n,fn)=>{if(busy)throw Error('busy');busy=true;try{return await fn();}finally{busy=false;}};
 const first=runReplyAttempt(f.deps,input);
 await assert.rejects(runReplyAttempt(f.deps,input),/busy/);release();
 assert.equal((await first).accepted,true);assert.equal(f.calls.length,1);
});
