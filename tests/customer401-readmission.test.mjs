import test from 'node:test';import assert from 'node:assert/strict';import {createRequire}from'node:module';import {fileURLToPath}from'node:url';import {buildSync}from'esbuild';import React from'react';import{create,act}from'react-test-renderer';
const root=fileURLToPath(new URL('../',import.meta.url));const built=buildSync({stdin:{contents:"export{LzrHubApp}from'./components/lzr-hub-app';export{Customer360Module,CustomerDetail}from'./components/modules/customer360';export{Customer360Service}from'./lib/platform/customer360-service';",resolveDir:root},bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent'});const compiled={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);const{LzrHubApp,Customer360Module,CustomerDetail,Customer360Service}=compiled.exports;
const session=(id='actor-old')=>({authRequired:true,authenticated:true,permissions:['customer.read','support.write'],user:{id,name:id==='actor-old'?'Operador fictício anterior':'Operador fictício novo',email:id+'@example.invalid',role:'Supervisor'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function data(id,extra=false){const snapshot={customer:{id,name:'Cadastro fictício '+id,document:'SYNTHETIC',phone:'—',email:'—',address:'—',city:'—',neighborhood:'—',status:'S'},contracts:[],plan:null,invoices:[{id:id+'1',customerId:id,status:'A',data_vencimento:'2026-11-01',dueAt:'2026-11-01',value:40,valueSource:'open-balance'}],payments:[],serviceOrders:[],connection:null,partialSources:['payments'],metrics:{totalLatencyMs:0,blockLatencies:{}},fetchedAt:'2026-11-03T12:00:00Z',mode:'staging-readonly',cache:'hit'};if(extra)snapshot.invoices.push({...snapshot.invoices[0],id:id+'2'});return new Customer360Service(undefined,{getSnapshot:async()=>snapshot},[id],false,()=>new Date('2026-11-03T12:00:00Z')).get(id);}
const a=await data('810001'),b=await data('810002'),aTwo=await data('810001',true);const observations=[];
async function harness(name,run){
 const old={fetch:globalThis.fetch,window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};let ui;let actor='actor-old',meCalls=0,listCalls=0;const pending=[],pendingMe=[],logout=deferred(),intervals=new Set();
 const window={location:{hash:'#/clientes',href:'unchanged',reload(){}},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}}),addEventListener(){},removeEventListener(){},setInterval:(fn,ms)=>{const x=setInterval(fn,ms);intervals.add(x);return x;},clearInterval:x=>{intervals.delete(x);clearInterval(x);}};
 globalThis.window=window;globalThis.document={title:'Laboratório fictício',documentElement:{dataset:{}},addEventListener(){},removeEventListener(){}};globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 globalThis.fetch=(input,init={})=>{const u=new URL(input,'https://fixture.invalid');
  if(u.pathname==='/api/auth/me'){meCalls++;if(meCalls>1){const d=deferred();pendingMe.push({...d,init});return d.promise;}return Promise.resolve(Response.json(session(actor)));}if(u.pathname==='/api/auth/logout')return logout.promise;
  if(u.pathname==='/api/conversations')return Promise.resolve(Response.json({items:[]}));
  if(u.pathname==='/api/customers'&&!u.searchParams.has('id')&&init.method!=='POST'){listCalls++;return Promise.resolve(Response.json({items:[a.customer,b.customer],total:2,pageSize:10,scope:'allowlist',mode:'staging-readonly'}));}
  if(u.pathname==='/api/customers'||u.pathname==='/api/customers/payments'){const d=deferred();pending.push({url:u,init,...d});return d.promise;}
  throw Error('FORBIDDEN_FETCH');
 };
 const mount=async key=>act(async()=>{if(ui)ui.update(React.createElement(LzrHubApp,{key}));else ui=create(React.createElement(LzrHubApp,{key}));});
 const details=()=>ui.root.findByType(CustomerDetail).props,hasModule=()=>ui.root.findAllByType(Customer360Module).length===1;
 const open=async i=>act(async()=>ui.root.findAllByType('button').filter(n=>String(n.props.className).startsWith('tr stack-sm'))[i].props.onClick());
 const respond=async(entry,body,status=200)=>act(async()=>entry.resolve(Response.json(body,{status})));
 const pay=async()=>act(async()=>ui.root.findAllByType('button').find(n=>n.children.some(c=>c==='Consultar pagamentos desta fatura')).props.onClick());
 const payBoth=async()=>act(async()=>{const buttons=ui.root.findAllByType('button').filter(n=>n.children.some(c=>c==='Consultar pagamentos desta fatura'));assert.equal(buttons.length,2);for(const button of buttons)button.props.onClick();});
 const userMenu=async()=>act(async()=>ui.root.findAllByType('button').find(n=>n.props.className==='user-trigger').props.onClick());
 const signOut=async()=>{await userMenu();await act(async()=>{void ui.root.findAllByType('button').find(n=>n.props.role==='menuitem'&&n.children.some(c=>c==='Sair')).props.onClick();});};
 const renderedText=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(renderedText).join(''):node?renderedText(node.children):'';
 const visible=()=>renderedText(ui.toJSON()),listCount=()=>ui.root.findAllByType('button').filter(n=>String(n.props.className).startsWith('tr stack-sm')).length;
 try{await mount('old');await run({pending,pendingMe,logout,open,respond,pay,payBoth,paySecond:async()=>act(async()=>ui.root.findAllByType('button').filter(n=>n.children.some(c=>c==='Consultar pagamentos desta fatura'))[1].props.onClick()),userMenu,details,hasModule,hasDetail:()=>ui.root.findAllByType(CustomerDetail).length>0,visible,listCount,signOut,window,meCalls:()=>meCalls,listCalls:()=>listCalls,remountNewActor:async()=>{actor='actor-new';await mount('new');}});observations.push({name,passed:true});}
 finally{if(ui)await act(async()=>ui.unmount());assert.equal(intervals.size,0);for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
}
test('current payment401 requests one readmission without retrying the denied page',()=>harness('payment401-valid',async f=>{
 await f.open(0);await f.respond(f.pending[0],a);await f.pay();await f.respond(f.pending[1],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),2);assert.equal(f.pending.length,2);
 await f.respond(f.pendingMe[0],session());assert.equal(f.hasModule(),true);assert.equal(f.window.location.href,'unchanged');assert.equal(f.pending.length,2);
}));
test('current detail401 followed by invalid readmission unmounts protected state',()=>harness('detail401-invalid',async f=>{
 await f.open(0);await f.respond(f.pending[0],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),2);await f.respond(f.pendingMe[0],{authRequired:true,authenticated:false});assert.equal(f.hasModule(),false);assert.equal(f.window.location.href,'/login');assert.equal(f.pending.length,1);
}));
for(const status of [403,503])test('current payment'+status+' stays local without revalidation',()=>harness('local-'+status,async f=>{
 await f.open(0);await f.respond(f.pending[0],a);await f.pay();await f.respond(f.pending[1],{error:'SYNTHETIC'},status);assert.equal(f.meCalls(),1);assert.equal(f.details().data.customer.id,a.customer.id);assert.equal(f.window.location.href,'unchanged');assert.match(f.visible(),/Página não confirmada/);
}));
test('unavailable readmission blocks protected content with manual recovery, not logout success',()=>harness('unavailable-readmission',async f=>{
 await f.open(0);await f.respond(f.pending[0],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),2);await f.respond(f.pendingMe[0],{error:'SYNTHETIC'},503);assert.equal(f.hasModule(),false);assert.equal(f.window.location.href,'unchanged');assert.match(f.visible(),/verificar sua sessão/);assert.equal(f.pending.length,1);
}));
test('two concurrent401s request only one admission and never repeat either financial read',()=>harness('two401',async f=>{
 await f.open(0);await f.respond(f.pending[0],a);await f.pay();await act(async()=>{void f.details().onRefresh();});assert.equal(f.pending.length,3);
 await act(async()=>{f.pending[1].resolve(Response.json({error:'SYNTHETIC'},{status:401}));f.pending[2].resolve(Response.json({error:'SYNTHETIC'},{status:401}));});assert.equal(f.meCalls(),2);
 await f.respond(f.pendingMe[0],session());assert.equal(f.meCalls(),2);assert.equal(f.pending.length,3);assert.equal(f.hasModule(),true);
}));
test('old401 after newer customer success cannot initiate readmission',()=>harness('old401',async f=>{
 await f.open(0);await f.open(1);await f.respond(f.pending[1],b);await f.respond(f.pending[0],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),1);assert.equal(f.details().data.customer.id,b.customer.id);assert.equal(f.window.location.href,'unchanged');
}));
test('confirmed new actor discards protected state and late old JSON before showing the new actor',()=>harness('new-actor',async f=>{
 await f.open(0);await f.respond(f.pending[0],a);await f.pay();await act(async()=>{void f.details().onRefresh();});const body=deferred();await act(async()=>f.pending[2].resolve({ok:true,json:()=>body.promise}));
 await f.respond(f.pending[1],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),2);await f.respond(f.pendingMe[0],session('actor-new'));assert.equal(f.hasModule(),true);assert.equal(f.pending.length,3);
 await act(async()=>body.resolve(a));assert.doesNotMatch(f.visible(),/Fatura 8100011/);assert.equal(f.hasDetail(),false);await f.userMenu();assert.match(f.visible(),/Operador fictício novo/);assert.equal(f.pending.length,3);
}));
test('logout failure wins over a late readmission body and cannot be relabeled as revocation',()=>harness('logout-race',async f=>{
 await f.open(0);await f.respond(f.pending[0],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),2);const body=deferred();await act(async()=>f.pendingMe[0].resolve({ok:true,json:()=>body.promise}));
 await f.signOut();await f.respond(f.logout,{error:'SYNTHETIC'},503);await act(async()=>body.resolve({authenticated:false,authRequired:true}));assert.equal(f.hasModule(),false);assert.equal(f.window.location.href,'unchanged');assert.match(f.visible(),/pode continuar ativa/);assert.equal(f.meCalls(),2);
}));
test('current detail403 remains local even with a valid shell and never requests admission',()=>harness('detail403',async f=>{
 await f.open(0);await f.respond(f.pending[0],{error:'SYNTHETIC'},403);assert.equal(f.details().data,null);assert.equal(f.details().error,true);assert.equal(f.meCalls(),1);assert.equal(f.hasModule(),true);assert.equal(f.window.location.href,'unchanged');
}));
test('current401 with a malformed error body still requests admission without exposing that body',()=>harness('401-bad-body',async f=>{
 await f.open(0);await act(async()=>f.pending[0].resolve(new Response('SYNTHETIC_PRIVATE_ERROR',{status:401})));assert.equal(f.meCalls(),2);await f.respond(f.pendingMe[0],session());assert.equal(f.pending.length,1);assert.doesNotMatch(f.visible(),/SYNTHETIC_PRIVATE_ERROR/);assert.equal(f.window.location.href,'unchanged');
}));
test('readmission JSON from an obsolete selection cannot invalidate a newer successful customer',()=>harness('obsolete-readmission-body',async f=>{
 await f.open(0);await f.respond(f.pending[0],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),2);const body=deferred();await act(async()=>f.pendingMe[0].resolve({ok:true,json:()=>body.promise}));
 await f.open(1);await f.respond(f.pending[1],b);await act(async()=>body.resolve({authenticated:false,authRequired:true}));assert.equal(f.hasModule(),true);assert.equal(f.details().data.customer.id,b.customer.id);assert.equal(f.window.location.href,'unchanged');
}));
test('a legitimate newer origin can revalidate while an obsolete admission body is still pending',()=>harness('new-origin',async f=>{
 await f.open(0);await f.respond(f.pending[0],{error:'SYNTHETIC'},401);const body=deferred();await act(async()=>f.pendingMe[0].resolve({ok:true,json:()=>body.promise}));
 await f.open(1);await f.respond(f.pending[1],{error:'SYNTHETIC'},401);assert.equal(f.meCalls(),3);await f.respond(f.pendingMe[1],session('actor-new'));await act(async()=>body.resolve({authenticated:false,authRequired:true}));assert.equal(f.hasModule(),true);assert.equal(f.window.location.href,'unchanged');await f.userMenu();assert.match(f.visible(),/Operador fictício novo/);
}));
test('two still-mounted payment origins share one readmission',()=>harness('two-payment401',async f=>{
 await f.open(0);await f.respond(f.pending[0],aTwo);await f.payBoth();assert.equal(f.pending.length,3);
 await act(async()=>{f.pending[1].resolve(Response.json({error:'SYNTHETIC'},{status:401}));f.pending[2].resolve(Response.json({error:'SYNTHETIC'},{status:401}));});assert.equal(f.meCalls(),2);assert.equal(f.pendingMe.length,1);
 await f.respond(f.pendingMe[0],session());assert.equal(f.hasModule(),true);assert.equal(f.pending.length,3);assert.equal(f.window.location.href,'unchanged');
}));
test('accepted same-actor readmission invalidates pending old detail JSON without retry',()=>harness('same-actor-old-body',async f=>{
 await f.open(0);await f.respond(f.pending[0],a);await f.pay();await act(async()=>{void f.details().onRefresh();});const body=deferred();await act(async()=>f.pending[2].resolve({ok:true,json:()=>body.promise}));await f.respond(f.pending[1],{error:'SYNTHETIC'},401);
 await f.respond(f.pendingMe[0],session());await act(async()=>body.resolve(a));assert.equal(f.hasModule(),true);assert.equal(f.details().data,null);assert.equal(f.details().error,true);assert.equal(f.pending.length,3);assert.equal(f.window.location.href,'unchanged');
 await f.open(1);await f.respond(f.pending[3],b);assert.equal(f.details().data.customer.id,b.customer.id);
}));
test('same-actor admission preserves an already validated page of another invoice',()=>harness('keep-valid-page',async f=>{
 await f.open(0);await f.respond(f.pending[0],aTwo);await f.pay();await f.respond(f.pending[1],{scope:'invoice-page',mode:'staging-readonly',customerId:'810001',invoiceId:'8100011',page:1,pageSize:10,total:1,hasMore:false,observedAt:'2026-11-03T12:00:00Z',items:[{id:'990001',invoiceId:'8100011',paidAt:null,method:'Fictício',value:40}]});assert.match(f.visible(),/Pagamento 990001/);
 await f.paySecond();await f.respond(f.pending[2],{error:'SYNTHETIC'},401);await f.respond(f.pendingMe[0],session());assert.match(f.visible(),/Pagamento 990001/);assert.equal(f.pending.length,3);assert.equal(f.window.location.href,'unchanged');
}));
test('initial admission does not remount a normal screen and duplicate its list read',()=>harness('initial-list-once',async f=>{
 assert.equal(f.meCalls(),1);assert.equal(f.listCalls(),1);assert.equal(f.pending.length,0);assert.equal(f.hasModule(),true);
}));
