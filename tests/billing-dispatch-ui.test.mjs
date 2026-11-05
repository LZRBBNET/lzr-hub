// Offline UI verification with synthetic responses only; no browser, database or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';
import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import postcss from 'postcss';

const root=fileURLToPath(new URL('../',import.meta.url));
const built=buildSync({stdin:{contents:"export {BillingModule} from './components/modules/billing';",resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','react-dom/server'],logLevel:'silent'});
const compiled={exports:{}};
new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);
const {BillingModule}=compiled.exports;
const originalFetch=globalThis.fetch,originalActEnvironment=globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const mounted=new Set();
const flatten=node=>node==null?'':Array.isArray(node)?node.map(flatten).join(' '):typeof node==='object'?flatten(node.children):String(node);
const content=renderer=>flatten(renderer.toJSON()).replace(/\s+/g,' ');
const button=(renderer,label)=>renderer.root.findAllByType('button').find(node=>flatten(node).includes(label));
const click=async(renderer,label)=>{const target=button(renderer,label);assert.ok(target,label);await act(async()=>{target.props.onClick()});};
const total=renderer=>{const card=renderer.root.findAllByType('article').find(node=>flatten(node).includes('Disparos registrados'));return card?flatten(card.findByProps({className:'stat-value'})):null;};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject};};
const preview=(value=0)=>({available:true,period:'30d',today:{scheduledFor:'2026-11-05',candidates:1},indicators:{total:value,byStep:{}}});
const run=(overrides={})=>({scheduledFor:'2026-11-05',businessHour:true,candidates:1,recorded:1,duplicates:0,enqueued:0,queueEnabled:false,...overrides});
const rule={available:true,rule:{name:'Régua sintética',version:1,updatedAt:'2026-11-05T12:00:00Z',authorId:'synthetic-operator',steps:[{offsetDays:1,channel:'WhatsApp',templateId:'fixture-template',attempts:1,active:true}]}};
async function mount(handler,{strict=false}={}){
 const calls=[];globalThis.fetch=async(url,init={})=>{
  if(url==='/api/billing/rules')return Response.json(rule);
  assert.match(url,/^\/api\/billing\/collections\/dispatch(?:\?period=30d)?$/);
  const call={url,method:init.method??'GET',...init};calls.push(call);
  if(call.method==='GET')assert.equal(call.cache,'no-store');
  return handler(call,calls);
 };
 let renderer;await act(async()=>{renderer=TestRenderer.create(strict?React.createElement(React.StrictMode,null,React.createElement(BillingModule,{view:'regua'})):React.createElement(BillingModule,{view:'regua'}));});
 mounted.add(renderer);return{renderer,calls};
}
async function dispose(renderer){mounted.delete(renderer);await act(async()=>renderer.unmount());}
test.afterEach(async()=>{for(const renderer of mounted)await dispose(renderer);globalThis.fetch=originalFetch;});
test.after(()=>{if(originalActEnvironment===undefined)delete globalThis.IS_REACT_ACT_ENVIRONMENT;else globalThis.IS_REACT_ACT_ENVIRONMENT=originalActEnvironment;});

test('successful dispatch replaces preview with authoritative total without navigation; repeat does not double it',async()=>{
 let count=0,post=0;const {renderer,calls}=await mount(call=>call.method==='GET'?Response.json(preview(count)):Response.json((count=7,run(post++?{recorded:0,duplicates:1}:{}))));
 assert.equal(total(renderer),'0');await click(renderer,'Rodar disparo');assert.equal(total(renderer),'7');
 assert.match(content(renderer),/1 novo\(s\) registrado\(s\)/);
 await click(renderer,'Rodar disparo');assert.equal(total(renderer),'7');assert.match(content(renderer),/0 novo\(s\).*1 já tinha/);
 assert.deepEqual(calls.map(c=>c.method),['GET','POST','GET','POST','GET']);
});
test('same-tick duplicate clicks produce one POST and keep button busy through refresh',async()=>{
 const post=deferred(),refresh=deferred();let gets=0;
 const {renderer,calls}=await mount(call=>call.method==='POST'?post.promise:++gets===1?Response.json(preview()):refresh.promise);
 const onClick=button(renderer,'Rodar disparo').props.onClick;
 await act(async()=>{onClick();onClick()});
 assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(button(renderer,'Rodando').props.disabled,true);
 await act(async()=>post.resolve(Response.json(run())));assert.equal(button(renderer,'Rodando').props.disabled,true);
 await act(async()=>refresh.resolve(Response.json(preview(1))));assert.equal(total(renderer),'1');assert.equal(button(renderer,'Rodar disparo').props.disabled,false);
});
test('outside business hours still rereads ledger without claiming a new record',async()=>{
 const {renderer,calls}=await mount(call=>Response.json(call.method==='GET'?preview(3):run({businessHour:false,recorded:0})));
 await click(renderer,'Rodar disparo');assert.equal(total(renderer),'3');assert.match(content(renderer),/Fora do horário comercial/);assert.deepEqual(calls.map(c=>c.method),['GET','POST','GET']);
});
for(const failure of ['http','network','json'])test(`POST ${failure} failure releases busy state and clears prior result without automatic retry`,async()=>{
 let posts=0;const {renderer,calls}=await mount(call=>{
  if(call.method==='GET')return Response.json(preview(posts));
  if(++posts===1)return Response.json(run());
  if(failure==='http')return Response.json({error:'Revisão necessária'},{status:503});
  if(failure==='network')throw Error('synthetic transport failure');
  return new Response('not-json',{status:502});
 });
 await click(renderer,'Rodar disparo');await click(renderer,'Rodar disparo');
 assert.equal(button(renderer,'Rodar disparo').props.disabled,false);assert.equal(calls.filter(c=>c.method==='POST').length,2);
 assert.doesNotMatch(content(renderer),/Rodado:|novo\(s\) registrado\(s\)/);
 assert.match(content(renderer),failure==='http'?/Revisão necessária/:/Não foi possível confirmar o resultado/);
 const before=calls.length;await click(renderer,'Atualizar indicadores');assert.equal(calls.length,before+1);assert.equal(calls.at(-1).method,'GET');
});
for(const failure of ['http','network','json','unavailable'])test(`confirmed result survives refresh ${failure}; stale total is hidden`,async()=>{
 let gets=0;const {renderer,calls}=await mount(call=>{
  if(call.method==='POST')return Response.json(run());
  if(++gets===1)return Response.json(preview());
  if(gets>2)return Response.json(preview(1));
  if(failure==='http')return new Response('',{status:503});
  if(failure==='network')throw Error('synthetic refresh failure');
  if(failure==='json')return new Response('not-json');
  return Response.json({available:false,detail:'Fonte indisponível',period:'30d',today:null,indicators:null});
 });
 await click(renderer,'Rodar disparo');assert.match(content(renderer),/1 novo\(s\) registrado\(s\)/);assert.equal(total(renderer),null);
 assert.equal(button(renderer,'Rodar disparo'),undefined);
 if(failure==='unavailable')assert.match(content(renderer),/Fonte indisponível/);
 else assert.match(content(renderer),/Disparo confirmado, mas não foi possível atualizar/);
 await click(renderer,'Atualizar indicadores');assert.equal(total(renderer),'1');assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('initial failure offers read-only retry and no POST',async()=>{
 let gets=0;const{renderer,calls}=await mount(()=>++gets===1?new Response('',{status:503}):Response.json(preview(4)));
 assert.match(content(renderer),/Não foi possível consultar/);await click(renderer,'Atualizar indicadores');assert.equal(total(renderer),'4');assert.ok(calls.every(c=>c.method==='GET'));
});
for(const stage of ['initial','post','refresh'])for(const settle of ['resolve','reject'])test(`unmount aborts ${stage} and ignores late ${settle}`,async()=>{
 const pending=deferred();let gets=0;
 const{renderer,calls}=await mount(call=>{
  if(call.method==='GET'){gets++;if(stage==='initial'||(stage==='refresh'&&gets===2))return pending.promise;return Response.json(preview());}
  return stage==='post'?pending.promise:Response.json(run());
 });
 if(stage!=='initial')await click(renderer,'Rodar disparo');
 const pendingCall=calls.at(-1);assert.equal(pendingCall.signal.aborted,false);await dispose(renderer);assert.equal(pendingCall.signal.aborted,true);
 const before=calls.length;await act(async()=>{if(settle==='reject')pending.reject(Error('late synthetic rejection'));else pending.resolve(Response.json(stage==='post'?run():preview(88)));});
 assert.equal(calls.length,before);assert.equal(renderer.toJSON(),null);
});
test('StrictMode cleanup aborts the old initial read and newer preview wins',async()=>{
 const old=deferred();let gets=0;const{renderer,calls}=await mount(()=>++gets===1?old.promise:Response.json(preview(2)),{strict:true});
 assert.equal(calls[0].signal.aborted,true);assert.equal(total(renderer),'2');
 await act(async()=>old.resolve(Response.json(preview(99))));assert.equal(total(renderer),'2');
});
test('rule header has scoped wrapping, bounded input and wrap-safe metadata',()=>{
 const css=postcss.parse(readFileSync(new URL('../app/globals.css',import.meta.url),'utf8'));
 const rules=selector=>{const found=[];css.walkRules(selector,rule=>found.push(rule));return found;};
 const declarations=rule=>Object.fromEntries(rule.nodes.filter(n=>n.type==='decl').map(n=>[n.prop,n.value]));
 assert.equal(declarations(rules('.rule-toolbar .toolbar-main')[0]).flex,'1 1 280px');
 const name=declarations(rules('.rule-toolbar .rule-name')[0]);assert.equal(name['min-width'],'0');assert.equal(name['grid-template-columns'],'minmax(0, 1fr)');
 const input=declarations(rules('.rule-toolbar .rule-name input')[0]);assert.equal(input.width,'100%');assert.equal(input['min-width'],'0');
 assert.equal(declarations(rules('.rule-toolbar .rule-name span')[0])['overflow-wrap'],'anywhere');
 const mobile=rules('.rule-toolbar .toolbar-main').find(rule=>rule.parent.type==='atrule'&&rule.parent.params==='(max-width: 640px)');
 assert.equal(declarations(mobile)['flex-basis'],'100%');
 assert.match(readFileSync(new URL('../components/modules/billing.tsx',import.meta.url),'utf8'),/className="rule-toolbar"/);
});

for(const uncertain of [false,true])test(`unavailable ${uncertain?'after uncertain POST':'initially'} recovers through GET only`,async()=>{
 let gets=0;const{renderer,calls}=await mount(call=>{
  if(call.method==='POST')throw Error('synthetic uncertain result');
  gets++;
  if(gets===(uncertain?2:1))return Response.json({available:false,detail:'Fonte indisponível',period:'30d',today:null,indicators:null});
  return Response.json(preview(4));
 });
 if(uncertain){await click(renderer,'Rodar disparo');await click(renderer,'Atualizar indicadores');}
 assert.match(content(renderer),/Fonte indisponível/);assert.equal(total(renderer),null);
 await click(renderer,'Atualizar indicadores');assert.equal(total(renderer),'4');
 assert.equal(calls.filter(c=>c.method==='POST').length,uncertain?1:0);
 if(uncertain)assert.match(content(renderer),/Não foi possível confirmar o resultado/);
});
