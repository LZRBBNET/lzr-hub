// Offline component/interaction verification, not browser or visual QA.
// Run: node --experimental-strip-types --test tests/customer360-lifecycle.test.mjs
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Customer360Service } from '../lib/platform/customer360-service.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const built = buildSync({ stdin: { contents: `export {Customer360Module} from './components/modules/customer360';`, resolveDir: root, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react-dom/server'], logLevel: 'silent' });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { Customer360Module } = compiled.exports;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const observedAt = '2026-10-27T12:30:00Z';
const now = () => new Date('2026-10-27T13:00:00Z');
const coverage = (read, total = read, complete = true, limit = 20) => ({read,total,complete,limit});
const customer = (id) => ({id,name:`Cliente sintético ${id}`,document:`TEST-${id}`,phone:'Não informado',email:'Não informado',city:'Cidade de teste',neighborhood:'Centro',address:'Endereço de teste',status:'S'});
const summary = (id) => ({id,name:`Cliente sintético ${id}`,maskedDocument:`TEST-${id}`,city:'Cidade de teste',neighborhood:'Centro',plan:'Abrir para consultar',status:'S',priority:'—',tags:['IXC somente leitura']});
const list = () => ({items:['A','B'].map(summary),total:2,page:1,pageSize:10,mode:'staging-readonly',scope:'full-base'});
const snapshot = (id, overrides={}) => ({
  customer:customer(id), contracts:[{id:`CTR-${id}`,customerId:id,planName:'Plano sintético',status:'I'}], plan:null,
  invoices:[], payments:[], serviceOrders:[], connection:null, partialSources:[],
  coverage:{contracts:coverage(1),invoices:coverage(0),payments:coverage(0,0,true,100),serviceOrders:coverage(0)},
  metrics:{totalLatencyMs:15,blockLatencies:{}},fetchedAt:observedAt,mode:'staging-readonly',cache:'miss',...overrides,
});
const detail = async (id='A', overrides={}) => new Customer360Service(undefined,{getSnapshot:async()=>snapshot(id,overrides)},[id],false,now).get(id);
const flatten = (node) => node===null||node===undefined?'':Array.isArray(node)?node.map(flatten).join(' '):typeof node==='object'?flatten(node.children):String(node);
const content = (renderer) => flatten(renderer.toJSON()).replace(/\s+/g,' ');
const buttons = (renderer) => renderer.root.findAllByType('button');
const button = (renderer,label) => {
  const result=buttons(renderer).find(node=>node.props['aria-label']===label||flatten(node).includes(label));
  assert.ok(result,`Button not found: ${label}`);return result;
};
const click = async (renderer,label) => act(async()=>{button(renderer,label).props.onClick();});
const detailNames = (renderer) => renderer.root.findAllByType('h2').map(flatten).filter(value=>value.startsWith('Cliente sintético'));
const noDetail = (renderer) => {
  assert.deepEqual(detailNames(renderer),[]);
  assert.equal(renderer.root.findAllByType('aside').length,0);
  assert.equal(renderer.root.findAllByType('dialog').length,0);
};
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const mockNode = (element) => element.type==='dialog'?{open:false,showModal(){this.open=true;},close(){this.open=false;},querySelector(){return null;}}:null;
const mounted = new Set();
const mount = async (fetcher,{wide=true}={}) => {
  globalThis.window={matchMedia:()=>({matches:wide,addEventListener(){},removeEventListener(){}})};
  globalThis.fetch=fetcher;let renderer;
  await act(async()=>{renderer=TestRenderer.create(React.createElement(Customer360Module),{createNodeMock:mockNode});});
  mounted.add(renderer);
  return renderer;
};
const dispose = async (renderer) => { mounted.delete(renderer); await act(async()=>renderer.unmount()); };
test.afterEach(async()=>{ for(const renderer of mounted) await dispose(renderer); });
const route = (getDetail) => async (url,init) => url.includes('?id=')?Response.json(await getDetail(new URL(url,'http://local').searchParams.get('id'),init)):Response.json(list());

test('registration remains active while a single known contract is ended',async()=>{
  const renderer=await mount(route(id=>detail(id)));
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Cadastro: Ativo/);
  assert.match(content(renderer),/Contrato único na leitura/);
  assert.match(content(renderer),/Situação do contrato Encerrado/);
  assert.doesNotMatch(content(renderer),/Inteligência \(demonstração\)|Saúde|Upgrade|Risco/);
  await dispose(renderer);
});

test('multiple contracts are listed without choosing the first as current',async()=>{
  const contracts=[{id:'OLD',customerId:'A',planName:'Plano antigo',status:'I'},{id:'NEW',customerId:'A',planName:'Plano novo',status:'A'}];
  const payload=await detail('A',{contracts,coverage:{...snapshot('A').coverage,contracts:coverage(2)}});
  const renderer=await mount(route(async()=>payload));
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Cadastro: Ativo/);
  assert.match(content(renderer),/Nenhum contrato escolhido automaticamente como atual/);
  assert.match(content(renderer),/Contrato OLD · Encerrado · Plano antigo/);
  assert.match(content(renderer),/Contrato NEW · Ativo · Plano novo/);
  assert.doesNotMatch(content(renderer),/Contrato único na leitura/);
  await dispose(renderer);
});

test('UI → actual Customer360Service → synthetic provider displays only due open balance and declares bounded data',async()=>{
  const invoices=[
    {id:'overdue',customerId:'A',status:'A',dueAt:'2026-10-26',value:40,valueSource:'open-balance'},
    {id:'today',customerId:'A',status:'A',dueAt:'2026-10-27',value:70,valueSource:'open-balance'},
    {id:'future',customerId:'A',status:'A',dueAt:'2026-11-01',value:90,valueSource:'open-balance'},
    {id:'nominal',customerId:'A',status:'A',dueAt:'2026-10-01',value:100,valueSource:'face-value'},
  ];
  const data=snapshot('A',{invoices,cache:'hit',payments:[{id:'p1',customerId:'A',invoiceId:'overdue',paidAt:'2026-10-25',method:'PIX'}],coverage:{...snapshot('A').coverage,invoices:coverage(4,24,false),payments:coverage(1,null,false,100)}});
  const calls=[];
  const service=new Customer360Service(undefined,{getSnapshot:async(...args)=>{calls.push(args);return data;}},['A'],false,now);
  const renderer=await mount(route(id=>service.get(id)));
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Subtotal vencido conhecido \(parcial\) R\$ 40,00/);
  assert.doesNotMatch(content(renderer),/R\$ 300,00|R\$ 140,00/);
  assert.match(content(renderer),/Faturas: 4 lidos de 24; recorte parcial ou não confirmado/);
  assert.match(content(renderer),/Não é o saldo total confirmado do cliente/);
  assert.match(content(renderer),/Data de pagamento mais recente no recorte 2026-10-25/);
  assert.match(content(renderer),/não afirma qual foi o último pagamento do cliente/);
  assert.match(content(renderer),/1 valor\(es\) nominal\(is\).*excluído\(s\) do subtotal/);
  assert.match(content(renderer),/Leitura em 27\/10\/2026,? 09:30:00 \(Brasília\)/);
  assert.match(content(renderer),/Dados em cache; a hora é da consulta original/);
  assert.match(content(renderer),/Registros consultados \(não totais históricos\)/);
  assert.equal(calls.length,1);
  assert.equal(calls[0][2],false);
  await dispose(renderer);
});

test('missing finance is not rendered as zero debt',async()=>{
  const payload=await detail('A',{partialSources:['invoices'],coverage:{...snapshot('A').coverage,invoices:coverage(0,null,false)}});
  const renderer=await mount(route(async()=>payload));
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Subtotal vencido conhecido \(parcial\) Não confirmado/);
  assert.match(content(renderer),/Fonte financeira indisponível. Nenhum saldo foi confirmado/);
  assert.doesNotMatch(content(renderer),/R\$ 0,00/);
  await dispose(renderer);
});

test('only complete confirmed data can display zero overdue balance; unknown coverage stays unconfirmed',async()=>{
  const future=[{id:'not-due',customerId:'A',status:'A',dueAt:'2026-10-28',value:80,valueSource:'open-balance'}];
  const confirmed=await detail('A',{invoices:future,coverage:{...snapshot('A').coverage,invoices:coverage(1)}});
  const unknown=await detail('B',{coverage:undefined});
  const renderer=await mount(route(async id=>id==='A'?confirmed:unknown));
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Saldo vencido na leitura R\$ 0,00/);
  assert.match(content(renderer),/Faturas: 1 lidos de 1; leitura completa/);
  await click(renderer,'Cliente sintético B');
  assert.match(content(renderer),/Subtotal vencido conhecido \(parcial\) Não confirmado/);
  assert.match(content(renderer),/Faturas: 0 lidos; total não confirmado/);
  assert.doesNotMatch(content(renderer),/R\$ 0,00/);
  await dispose(renderer);
});

test('payment UI shows a validated business date, not malformed time or a global last-payment claim',async()=>{
  const invoices=[{id:'paid',customerId:'A',status:'R',dueAt:'2026-10-01',value:0,valueSource:'open-balance'}];
  const payments=[
    {id:'bad',customerId:'A',invoiceId:'paid',paidAt:'2026-10-27garbage',method:'PIX'},
    {id:'good',customerId:'A',invoiceId:'paid',paidAt:'2026-10-27T01:00:00Z',method:'PIX'},
  ];
  const payload=await detail('A',{invoices,payments,coverage:{...snapshot('A').coverage,invoices:coverage(1),payments:coverage(2,2,true,100)}});
  const renderer=await mount(route(async()=>payload));
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Data de pagamento mais recente no recorte 2026-10-26/);
  assert.doesNotMatch(content(renderer),/garbage|01:00:00Z|Último pagamento/);
  assert.match(content(renderer),/Pagamentos: 1 lidos de 2; recorte parcial ou não confirmado/);
  await dispose(renderer);
});

for(const wide of [true,false])test(`slow detail can close and cannot reopen from a late response (${wide?'desktop':'mobile'})`,async()=>{
  const pending=deferred();
  const renderer=await mount(async url=>url.includes('?id=')?pending.promise:Response.json(list()),{wide});
  await click(renderer,'Cliente sintético A');
  assert.equal(renderer.root.findAllByType(wide?'aside':'dialog').length,1);
  await click(renderer,'Fechar');
  noDetail(renderer);
  await act(async()=>{pending.resolve(Response.json(await detail('A')));});
  noDetail(renderer);
  await dispose(renderer);
});

test('mobile Escape and outside dismissal invalidate pending detail requests',async()=>{
  const first=deferred(),second=deferred();let requests=0;
  const renderer=await mount(async url=>url.includes('?id=')?(++requests===1?first.promise:second.promise):Response.json(list()),{wide:false});
  await click(renderer,'Cliente sintético A');
  let prevented=false;
  await act(async()=>renderer.root.findByType('dialog').props.onCancel({preventDefault(){prevented=true;}}));
  assert.equal(prevented,true);noDetail(renderer);
  await click(renderer,'Cliente sintético B');
  const backdrop={};
  await act(async()=>renderer.root.findByType('dialog').props.onMouseDown({target:backdrop,currentTarget:backdrop}));
  noDetail(renderer);
  await act(async()=>{first.resolve(Response.json(await detail('A')));second.resolve(Response.json(await detail('B')));});
  noDetail(renderer);
  await dispose(renderer);
});

test('newer customer response wins when older customer resolves last',async()=>{
  const a=deferred(), b=deferred();
  const renderer=await mount(async url=>url.endsWith('id=A')?a.promise:url.endsWith('id=B')?b.promise:Response.json(list()));
  await click(renderer,'Cliente sintético A');
  await click(renderer,'Cliente sintético B');
  await act(async()=>{b.resolve(Response.json(await detail('B')));});
  assert.deepEqual(detailNames(renderer),['Cliente sintético B']);
  await act(async()=>{a.resolve(Response.json(await detail('A')));});
  assert.deepEqual(detailNames(renderer),['Cliente sintético B']);
  await dispose(renderer);
});

test('repeated opens of one customer keep latest request and ignore stale errors',async()=>{
  const first=deferred();let count=0;
  const renderer=await mount(async url=>{
    if(!url.includes('?id='))return Response.json(list());
    count++;return count===1?first.promise:Response.json(await detail('A'));
  });
  await click(renderer,'Cliente sintético A');
  await click(renderer,'Cliente sintético A');
  assert.deepEqual(detailNames(renderer),['Cliente sintético A']);
  await act(async()=>{first.reject(new Error('older request failed'));});
  assert.deepEqual(detailNames(renderer),['Cliente sintético A']);
  assert.doesNotMatch(content(renderer),/Não foi possível abrir/);
  await dispose(renderer);
});

test('closing an active refresh keeps detail closed after refresh resolves',async()=>{
  const pending=deferred();const requests=[];
  const renderer=await mount(async(url,init)=>{
    requests.push({url,method:init?.method??'GET',body:init?.body});
    if(init?.method==='POST')return pending.promise;
    return Response.json(url.includes('?id=')?await detail('A'):list());
  });
  await click(renderer,'Cliente sintético A');
  await click(renderer,'Ler de novo');
  assert.equal(button(renderer,'Atualizando…').props.disabled,true);
  await click(renderer,'Fechar');
  noDetail(renderer);
  await act(async()=>{pending.resolve(Response.json(await detail('A')));});
  noDetail(renderer);
  assert.deepEqual(JSON.parse(requests.at(-1).body),{action:'refresh',id:'A'});
  await dispose(renderer);
});

test('refresh of previous customer cannot replace the newer selected customer',async()=>{
  const pending=deferred();
  const renderer=await mount(async(url,init)=>{
    if(init?.method==='POST')return pending.promise;
    return Response.json(url.includes('?id=')?await detail(new URL(url,'http://local').searchParams.get('id')):list());
  });
  await click(renderer,'Cliente sintético A');
  await click(renderer,'Ler de novo');
  await click(renderer,'Cliente sintético B');
  assert.deepEqual(detailNames(renderer),['Cliente sintético B']);
  await act(async()=>{pending.resolve(Response.json(await detail('A')));});
  assert.deepEqual(detailNames(renderer),['Cliente sintético B']);
  assert.equal(button(renderer,'Ler de novo').props.disabled,false);
  await dispose(renderer);
});

test('network refresh failure exits busy state and supports Close then reopen',async()=>{
  const renderer=await mount(async(url,init)=>{
    if(init?.method==='POST')throw new Error('synthetic offline');
    return Response.json(url.includes('?id=')?await detail('A'):list());
  });
  await click(renderer,'Cliente sintético A');
  await click(renderer,'Ler de novo');
  assert.match(content(renderer),/Não foi possível abrir este cadastro/);
  assert.doesNotMatch(content(renderer),/Atualizando/);
  assert.deepEqual(detailNames(renderer),[]);
  await click(renderer,'Fechar');
  noDetail(renderer);
  await click(renderer,'Cliente sintético A');
  assert.deepEqual(detailNames(renderer),['Cliente sintético A']);
  assert.equal(button(renderer,'Ler de novo').props.disabled,false);
  await dispose(renderer);
});

test('mismatched API detail is rejected and network open error can be dismissed',async()=>{
  let attempts=0;
  const renderer=await mount(async url=>{
    if(!url.includes('?id='))return Response.json(list());
    attempts++;
    if(attempts===1)return Response.json(await detail('B'));
    throw new Error('synthetic failed open');
  });
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Não foi possível abrir este cadastro/);
  assert.deepEqual(detailNames(renderer),[]);
  await click(renderer,'Fechar');
  await click(renderer,'Cliente sintético A');
  assert.match(content(renderer),/Não foi possível abrir este cadastro/);
  await click(renderer,'Fechar');
  noDetail(renderer);
  await dispose(renderer);
});

test('unmounted module ignores a late detail response',async()=>{
  const pending=deferred();
  const renderer=await mount(async url=>url.includes('?id=')?pending.promise:Response.json(list()));
  await click(renderer,'Cliente sintético A');
  await dispose(renderer);
  await act(async()=>{pending.resolve(Response.json(await detail('A')));});
  assert.equal(renderer.toJSON(),null);
});

test.after(()=>{globalThis.fetch=originalFetch;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;});

test('one selected customer displays contract, connection, invoices and bounded payment/OS history together',async()=>{
  const data=snapshot('A',{
    contracts:[{id:'CTR-A',customerId:'A',status:'A',planName:'Plano sintético 500',monthlyValue:89.9,dueDay:10}],
    invoices:[{id:'INV-A',customerId:'A',contractId:'CTR-A',status:'A',dueAt:'2026-10-20',value:39.9,valueSource:'open-balance'}],
    payments:[{id:'PAY-A',customerId:'A',invoiceId:'INV-A',paidAt:'2026-10-22',value:50,method:'PIX'}],
    serviceOrders:[{id:'OS-A',customerId:'A',status:'F',subject:'Ajuste sintético',openedAt:'2026-10-21 09:00:00'}],
    connection:{id:'CON-A',customerId:'A',login:'fixture-a',status:'S',equipmentDescriptor:'OLT-SYNTHETIC',connectionType:'Fibra',lastAccessAt:'2026-10-27 08:00:00'},
    coverage:{contracts:coverage(1),invoices:coverage(1),payments:coverage(1,1,true,100),serviceOrders:coverage(1)},
  });
  const calls=[];
  const provider={getSnapshot:async(...args)=>{calls.push(args);return data;}};
  const service=new Customer360Service(undefined,provider,['A'],false,now);
  const renderer=await mount(route(id=>service.get(id)));
  await click(renderer,'Cliente sintético A');
  const text=content(renderer);
  assert.match(text,/Contrato único na leitura Código CTR-A/);
  assert.match(text,/Plano Plano sintético 500/);
  assert.match(text,/Fatura INV-A · Contrato CTR-A/);
  assert.match(text,/Saldo em aberto: R\$ 39,90/);
  assert.match(text,/Pagamento PAY-A · Fatura INV-A/);
  assert.match(text,/OS OS-A · Ajuste sintético/);
  assert.match(text,/Conexão Status Online PPPoE \(login\) fixture-a Equipamento\/OLT OLT-SYNTHETIC/);
  assert.match(text,/Registros consultados \(não totais históricos\) Contratos 1 Faturas 1 Pagamentos 1 Ordens de serviço 1/);
  assert.equal(calls.length,1);
  assert.equal(calls[0][2],false);
  await dispose(renderer);
});

test('closing then selecting another customer ignores both a stale detail and its malformed JSON',async()=>{
  const stale=deferred();
  const renderer=await mount(async url=>url.endsWith('id=A')?stale.promise:Response.json(url.endsWith('id=B')?await detail('B'):list()));
  await click(renderer,'Cliente sintético A');
  await click(renderer,'Fechar');
  await click(renderer,'Cliente sintético B');
  await act(async()=>stale.resolve(new Response('not json',{status:200})));
  assert.deepEqual(detailNames(renderer),['Cliente sintético B']);
  assert.doesNotMatch(content(renderer),/Não foi possível abrir/);
  await dispose(renderer);
});

for(const response of ['http-error','invalid-json','wrong-customer'])test(`refresh ${response} is recoverable without showing another customer`,async()=>{
  const renderer=await mount(async(url,init)=>{
    if(init?.method==='POST')return response==='http-error'?new Response(null,{status:503}):response==='invalid-json'?new Response('bad'):Response.json(await detail('B'));
    return Response.json(url.includes('?id=')?await detail('A'):list());
  });
  await click(renderer,'Cliente sintético A');
  await click(renderer,'Ler de novo');
  assert.match(content(renderer),/Não foi possível abrir este cadastro/);
  assert.doesNotMatch(content(renderer),/Atualizando/);
  assert.deepEqual(detailNames(renderer),[]);
  await click(renderer,'Fechar');
  await click(renderer,'Cliente sintético A');
  assert.deepEqual(detailNames(renderer),['Cliente sintético A']);
  await dispose(renderer);
});
