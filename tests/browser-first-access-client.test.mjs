import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {createHash} from 'node:crypto';
const source=readFileSync(new URL('../public/first-access/browser.js',import.meta.url),'utf8');
function fixture(){
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:id!=='prepare',value:'',textContent:'',checked:false});return nodes.get(id);};
 const calls=[],events={};let now=Date.parse('2026-11-06T12:00:00Z');
 class Clock extends Date {static now(){return now;}}
 const token='11'.repeat(32),attempt='synthetic-init-browser-00000000-0000-4000-8000-000000000000';
 const state={postFailure:false};
 vm.runInNewContext(source,{document:{getElementById:node},location:{origin:'https://synthetic-browser.onrender.com',protocol:'https:',hostname:'synthetic-browser.onrender.com',port:'',search:'',hash:''},isSecureContext:true,Date:Clock,Uint8Array,Array,TextEncoder,TextDecoder,AbortSignal,JSON,Error,
 crypto:{getRandomValues:bytes=>{bytes.fill(0x11);return bytes;},randomUUID:()=> '00000000-0000-4000-8000-000000000000',subtle:{digest:async(_algorithm,input)=>createHash('sha256').update(input).digest()}},
 addEventListener:(name,fn)=>{events[name]=fn;},fetch:async(url,init)=>{
  calls.push({url,method:init.method,headers:{...init.headers},body:init.body});assert.equal(init.headers['x-synthetic-init-capability'],token);assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');assert.equal(url.includes(token),false);
  if(init.method==='POST'){if(state.postFailure)throw Error('synthetic-network-error');return Response.json({state:'completion-confirmed',retryAllowed:false},{status:201});}
  if(url.includes('status=1'))return Response.json({state:'completion-observed',retryAllowed:false});
  return Response.json({state:'ready',attempt,databaseOid:'12345',expiresAt:new Date(now+900000).toISOString(),retryAllowed:false});
 }});
 return{nodes,node,calls,state,events,expire:()=>{now+=900001;}};
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
