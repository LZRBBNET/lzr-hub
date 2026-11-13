import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Customer360Service} from '../lib/platform/customer360-service.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=buildSync({stdin:{contents:`export {CustomerDetail} from './components/modules/customer360';`,resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','react-dom/server'],logLevel:'silent'});
const compiled={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);
const render=data=>renderToStaticMarkup(React.createElement(compiled.exports.CustomerDetail,{data,loading:false,error:false,refreshing:false,onClose:()=>{throw Error('NO_MUTATION');}}));
async function fixture({invoices=[],payments=[],partialSources=[],cache="miss"}={}){
 const id='910001',rows={contracts:[{id:'920001',customerId:id,status:'I',planName:'Plano sintético'}],invoices,payments,serviceOrders:[]};
 const snapshot={customer:{id,name:'Cliente sintético',document:'SYNTHETIC',phone:'—',email:'—',address:'—',city:'—',neighborhood:'—',status:'S'},...rows,plan:null,connection:null,partialSources,metrics:{totalLatencyMs:0,blockLatencies:{}},fetchedAt:'2026-11-03T12:00:00Z',mode:'staging-readonly',cache,coverage:Object.fromEntries(Object.keys(rows).map(k=>[k,{read:rows[k].length,total:rows[k].length,complete:true,limit:k==='payments'?100:20}]))};
 return new Customer360Service(undefined,{getSnapshot:async()=>snapshot},[id],false,()=>new Date('2026-11-03T12:00:00Z')).get(id);
}
const sources=html=>html.slice(html.indexOf('<h3>Fontes')).replace(/<[^>]*>/g,'');
test('source badges distinguish successful query from complete record coverage',async()=>{const d=await fixture(),s=sources(render(d));assert.match(s,/IXC cliente · consulta ok/);assert.match(s,/IXC contratos · leitura completa/);assert.doesNotMatch(s,/IXC contratos · ok/);});
test('20 of 45 contracts does not show green source success as completeness',async()=>{const d=await fixture();d.reading.coverage.contracts={read:20,total:45,limit:20,complete:false};d.partial=true;const h=render(d);assert.match(sources(h),/IXC contratos · parcial/);assert.match(h,/20 lidos.*45/);assert.match(h,/chip warn[^>]*[^]*IXC contratos/);});
test('unknown total and legacy missing reading are visibly unconfirmed',async()=>{for(const legacy of [false,true]){const d=await fixture();if(legacy)delete d.reading;else d.reading.coverage.payments={read:20,total:null,limit:100,complete:false};d.partial=false;const h=render(d);assert.match(h,/Leitura parcial ou com dados não confirmados/);assert.match(sources(h),/IXC pagamentos · cobertura não confirmada/);}});
test('cache does not override partial coverage',async()=>{const d=await fixture();d.sources.forEach(s=>s.cache='hit');d.reading.coverage.invoices={read:20,total:25,limit:20,complete:false};assert.match(sources(render(d)),/IXC financeiro · parcial · cache/);});
test('failed source stays unavailable even if metadata says complete',async()=>{const d=await fixture();d.sources.find(s=>s.provider==='IXC pagamentos').state='error';assert.match(sources(render(d)),/IXC pagamentos · indisponível/);});
test('contradictory complete metadata is not rendered as complete',async()=>{const d=await fixture();d.reading.coverage.invoices={read:20,total:45,limit:20,complete:true};const h=render(d);assert.match(sources(h),/IXC financeiro · cobertura não confirmada/);assert.doesNotMatch(h,/Faturas: 20 lidos de 45; leitura completa/);});
test('registration and single ended contract remain separate, payment explicitly bounded',async()=>{const h=render(await fixture());assert.match(h,/Cadastro: Ativo/);assert.match(h,/Situação do contrato[^]*Encerrado/);assert.match(h,/Data de pagamento mais recente no recorte/);assert.match(h,/não afirma qual foi o último pagamento do cliente/);assert.match(h,/Registros consultados \(não totais históricos\)/);});

const ownInvoice=(over={})=>({id:'940001',customerId:'910001',status:'R',dueAt:'2026-11-01',value:40,valueSource:'open-balance',...over});
const ownPayment={id:'930001',customerId:'910001',invoiceId:'940001',paidAt:'2026-11-02',value:2,method:'Sintético'};
test('unavailable payments preserve invoice and do not imply zero or a missing payment date',async()=>{
 const d=await fixture({invoices:[ownInvoice()],partialSources:['payments']});const h=render(d);
 assert.match(h,/Fatura 940001/);assert.match(h,/Status na fonte: R/);assert.match(h,/Saldo em aberto: R\$ 40,00/);
 assert.match(h,/Histórico de pagamentos indisponível nesta leitura/);assert.match(h,/Esta leitura não permite concluir se há pagamentos/);
 assert.match(h,/Não confirmada nesta leitura/);assert.doesNotMatch(h,/Nenhum pagamento neste recorte|Não encontrado nos registros consultados|recorte validado/);
});
test('validated empty payments differ from an incomplete empty observation',async()=>{
 const d=await fixture();assert.match(render(d),/Nenhum registro de pagamento no recorte validado/);
 d.reading.coverage.payments={read:0,total:7,limit:100,complete:false};const h=render(d);
 assert.match(h,/Histórico de pagamentos parcial ou não confirmado/);assert.doesNotMatch(h,/Histórico de pagamentos indisponível|recorte validado/);
});
test('missing source or metadata never confirms an empty history',async()=>{
 for(const missing of ['source','coverage','rows','contradictory']){
  const d=await fixture();if(missing==='source')d.sources=d.sources.filter(s=>s.provider!=='IXC pagamentos');
  if(missing==='contradictory')d.reading.coverage.payments={read:1,total:1,limit:100,complete:true};
  if(missing==='coverage')delete d.reading.coverage.payments;if(missing==='rows')delete d.reading.payments;
  const h=render(d);assert.match(h,/Histórico de pagamentos parcial ou não confirmado/);assert.doesNotMatch(h,/recorte validado|Não encontrado nos registros consultados/);
 }
});
test('partial and unavailable history retain already validated payment rows',async()=>{
 const d=await fixture({invoices:[ownInvoice()],payments:[ownPayment]});d.reading.coverage.payments={read:1,total:2,limit:100,complete:false};
 let h=render(d);assert.match(h,/Pagamento 930001/);assert.match(h,/Histórico de pagamentos parcial ou não confirmado/);assert.doesNotMatch(h,/Histórico de pagamentos indisponível/);
 d.sources.find(s=>s.provider==='IXC pagamentos').state='error';h=render(d);
 assert.match(h,/Parte do histórico de pagamentos está indisponível/);assert.match(h,/Pagamento 930001/);assert.match(h,/Fatura 940001/);
});
test('invoice nominal value stays unknown balance while source time and cache remain original',async()=>{
 const d=await fixture({invoices:[ownInvoice({value:80,valueSource:'face-value'})],partialSources:['payments'],cache:'hit'});const h=render(d);
 assert.match(h,/Saldo em aberto: Não confirmado/);assert.match(h,/Origem do valor: face-value/);assert.doesNotMatch(h,/Saldo em aberto: R\$ 80,00/);
 assert.match(h,/Dados em cache; a hora é da consulta original/);assert.match(h,/03\/11\/2026/);
 assert.equal(d.reading.observedAt,'2026-11-03T12:00:00Z');assert.ok(d.sources.every(s=>s.cache==='hit'&&s.updatedAt===d.reading.observedAt));
});
