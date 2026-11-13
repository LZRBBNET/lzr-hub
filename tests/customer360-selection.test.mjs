import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {create,act} from 'react-test-renderer';
import {Customer360Service} from '../lib/platform/customer360-service.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=buildSync({stdin:{contents:`export {Customer360Module,CustomerDetail} from './components/modules/customer360';`,resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['react'],logLevel:'silent'});
const compiled={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);
const {Customer360Module,CustomerDetail}=compiled.exports;
async function data(id){
 const snapshot={customer:{id,name:`Cadastro sintético ${id}`,document:'SYNTHETIC',phone:'—',email:'—',address:'—',city:'—',neighborhood:'—',status:'S'},contracts:[],plan:null,invoices:[{id:id+'1',customerId:id,status:'A',dueAt:'2026-11-01',value:40,valueSource:'open-balance'}],payments:[],serviceOrders:[],connection:null,partialSources:['payments'],metrics:{totalLatencyMs:0,blockLatencies:{}},fetchedAt:id==='810001'?'2026-11-02T12:00:00Z':'2026-11-03T12:00:00Z',mode:'staging-readonly',cache:id==='810001'?'hit':'miss'};
 return new Customer360Service(undefined,{getSnapshot:async()=>snapshot},[id],false,()=>new Date('2026-11-03T12:00:00Z')).get(id);
}
async function harness(run){
 const original={fetch:globalThis.fetch,window:globalThis.window,document:globalThis.document,act:globalThis.IS_REACT_ACT_ENVIRONMENT};
 const a=await data('810001'),b=await data('810002'),pending=[];let ui;
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 globalThis.window={matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}})};
 globalThis.document={addEventListener(){},removeEventListener(){}};
 globalThis.fetch=(input,init={})=>{
  const url=new URL(input,'https://synthetic.invalid');
  if(!url.searchParams.has('id')&&init.method!=='POST')return Promise.resolve(Response.json({items:[a.customer,b.customer],total:2,pageSize:10,scope:'allowlist',mode:'staging-readonly'}));
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  pending.push({input,init,resolve,reject});return promise;
 };
 try{
  await act(async()=>{ui=create(React.createElement(Customer360Module));});
  const detail=()=>ui.root.findByType(CustomerDetail).props;
  const rows=()=>ui.root.findAllByType('button').filter(n=>String(n.props.className).startsWith('tr stack-sm'));
  const click=async index=>{await act(async()=>rows()[index].props.onClick());};
  const respond=async(entry,value,status=200)=>{await act(async()=>entry.resolve(Response.json(value,{status})));};
  await run({ui,a,b,pending,detail,click,respond,act,hasDetail:()=>ui.root.findAllByType(CustomerDetail).length>0,unmount:async()=>{await act(async()=>ui.unmount());ui=null;}});
 }finally{
  if(ui)await act(async()=>ui.unmount());
  globalThis.fetch=original.fetch;globalThis.window=original.window;globalThis.document=original.document;globalThis.IS_REACT_ACT_ENVIRONMENT=original.act;
 }
}

test('latest selected customer survives an older response resolving after the new one',()=>harness(async({a,b,pending,detail,click,respond})=>{
 await click(0);assert.equal(detail().loading,true);assert.equal(detail().data,null);
 await click(1);assert.equal(detail().loading,true);assert.equal(detail().data,null);
 await respond(pending[1],b);assert.equal(detail().data.customer.id,b.customer.id);
 assert.equal(pending[0].init.signal.aborted,true);
 await respond(pending[0],a);assert.equal(detail().data.customer.id,b.customer.id);
 assert.equal(detail().data.reading.observedAt,b.reading.observedAt);assert.equal(detail().data.sources[0].cache,'miss');
}));

test('without selection no detail request or old detail is present',()=>harness(async({pending,hasDetail})=>{
 assert.equal(pending.length,0);assert.equal(hasDetail(),false);
}));
test('old response cannot finish loading of a newer selection',()=>harness(async({a,b,pending,detail,click,respond})=>{
 await click(0);await respond(pending[0],a);assert.equal(detail().data.customer.id,a.customer.id);
 await click(0);await click(1);assert.equal(detail().data,null);assert.equal(detail().loading,true);
 await respond(pending[1],a);assert.equal(detail().data,null);assert.equal(detail().loading,true);assert.equal(detail().error,false);
 await respond(pending[2],b);assert.equal(detail().data.customer.id,b.customer.id);
}));
for(const kind of ['http','network'])test(`old ${kind} failure cannot overwrite a newer successful detail`,()=>harness(async({b,pending,detail,click,respond,act})=>{
 await click(0);await click(1);await respond(pending[1],b);
 if(kind==='http')await respond(pending[0],{error:'SYNTHETIC'},503);else await act(async()=>pending[0].reject(Error('SYNTHETIC')));
 assert.equal(detail().error,false);assert.equal(detail().data.customer.id,b.customer.id);assert.equal(detail().loading,false);
}));
test('close clears selection and aborts; reopening discards the closed request',()=>harness(async({a,b,pending,detail,click,respond,act,hasDetail})=>{
 await click(0);await act(async()=>detail().onClose());assert.equal(hasDetail(),false);assert.equal(pending[0].init.signal.aborted,true);
 await click(1);await respond(pending[0],a);assert.equal(detail().loading,true);assert.equal(detail().data,null);
 await respond(pending[1],b);assert.equal(detail().data.customer.id,b.customer.id);
}));
for(const kind of ['http','identity'])test(`current ${kind} error clears detail and next selection recovers`,()=>harness(async({b,pending,detail,click,respond})=>{
 await click(0);await respond(pending[0],kind==='http'?{error:'SYNTHETIC'}:b,kind==='http'?503:200);
 assert.equal(detail().error,true);assert.equal(detail().data,null);assert.equal(detail().loading,false);
 await click(1);assert.equal(detail().error,false);assert.equal(detail().loading,true);
 await respond(pending[1],b);assert.equal(detail().data.customer.id,b.customer.id);assert.equal(detail().refreshing,false);
}));
test('late JSON parsing from old selection cannot replace current data',()=>harness(async({a,b,pending,detail,click,respond,act})=>{
 let resolveBody;const body=new Promise(resolve=>{resolveBody=resolve;});
 await click(0);await act(async()=>pending[0].resolve({ok:true,json:()=>body}));
 await click(1);await respond(pending[1],b);await act(async()=>resolveBody(a));
 assert.equal(detail().data.customer.id,b.customer.id);assert.equal(detail().data.reading.observedAt,b.reading.observedAt);
}));
test('stale refresh preserves existing POST contract but cannot replace a new selection',()=>harness(async({a,b,pending,detail,click,respond,act})=>{
 await click(0);await respond(pending[0],a);await act(async()=>detail().onRefresh());
 assert.equal(detail().refreshing,true);assert.equal(detail().data.customer.id,a.customer.id);
 assert.equal(pending[1].input,'/api/customers');assert.equal(pending[1].init.method,'POST');assert.deepEqual(JSON.parse(pending[1].init.body),{action:'refresh',id:a.customer.id});
 await click(1);assert.equal(detail().data,null);assert.equal(detail().refreshing,false);assert.equal(pending[1].init.signal.aborted,true);
 await respond(pending[1],a);assert.equal(detail().loading,true);await respond(pending[2],b);
 assert.equal(detail().data.customer.id,b.customer.id);assert.equal(detail().data.sources[0].cache,'miss');
}));
test('unmount aborts the outstanding detail even when its transport later resolves',()=>harness(async({a,pending,click,respond,unmount})=>{
 await click(0);await unmount();assert.equal(pending[0].init.signal.aborted,true);await respond(pending[0],a);
}));
