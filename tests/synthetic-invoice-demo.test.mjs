import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSyntheticDemo, createSyntheticInvoiceDemo } from '../lib/integrations/ixc/synthetic-demo.ts';
import { loadFreshDispatchInvoices } from '../lib/platform/collection-dispatch-source.ts';
import { MemoryPaymentPromiseRepository, reconcilePaymentPromises } from '../lib/platform/payment-promise-service.ts';
import { businessToday } from '../lib/platform/billing-service.ts';

const flags = ['FEATURE_IXC_WRITE','IXC_WRITE_ENABLED','FEATURE_QUEUES','FEATURE_META_WHATSAPP','FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_EVOLUTION','FEATURE_CHATWOOT','FEATURE_LANGFUSE','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'];
const fixture = () => ({ ...Object.fromEntries(flags.map(key=>[key,'false'])), FEATURE_SYNTHETIC_INVOICES:'true', DEMO_DATASET:'isolated-invoices-v1', LZR_ENV:'staging', NEXT_PUBLIC_LZR_ENV:'staging', LZR_RUNTIME_MODE:'mock', FEATURE_AUTH:'true', PILOT_MODE:'disabled', IXC_MODE:'disabled', IXC_TRANSPORT:'disabled', FEATURE_IXC_FULL_BASE:'false' });
for(const key of [...flags,'FEATURE_SYNTHETIC_INVOICES','DEMO_DATASET','LZR_ENV','NEXT_PUBLIC_LZR_ENV','LZR_RUNTIME_MODE','FEATURE_AUTH','PILOT_MODE','IXC_MODE','IXC_TRANSPORT','FEATURE_IXC_FULL_BASE'])test(`demo recusa configuração ausente ou inválida: ${key}`,()=>{
  for(const value of [undefined,'unexpected'])assert.throws(()=>assertSyntheticDemo({...fixture(),[key]:value}),/CONFIGURATION_BLOCKED/);
});
for(const key of ['IXC_API_TOKEN','META_ACCESS_TOKEN','GROQ_API_KEY','QUEUE_SERVICE_SECRET'])test(`demo recusa credencial ${key}`,()=>assert.throws(()=>assertSyntheticDemo({...fixture(),[key]:'synthetic-secret'})));
test('produção nunca habilita fonte sintética',()=>assert.throws(()=>createSyntheticInvoiceDemo(()=>({...fixture(),LZR_ENV:'production'}))));
test('fatura aberta → promessa → pagamento → fora da régua, sem rede',async()=>{
  const source=fixture();const demo=createSyntheticInvoiceDemo(()=>source);
  const invoice=await demo.provider.getInvoiceForCustomer('10','901','synthetic');
  assert.equal(invoice.status,'A');assert.equal(invoice.customerId,'10');
  assert.equal((await loadFreshDispatchInvoices(demo.provider,['10'])).length,1);
  const repository=new MemoryPaymentPromiseRepository();
  await repository.create({invoiceId:'901',customerId:'10',promisedFor:businessToday(new Date()),registeredBy:'operator@example.invalid',correlationId:'synthetic'});
  const snapshot=await demo.provider.getSnapshot('10','synthetic');assert.equal(snapshot.invoices[0].status,'A');
  assert.equal(demo.markPaid().delivered,false);demo.markPaid();
  assert.equal((await demo.provider.getInvoiceForCustomer('10','901','synthetic')).status,'R');
  assert.deepEqual(await loadFreshDispatchInvoices(demo.provider,['10']),[]);
  await reconcilePaymentPromises(repository,demo.provider,'synthetic',new Date());
  assert.equal(repository.rows[0].status,'fulfilled');
  assert.equal((await demo.provider.getSnapshot('10','synthetic')).invoices[0].status,'R');
  await assert.rejects(demo.provider.getInvoiceForCustomer('11','901','synthetic'));
  assert.equal(await demo.provider.getInvoiceForCustomer('10','902','synthetic'),undefined);
  source.LZR_ENV='production';
  assert.throws(()=>demo.provider.getSnapshot('10','synthetic'));
  assert.throws(()=>demo.markPaid());
});

test('endpoint de pagamento é inerte fora da demo, respeita negação e não aceita fatura arbitrária', async()=>{
  const {readFileSync}=await import('node:fs');const {transformSync}=await import('esbuild');const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
  const state={enabled:false,allowed:false};const demo=createSyntheticInvoiceDemo(fixture);let authCalls=0;
  const modules={
    'next/server':require('next/server'),
    '@/lib/integrations/ixc/synthetic-demo':{getSyntheticInvoiceDemo(){if(!state.enabled)throw Error('blocked');return demo;}},
    '@/lib/platform/session-guard':{async authorize(_request,permission){authCalls++;assert.equal(permission,'billing.write-demo');return state.allowed?{allowed:true,user:{id:'synthetic'}}:{allowed:false,status:403,error:'Acesso negado'};}},
  };
  const compiled={exports:{}};const code=transformSync(readFileSync(new URL('../app/api/demo/invoices/route.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];},compiled,compiled.exports);
  const post=body=>compiled.exports.POST(new Request('https://synthetic.invalid/api/demo/invoices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  const valid={action:'simulate_payment',invoiceId:'901'};
  assert.equal((await post(valid)).status,404);assert.equal(authCalls,0);
  state.enabled=true;assert.equal((await post(valid)).status,403);
  assert.equal((await demo.provider.getInvoiceForCustomer('10','901','synthetic')).status,'A');
  state.allowed=true;
  assert.equal((await post({...valid,invoiceId:'902'})).status,400);
  assert.equal((await post({action:'reset',invoiceId:'901'})).status,400);
  assert.equal((await post(valid)).status,200);
  assert.equal((await demo.provider.getInvoiceForCustomer('10','901','synthetic')).status,'R');
  assert.equal((await post({action:'reset_fixture',invoiceId:'901'})).status,400);
  const reset=await post({action:'reset_fixture',invoiceId:'901',confirmation:'RESET_SYNTHETIC_INVOICE_901'});
  assert.equal(reset.status,200);assert.equal((await reset.json()).databaseReset,false);
  assert.equal((await demo.provider.getInvoiceForCustomer('10','901','synthetic')).status,'A');
});

test('factory Cliente 360 usa a mesma fatura e rotula dados fictícios',async t=>{
  const env=fixture();const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const {readFileSync}=await import('node:fs');const {transformSync}=await import('esbuild');
  const {Customer360Service}=await import('../lib/platform/customer360-service.ts');
  const demo=createSyntheticInvoiceDemo(()=>process.env);const result={exports:{}};
  const modules={'../integrations/ixc/synthetic-demo.ts':{assertSyntheticDemo},'../integrations/ixc/runtime.ts':{getIxcRuntime:()=>({provider:demo.provider})},'./customer360-service':{Customer360Service}};
  const code=transformSync(readFileSync(new URL('../lib/platform/customer360-factory.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];},result,result.exports);
  const service=result.exports.getCustomer360Service();
  assert.equal((await service.list()).mode,'demo');
  const before=await service.get('10');assert.equal(before.mode,'demo');assert.equal(before.finance.openInvoices,1);
  assert.ok(before.sources.every(s=>s.provider==='Fonte sintética'&&s.mode==='demo'));
  demo.markPaid();assert.equal((await service.get('10')).finance.openInvoices,0);
  process.env.LZR_ENV='production';await assert.rejects(service.get('10'));
});

test('runtime real seleciona sintético sem construir transporte externo',async t=>{
  const env=fixture();const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const {readFileSync}=await import('node:fs');const {transformSync}=await import('esbuild');
  const synthetic=await import('../lib/integrations/ixc/synthetic-demo.ts');const {loadRuntimeConfig}=await import('../lib/runtime/environment.ts');
  let transports=0;const result={exports:{}};
  const modules={'./synthetic-demo.ts':synthetic,'../../runtime/environment.ts':{loadRuntimeConfig},'../../observability/telemetry.ts':{recordTelemetry(){throw Error('Unexpected telemetry');}},'./http.ts':{createIxcFetcher(){transports++;throw Error('Unexpected transport');},resolveIxcHttpMethod(){throw Error('Unexpected HTTP config');}},'./readonly-provider.ts':{IxcReadonlyProvider:class{constructor(){throw Error('Unexpected real provider');}}}};
  const code=transformSync(readFileSync(new URL('../lib/integrations/ixc/runtime.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  new Function('require','module','exports',code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];},result,result.exports);
  const runtime=result.exports.getIxcRuntime();assert.deepEqual(runtime.config.ixcAllowlist,['10']);assert.equal(runtime.config.ixcFullBase,false);
  assert.equal((await runtime.provider.getInvoiceForCustomer('10','901','synthetic')).status,'A');assert.equal(transports,0);
  process.env.LZR_ENV='production';assert.throws(()=>result.exports.getIxcRuntime());
});
