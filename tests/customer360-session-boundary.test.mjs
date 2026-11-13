import test from 'node:test';import assert from 'node:assert/strict';import {buildSync} from 'esbuild';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import React from 'react';import {create,act} from 'react-test-renderer';import {Customer360Service} from '../lib/platform/customer360-service.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=buildSync({stdin:{contents:"export{LzrHubApp}from'./components/lzr-hub-app';export{Customer360Module,CustomerDetail}from'./components/modules/customer360';",resolveDir:root},bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent'});
const compiled={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);const{LzrHubApp,Customer360Module}=compiled.exports;
const deferred=()=>{let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n});return{promise,resolve,reject};};
const snapshot={customer:{id:'810001',name:'Cadastro exclusivamente fictício',document:'SYNTHETIC',phone:'—',email:'—',address:'—',city:'—',neighborhood:'—',status:'S'},contracts:[],plan:null,invoices:[{id:'990001',customerId:'810001',status:'A',dueAt:'2026-11-01',value:40,valueSource:'open-balance'}],payments:[],serviceOrders:[],connection:null,partialSources:['payments'],metrics:{totalLatencyMs:0,blockLatencies:{}},fetchedAt:'2026-11-03T12:00:00Z',mode:'staging-readonly',cache:'hit'};
const data=await new Customer360Service(undefined,{getSnapshot:async()=>snapshot},['810001'],false,()=>new Date('2026-11-03T12:00:00Z')).get('810001');
// Deliberately uses the original PR70 Customer360Module, not the PR71 selection/abort patch.
const results=[];
async function scenario(name,run){
 const old={fetch:globalThis.fetch,window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};let ui;
 const me=deferred(),detail=deferred(),logout=deferred(),payment=deferred();let detailSignal,pageSignal;const intervals=new Set();const events=new Map();const window={location:{hash:'#/clientes',href:'unchanged',reload(){}},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}}),addEventListener:(k,f)=>{if(!events.has(k))events.set(k,new Set());events.get(k).add(f);},removeEventListener:(k,f)=>events.get(k)?.delete(f),setInterval:(fn,ms)=>{const id=setInterval(fn,ms);intervals.add(id);return id;},clearInterval:id=>{intervals.delete(id);clearInterval(id);}};
 globalThis.window=window;globalThis.document={title:'LZR laboratório',documentElement:{dataset:{}},addEventListener(){},removeEventListener(){}};globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 globalThis.fetch=(input,init={})=>{const u=new URL(input,'https://fixture.invalid');if(u.pathname==='/api/auth/me')return me.promise;if(u.pathname==='/api/auth/logout')return logout.promise;if(u.pathname==='/api/customers/payments'){pageSignal=init.signal;return payment.promise;}if(u.pathname==='/api/conversations')return Promise.resolve(Response.json({items:[]}));if(u.pathname==='/api/customers'){if(u.searchParams.has('id')){detailSignal=init.signal;return detail.promise;}return Promise.resolve(Response.json({items:[data.customer],total:1,pageSize:10,scope:'allowlist',mode:'staging-readonly'}));}throw Error('UNEXPECTED_FETCH');};
 try{
  await act(async()=>{ui=create(React.createElement(LzrHubApp));});
  const rows=()=>ui.root.findAllByType('button').filter(n=>String(n.props.className).startsWith('tr stack-sm'));
  const open=async()=>act(async()=>rows()[0].props.onClick());
  const signOut=async()=>{await act(async()=>ui.root.findAllByType('button').find(n=>n.props.className==='user-trigger').props.onClick());await act(async()=>{void ui.root.findAllByType('button').find(n=>n.props.role==='menuitem'&&n.children.some(x=>x==='Sair')).props.onClick();});};
  const hasModule=()=>ui.root.findAllByType(Customer360Module).length>0;
  await run({ui,me,detail,logout,payment,window,open,signOut,hasModule,intervals,detailSignal:()=>detailSignal,pageSignal:()=>pageSignal});results.push({name,passed:true});
 }finally{if(ui)await act(async()=>ui.unmount());for(const[k,v]of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
}
const valid={authRequired:true,authenticated:true,user:{name:'Operador fictício',email:'operator@example.invalid',role:'Supervisor'},permissions:['customer.read']};
for(const kind of ['success','failure','401'])test('public logout '+kind+' unmounts pending detail before its late response',()=>scenario('logout-'+kind,async({ui,me,detail,logout,open,signOut,hasModule,window,detailSignal})=>{
 await act(async()=>me.resolve(Response.json(valid)));await open();await signOut();assert.equal(hasModule(),false);assert.equal(detailSignal(),undefined,'PR70 detail has no transport cancellation; shell unmount is required');
 await act(async()=>logout.resolve(Response.json(kind==='success'?{ok:true}:{error:'SYNTHETIC'},{status:kind==='success'?200:kind==='401'?401:503})));assert.equal(window.location.href,kind==='failure'?'unchanged':'/login');
 if(kind==='failure')assert.match(JSON.stringify(ui.toJSON()),/pode continuar ativa/);
 await act(async()=>detail.resolve(Response.json(data)));assert.equal(hasModule(),false);
}));
test('known invalid session unmounts customer and discards pending detail before navigation completes',()=>scenario('known-invalid',async({me,detail,open,hasModule,window,detailSignal,intervals})=>{
 await open();await act(async()=>me.resolve(Response.json({authRequired:true,authenticated:false,permissions:[]})));assert.equal(window.location.href,'/login');
 await act(async()=>detail.resolve(Response.json(data)));assert.equal(hasModule(),false);assert.equal(detailSignal(),undefined,'PR70 detail has no transport cancellation; shell unmount is required');assert.equal(intervals.size,0);
}));
test('known invalid session also discards body parsing that started before the response',()=>scenario('known-invalid-body',async({me,detail,open,hasModule})=>{
 const body=deferred();await open();await act(async()=>detail.resolve({ok:true,json:()=>body.promise}));
 await act(async()=>me.resolve(Response.json({authRequired:true,authenticated:false,permissions:[]})));
 await act(async()=>body.resolve(data));assert.equal(hasModule(),false);
}));
test('session lookup unavailable hides pending detail without claiming successful logout',()=>scenario('session-unavailable',async({ui,me,detail,open,hasModule,window,detailSignal})=>{
 await open();await act(async()=>me.resolve(Response.json({error:'SYNTHETIC'},{status:503})));assert.equal(hasModule(),false);assert.equal(window.location.href,'unchanged');assert.equal(detailSignal(),undefined,'PR70 detail has no transport cancellation; shell unmount is required');assert.match(JSON.stringify(ui.toJSON()),/verificar sua sessão/);
 await act(async()=>detail.resolve(Response.json(data)));assert.equal(hasModule(),false);
}));
for(const kind of ['success','failure'])test('public logout '+kind+' discards a pending invoice payment page',()=>scenario('payments-'+kind,async({ui,me,detail,payment,logout,open,signOut,hasModule,window,pageSignal})=>{
 await act(async()=>me.resolve(Response.json(valid)));await open();await act(async()=>detail.resolve(Response.json(data)));
 await act(async()=>ui.root.findAllByType('button').find(n=>n.children.some(v=>v==='Consultar pagamentos desta fatura')).props.onClick());assert.ok(pageSignal());
 await signOut();assert.equal(hasModule(),false);assert.equal(pageSignal().aborted,true);
 await act(async()=>logout.resolve(Response.json(kind==='success'?{ok:true}:{error:'SYNTHETIC'},{status:kind==='success'?200:503})));assert.equal(window.location.href,kind==='success'?'/login':'unchanged');
 const page={scope:'invoice-page',mode:'staging-readonly',customerId:'810001',invoiceId:'990001',page:1,pageSize:10,total:1,hasMore:false,observedAt:'2026-11-03T12:00:00Z',items:[{id:'SYNTHETIC_PAYMENT',invoiceId:'990001',paidAt:null,method:'Fictício',value:40}]};
 await act(async()=>payment.resolve(Response.json(page)));assert.equal(hasModule(),false);assert.doesNotMatch(JSON.stringify(ui.toJSON()),/SYNTHETIC_PAYMENT/);
}));
