import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {createRequire} from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {once} from 'node:events';
import {installSyntheticEgress} from '../lib/runtime/synthetic-egress.mjs';
import {assertSyntheticDemo,createSyntheticInvoiceDemo} from '../lib/integrations/ixc/synthetic-demo.ts';
import {stagingDemoRequirements} from '../lib/runtime/staging-demo.ts';
import {assertSyntheticWeb,syntheticWebRequested} from '../lib/runtime/synthetic-web.ts';
const require=createRequire(import.meta.url);
const flags=()=>({...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://fixture.invalid'});
test('synthetic provider preserves real invoice ownership and refuses external binding',async()=>{
 const config=flags();assert.throws(()=>assertSyntheticDemo({...config,IXC_DIRECT_AUTHORIZATION:'SYNTHETIC_NOT_A_SECRET'}));
 const demo=createSyntheticInvoiceDemo(()=>config);
 const page=await demo.provider.getInvoicePaymentPage('10','901',1,'synthetic');assert.equal(page.total,0);
 await assert.rejects(demo.provider.getInvoicePaymentPage('20','901',1,'synthetic'));
 demo.markPaid();const paid=await demo.provider.getInvoicePaymentPage('10','901',1,'synthetic');assert.equal(paid.total,1);
});
test('request boundary keeps unavailable session503, invalid401 and provisional403',async()=>{
 const old={...process.env};Object.assign(process.env,flags());
 try{
  for(const scenario of ['unavailable','invalid','provisional','valid']){
   const modules={'next/server':require('next/server'),'./lib/platform/session-guard.ts':{sessionState:async()=>({unavailable:scenario==='unavailable',user:scenario==='valid'||scenario==='provisional'?{mustChangePassword:scenario==='provisional'}:undefined})},'./lib/runtime/synthetic-web.ts':{assertSyntheticWeb,syntheticWebRequested},'./lib/platform/browser-initialization.ts':{browserSetupRequested:()=>false},'./lib/platform/synthetic-initialization-access.ts':{initializationAccess:()=>false}};
   const result={exports:{}};const code=transformSync(readFileSync(new URL('../proxy.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
   new Function('require','module','exports',code)(n=>{assert.ok(Object.hasOwn(modules,n));return modules[n];},result,result.exports);
   const response=await result.exports.proxy(new Request('https://fixture.invalid/api/customers'));
   assert.equal(response.status,{unavailable:503,invalid:401,provisional:403,valid:200}[scenario]);
   if(scenario==='provisional')assert.equal((await result.exports.proxy(new Request('https://fixture.invalid/api/auth/logout',{method:'POST',headers:{origin:'https://fixture.invalid'}}))).status,200);
  }
 }finally{for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});
test('process egress blocks fetch HTTP HTTPS and other sockets; only declared local synthetic DB socket permitted',async()=>{
 const server=net.createServer(s=>s.end());server.listen(0,'127.0.0.1');await once(server,'listening');
 const restore=installSyntheticEgress(`postgresql://synthetic:invented@127.0.0.1:${server.address().port}/synthetic`);
 try{
  await assert.rejects(fetch('https://external.invalid'),/SYNTHETIC_EXTERNAL_TRANSPORT_BLOCKED/);
  for(const action of [()=>http.get('http://external.invalid'),()=>https.request('https://external.invalid'),()=>net.connect({host:'external.invalid',port:443}),()=>net.connect({path:'/tmp/forbidden-socket'})])assert.throws(action,/SYNTHETIC_EXTERNAL_TRANSPORT_BLOCKED/);
  const socket=net.connect({host:'127.0.0.1',port:server.address().port});await once(socket,'close');
 }finally{restore();await new Promise(resolve=>server.close(resolve));}
});
