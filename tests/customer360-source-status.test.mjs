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
async function fixture(){
 const id='910001',rows={contracts:[{id:'920001',customerId:id,status:'I',planName:'Plano sintético'}],invoices:[],payments:[],serviceOrders:[]};
 const snapshot={customer:{id,name:'Cliente sintético',document:'SYNTHETIC',phone:'—',email:'—',address:'—',city:'—',neighborhood:'—',status:'S'},...rows,plan:null,connection:null,partialSources:[],metrics:{totalLatencyMs:0,blockLatencies:{}},fetchedAt:'2026-11-03T12:00:00Z',mode:'staging-readonly',cache:'miss',coverage:Object.fromEntries(Object.keys(rows).map(k=>[k,{read:rows[k].length,total:rows[k].length,complete:true,limit:k==='payments'?100:20}]))};
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
