import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Customer360Service } from '../lib/platform/customer360-service.ts';
import { createSyntheticInvoiceDemo, assertSyntheticDemo } from '../lib/integrations/ixc/synthetic-demo.ts';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=buildSync({stdin:{contents:`export {CustomerDetail} from './components/modules/customer360';`,resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','react-dom/server'],logLevel:'silent'});
const ui={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),ui,ui.exports);
const render=data=>renderToStaticMarkup(React.createElement(ui.exports.CustomerDetail,{data,loading:false,error:false,refreshing:false,onClose:()=>{throw Error('NO_MUTATION');}})).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
function fixture(t){
  const config={...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1'};
  const saved=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));Object.assign(process.env,config);
  t.after(()=>{for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const demo=createSyntheticInvoiceDemo(()=>process.env),factory={exports:{}};
  const modules={'../integrations/ixc/synthetic-demo.ts':{assertSyntheticDemo},'../integrations/ixc/runtime.ts':{getIxcRuntime:()=>({provider:demo.provider})},'./customer360-service':{Customer360Service}};
  const code=transformSync(readFileSync(new URL('../lib/platform/customer360-factory.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];},factory,factory.exports);
  return{demo,service:factory.exports.getCustomer360Service()};
}
test('factory → UI sintética mostra fatura aberta e pagamento posterior sem afirmar IXC real',async t=>{
  const {demo,service}=fixture(t);const before=await service.get('10');const open=render(before);
  assert.equal(before.mode,'demo');assert.match(open,/Demonstração/);assert.match(open,/Fatura 901 · Contrato 501/);
  assert.match(open,/Saldo em aberto: R\$ 50,00/);assert.match(open,/Nenhum pagamento neste recorte/);
  assert.doesNotMatch(open,/Consulta ao IXC|Origem IXC|Inteligência \(demonstração\)/);
  demo.markPaid();const after=render(await service.refresh('10'));
  assert.match(after,/Fatura 901 · Contrato 501/);assert.match(after,/Status na fonte: R/);
  assert.match(after,/Saldo em aberto: R\$ 0,00/);assert.match(after,/Pagamento 801 · Fatura 901/);assert.match(after,/SIMULADO/);
  assert.match(after,/Registros consultados \(não totais históricos\)/);
});
test('leitura sintética parcial conserva avisos e rótulo de fonte sem badge completo indevido',async t=>{
  const {service}=fixture(t);const data=await service.get('10');
  data.reading.coverage.invoices={read:1,total:4,limit:20,complete:false};data.reading.financeComplete=false;data.partial=true;
  const text=render(data);assert.match(text,/Subtotal vencido conhecido \(parcial\)/);assert.match(text,/1 lidos de 4/);
  assert.match(text,/Valor ausente ou parcial não significa ausência de dívida/);
  assert.match(text,/Fonte sintética · parcial/);
});
test('alterar contexto de ambiente invalida a fábrica sintética já obtida',async t=>{
  const {service}=fixture(t);process.env.LZR_ENV='production';await assert.rejects(service.get('10'),/CONFIGURATION_BLOCKED/);
});
test('contratos ambíguos na leitura sintética não viram contrato atual inventado',async t=>{
  const {service}=fixture(t);const data=await service.get('10');
  data.reading.contractSelection='ambiguous';data.reading.contracts.push({id:'502',status:'I',plan:'Outro plano fictício'});
  const text=render(data);assert.match(text,/Nenhum contrato escolhido automaticamente como atual/);
  assert.match(text,/Contrato 501/);assert.match(text,/Contrato 502/);assert.doesNotMatch(text,/Contrato único na leitura/);
});
