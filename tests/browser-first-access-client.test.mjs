import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {createHash} from 'node:crypto';
const source=readFileSync(new URL('../public/first-access/browser.js',import.meta.url),'utf8');
function fixture(storage=new Map()){
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:id!=='prepare',value:'',textContent:'',checked:false});return nodes.get(id);};
 const calls=[],events={};let now=Date.parse('2026-11-06T12:00:00Z');
 class Clock extends Date {static now(){return now;}}
 const token='11'.repeat(32),attempt='synthetic-init-browser-00000000-0000-4000-8000-000000000000';
 const state={postFailure:false,waiting:false,held:null,digestHeld:null};const timers=new Map();let timerId=0;const localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
 vm.runInNewContext(source,{document:{getElementById:node},location:{origin:'https://synthetic-browser.onrender.com',protocol:'https:',hostname:'synthetic-browser.onrender.com',port:'',search:'',hash:''},isSecureContext:true,Date:Clock,Uint8Array,Array,TextEncoder,TextDecoder,AbortSignal,JSON,Error,
 crypto:{getRandomValues:bytes=>{bytes.fill(0x11);return bytes;},randomUUID:()=> '00000000-0000-4000-8000-000000000000',subtle:{digest:async(_algorithm,input)=>{if(state.digestHeld)await state.digestHeld;return createHash('sha256').update(input).digest();}}},
 localStorage,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),addEventListener:(name,fn)=>{events[name]=fn;},fetch:async(url,init)=>{
  calls.push({url,method:init.method,headers:{...init.headers},body:init.body});assert.equal(init.headers['x-synthetic-init-capability'],token);assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');assert.equal(url.includes(token),false);
  if(init.method==='POST'){if(state.postFailure)throw Error('synthetic-network-error');return Response.json({state:'completion-confirmed',retryAllowed:false},{status:201});}
  if(url.includes('status=1'))return Response.json({state:'completion-observed',retryAllowed:false});
  if(state.held)await state.held;
  if(state.waiting)return Response.json({error:'Indisponível',retryAllowed:false},{status:404});
  return Response.json({state:'ready',attempt,databaseOid:'12345',expiresAt:new Date(now+900000).toISOString(),retryAllowed:false});
 }});
 return{nodes,node,calls,state,events,storage,timers,expire:()=>{now+=900001;}};
}
test('public preparation never requests network or prints raw key; password is sent once only after approval',async()=>{
 const f=fixture();await f.node('prepare').onclick();assert.equal(f.calls.length,0);
 assert.match(f.node('configuration').textContent,/SYNTHETIC_INIT_CAPABILITY_SHA256=/);assert.equal(f.node('configuration').textContent.includes('11'.repeat(32)),false);
 await f.node('check').onclick();assert.equal(f.calls.length,1);assert.equal(f.node('submit').disabled,false);
 f.node('password').value=f.node('repeat').value='invented-only-password';f.node('approve').checked=true;
 await f.node('setup').onsubmit({preventDefault(){}});await f.node('setup').onsubmit({preventDefault(){}});
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(JSON.parse(f.calls[1].body).password,'invented-only-password');
 assert.equal(f.node('password').value,'');assert.equal(f.node('repeat').value,'');assert.match(f.node('message').textContent,/Conclusão confirmada/);
 assert.equal([...f.nodes.values()].some(n=>n.textContent.includes('invented-only-password')),false);
});
test('no approval or mismatched password never sends POST; uncertain result offers GET only',async()=>{
 const f=fixture();await f.node('prepare').onclick();await f.node('check').onclick();
 f.node('password').value='invented-only-password';f.node('repeat').value='different';
 await f.node('setup').onsubmit({preventDefault(){}});assert.equal(f.calls.length,1);
 f.node('repeat').value='invented-only-password';await f.node('setup').onsubmit({preventDefault(){}});assert.equal(f.calls.length,1);
 f.node('approve').checked=true;f.state.postFailure=true;await f.node('setup').onsubmit({preventDefault(){}});
 assert.match(f.node('message').textContent,/NÃO repita/);await f.node('setup').onsubmit({preventDefault(){}});
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);await f.node('status').onclick();assert.equal(f.calls.at(-1).method,'GET');assert.match(f.node('message').textContent,/não autoriza repetir escrita/i);
});
test('expired tab and restored page cannot send requests',async()=>{
 const f=fixture();await f.node('prepare').onclick();f.expire();await f.node('check').onclick();assert.equal(f.calls.length,0);
 const g=fixture();await g.node('prepare').onclick();g.events.pagehide();g.events.pageshow({persisted:true});assert.equal(g.node('submit').disabled,true);await g.node('check').onclick();assert.equal(g.calls.length,0);
});

test('premature check waits read-only; repeated clicks do not mint key or extend deadline',async()=>{
 const f=fixture();await f.node('prepare').onclick();const original=f.node('configuration').textContent;f.state.waiting=true;
 await f.node('check').onclick();assert.equal(f.node('check').disabled,false);assert.match(f.node('message').textContent,/aguardando/);assert.equal(f.timers.size,1);
 await f.node('check').onclick();assert.equal(f.timers.size,1);await f.node('prepare').onclick();assert.equal(f.node('configuration').textContent,original);assert.ok(f.calls.every(c=>c.method==='GET'));
 f.state.waiting=false;await f.node('check').onclick();assert.equal(f.node('submit').disabled,false);assert.equal(f.timers.size,0);
 assert.doesNotMatch(JSON.stringify([...f.storage.values()]),new RegExp('11'.repeat(32)));
});
test('reload or second tab keeps only public marker and cannot mint another capability',async()=>{
 const f=fixture();await f.node('prepare').onclick();for(const other of [fixture(f.storage),fixture(f.storage)]){assert.equal(other.node('prepare').disabled,true);await other.node('prepare').onclick();assert.equal(other.calls.length,0);assert.equal(other.node('configuration').textContent,'');assert.match(other.node('message').textContent,/aba original/);}
});
test('late GET after navigation never reopens password admission',async()=>{
 const f=fixture();await f.node('prepare').onclick();let release;f.state.held=new Promise(r=>release=r);const pending=f.node('check').onclick();f.events.pagehide();release();await pending;assert.equal(f.node('submit').disabled,true);assert.equal(f.node('password').disabled,true);assert.equal(f.timers.size,0);f.events.pageshow({persisted:true});assert.equal(f.node('prepare').disabled,true);
});
test('waiting expires without network or extension; another-tab change ends admission',async()=>{
 const f=fixture();await f.node('prepare').onclick();f.state.waiting=true;await f.node('check').onclick();const next=[...f.timers.values()][0];f.expire();await next();await Promise.resolve();assert.equal(f.calls.length,1);assert.equal(f.node('submit').disabled,true);
 const g=fixture();await g.node('prepare').onclick();await g.node('check').onclick();g.node('password').value=g.node('repeat').value='invented-only-password';g.events.storage({key:'lzr-first-access-public-attempt-v1'});assert.equal(g.node('password').value,'');assert.equal(g.node('repeat').value,'');assert.equal(g.node('submit').disabled,true);assert.equal(g.node('prepare').disabled,true);
});
test('uncertain POST then reload cannot replay; secret never enters marker',async()=>{
 const f=fixture();await f.node('prepare').onclick();await f.node('check').onclick();f.node('password').value=f.node('repeat').value='invented-only-password';f.node('approve').checked=true;f.state.postFailure=true;await f.node('setup').onsubmit({preventDefault(){}});
 assert.match([...f.storage.values()][0],/submitted/);assert.doesNotMatch([...f.storage.values()][0],/invented-only-password/);
 const reloaded=fixture(f.storage);await reloaded.node('setup').onsubmit({preventDefault(){}});assert.equal(reloaded.calls.length,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('late digest after navigation or another-tab marker cannot revive preparation',async()=>{
 for(const change of ['pagehide','storage']){const f=fixture();let release;f.state.digestHeld=new Promise(r=>release=r);const pending=f.node('prepare').onclick();
 if(change==='pagehide')f.events.pagehide();else f.events.storage({key:'lzr-first-access-public-attempt-v1'});
 release();await pending;assert.equal(f.node('check').disabled,true);assert.equal(f.node('configuration').textContent,'');assert.equal(f.storage.size,0);assert.equal(f.calls.length,0);}
});
test('GET returns after expiry: no admission and explicit expiration instead of waiting',async()=>{
 const f=fixture();await f.node('prepare').onclick();let release;f.state.held=new Promise(r=>release=r);const pending=f.node('check').onclick();f.expire();release();await pending;
 assert.equal(f.node('submit').disabled,true);assert.match(f.node('message').textContent,/Prazo encerrado/);assert.equal(f.timers.size,0);
});
