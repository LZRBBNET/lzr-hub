import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync,transformSync} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {create,act} from 'react-test-renderer';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url));
test('payment handler derives demo label from server opt-in, never request',async()=>{
 const old=process.env.FEATURE_SYNTHETIC_INVOICES;process.env.FEATURE_SYNTHETIC_INVOICES='true';
 const page={customerId:'10',invoiceId:'901',page:1,pageSize:10,total:0,hasMore:false,scope:'invoice-page',items:[]};
 const deps={'next/server':require('next/server'),'node:crypto':require('node:crypto'),'@/lib/platform/session-guard':{authorize:async()=>({allowed:true,user:{id:'synthetic'}})},'@/lib/integrations/ixc/runtime':{getIxcRuntime:()=>({provider:{getInvoicePaymentPage:async()=>page}})},'@/lib/platform/audit-log':{logUnauthenticatedAction:async()=>{}}};
 const compiled={exports:{}};new Function('require','module','exports',transformSync(readFileSync(root+'app/api/customers/payments/route.ts','utf8'),{loader:'ts',format:'cjs'}).code)(n=>{assert.ok(Object.hasOwn(deps,n));return deps[n];},compiled,compiled.exports);
 try{
  const response=await compiled.exports.GET(new Request('https://fixture.invalid/api/customers/payments?id=10&invoiceId=901&page=1'));assert.equal(response.status,200);assert.equal((await response.json()).mode,'demo');
  assert.equal((await compiled.exports.GET(new Request('https://fixture.invalid/api/customers/payments?id=10&invoiceId=901&page=1&mode=demo'))).status,400);
 }finally{if(old===undefined)delete process.env.FEATURE_SYNTHETIC_INVOICES;else process.env.FEATURE_SYNTHETIC_INVOICES=old;}
});
const compiled={exports:{}};const built=buildSync({stdin:{contents:"export {InvoicePaymentPages} from './components/invoice-payment-pages';",resolveDir:root},bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent'});
new Function('require','module','exports',built.outputFiles[0].text)(require,compiled,compiled.exports);
for(const expected of ['demo','staging-readonly'])for(const returned of ['demo','staging-readonly'])test(`page origin ${expected} accepts only ${expected}, response ${returned}`,async()=>{
 const oldFetch=globalThis.fetch,oldAct=globalThis.IS_REACT_ACT_ENVIRONMENT;let ui;
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.fetch=async()=>Response.json({mode:returned,scope:'invoice-page',customerId:'10',invoiceId:'901',page:1,pageSize:10,total:0,hasMore:false,observedAt:'2026-11-13T12:00:00Z',items:[]});
 try{
  await act(async()=>{ui=create(React.createElement(compiled.exports.InvoicePaymentPages,{customerId:'10',invoiceId:'901',expectedMode:expected}));});
  await act(async()=>ui.root.findByType('button').props.onClick());
  const text=JSON.stringify(ui.toJSON());
  if(expected!==returned)assert.match(text,/Página não confirmada/);
  else assert.match(text,expected==='demo'?/Fonte sintética; dados fictícios/:/Fonte IXC somente leitura/);
 }finally{if(ui)await act(async()=>ui.unmount());globalThis.fetch=oldFetch;if(oldAct===undefined)delete globalThis.IS_REACT_ACT_ENVIRONMENT;else globalThis.IS_REACT_ACT_ENVIRONMENT=oldAct;}
});
