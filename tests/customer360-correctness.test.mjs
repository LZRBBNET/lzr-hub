import test from "node:test";
import assert from "node:assert/strict";
import { Customer360Service } from "../lib/platform/customer360-service.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { IxcInvoiceMapper } from "../lib/integrations/ixc/mappers.ts";

const id="demo-customer", now=()=>new Date("2026-10-27T02:30:00Z"); // 26 October in Brasília
const invoice=(over={})=>({id:"invoice-1",customerId:id,status:"A",dueAt:"2026-10-25",value:40,valueSource:"open-balance",...over});
const contract=(over={})=>({id:"contract-1",customerId:id,status:"I",planName:"Plano sintético",...over});
const snapshot=(over={})=>{
  const result={customer:{id,name:"Cliente sintético",document:"DOC-SYNTHETIC",phone:"—",email:"—",address:"—",city:"—",neighborhood:"—",status:"S"},contracts:[contract()],plan:null,invoices:[],payments:[],serviceOrders:[],connection:null,partialSources:[],metrics:{totalLatencyMs:3,blockLatencies:{}},fetchedAt:"2026-10-26T23:00:00Z",mode:"staging-readonly",cache:"miss",...over};
  result.coverage=over.coverage??Object.fromEntries(["contracts","invoices","payments","serviceOrders"].map(key=>[key,{read:result[key].length,total:result[key].length,complete:true,limit:key==="payments"?100:20}]));
  return result;
};
const service=(data,clock=now)=>new Customer360Service(undefined,{getSnapshot:async()=>data},[id],false,clock);
const detail=(data,clock)=>service(data,clock).get(id);

test("Customer360 keeps registration status separate from single ended contract",async()=>{
  const data=snapshot();const svc=service(data);const result=await svc.get(id);
  assert.equal(result.customer.status,"S");assert.equal(result.contract.status,"I");assert.equal(result.reading.contractSelection,"single");
  assert.equal((await svc.list()).items[0].status,"S");assert.equal(result.partial,false);
});
test("Customer360 never selects first of multiple or incomplete contracts as current",async()=>{
  for(const data of [snapshot({contracts:[contract(),contract({id:"contract-2",status:"A"})]}),snapshot({coverage:{}})]){
    const result=await detail(data);assert.equal(result.reading.contractSelection,"ambiguous");assert.equal(result.contract.id,"—");assert.equal(result.contract.monthlyValue,null);
    assert.equal((await service(data).list()).items[0].plan,"Abrir para consultar");
  }
});
test("Customer360 distinguishes zero contracts from unavailable contracts",async()=>{
  assert.equal((await detail(snapshot({contracts:[]}))).reading.contractSelection,"none");
  assert.equal((await detail(snapshot({contracts:[],partialSources:["contracts"]}))).reading.contractSelection,"unavailable");
});
test("Customer360 overdue sums cents only for open invoices before Brasília today",async()=>{
  const data=snapshot({invoices:[invoice(),invoice({id:"today",dueAt:"2026-10-26",value:100}),invoice({id:"future",dueAt:"2026-10-27",value:200}),invoice({id:"paid",status:"R",value:300}),invoice({id:"cancelled",status:"C",value:400}),invoice({id:"decimal",value:0.1}),invoice({id:"decimal-2",value:0.2})]});
  const result=await detail(data);assert.equal(result.reading.referenceDate,"2026-10-26");assert.equal(result.finance.overdueAmount,40.3);assert.equal(result.reading.financeComplete,true);
  assert.equal((await detail(data,()=>new Date("2026-10-27T03:00:00Z"))).finance.overdueAmount,140.3);
});
test("Customer360 zero debt requires complete reliable invoice evidence",async()=>{
  assert.equal((await detail(snapshot())).finance.overdueAmount,0);
  assert.equal((await detail(snapshot({invoices:[invoice({dueAt:"2026-10-26"})]}))).finance.overdueAmount,0);
  for(const data of [snapshot({coverage:{}}),snapshot({partialSources:["invoices"]}),snapshot({invoices:[invoice({status:"unknown"})]}),snapshot({invoices:[invoice({value:undefined})]})]){
    const result=await detail(data);assert.equal(result.finance.overdueAmount,null);assert.equal(result.reading.financeComplete,false);assert.equal(result.partial,true);
  }
});
test("Customer360 20-invoice snapshot does not claim full customer balance",async()=>{
  const invoices=Array.from({length:20},(_,i)=>invoice({id:`invoice-${i}`,value:1}));
  const data=snapshot({invoices});data.coverage.invoices={read:20,total:45,complete:false,limit:20};
  const result=await detail(data);assert.equal(result.finance.overdueAmount,20);assert.equal(result.reading.financeComplete,false);assert.deepEqual(result.reading.coverage.invoices,{read:20,total:45,complete:false,limit:20});
});
test("Customer360 refuses contradictory complete coverage or snapshots over limit",async()=>{
  for(const coverage of [{read:1,total:2,complete:true,limit:20},{read:2,total:1,complete:true,limit:20},{read:1,total:-1,complete:true,limit:20}]){
    const data=snapshot({invoices:[invoice()]});data.coverage.invoices=coverage;
    assert.equal((await detail(data)).reading.financeComplete,false);
  }
  const data=snapshot({invoices:Array.from({length:21},(_,i)=>invoice({id:`i-${i}`,value:1}))});const result=await detail(data);
  assert.equal(result.finance.overdueAmount,20);assert.equal(result.reading.financeComplete,false);assert.equal(result.details.invoices,20);
});
test("Customer360 excludes nominal/unknown-origin values rather than overstating open balance",async()=>{
  for(const valueSource of ["face-value",undefined,"unavailable"]){
    const data=snapshot({invoices:[invoice({value:100,valueSource})]});const result=await detail(data);
    assert.equal(result.finance.overdueAmount,null);assert.equal(result.reading.nominalValueInvoices,1);assert.equal(result.reading.financeComplete,false);
    data.invoices.push(invoice({id:"known",value:20}));const mixed=await detail(data);assert.equal(mixed.finance.overdueAmount,20);
  }
});
test("Customer360 rejects invalid status, dates, amounts, duplicate and foreign invoice identities",async()=>{
  const invalid=[invoice({status:"P"}),invoice({dueAt:"2026-02-30"}),invoice({dueAt:"2026-10-25junk"}),invoice({value:-1}),invoice({value:NaN}),invoice({value:Infinity}),invoice({value:Number.MAX_SAFE_INTEGER}),invoice({customerId:"other"}),invoice({id:""})];
  for(const bad of invalid){const result=await detail(snapshot({invoices:[invoice({id:"known"}),bad]}));assert.equal(result.finance.overdueAmount,40);assert.equal(result.reading.financeComplete,false);assert.equal(result.reading.excludedInvoices,1);}
  const duplicate=await detail(snapshot({invoices:[invoice(),invoice()]}));assert.equal(duplicate.finance.overdueAmount,null);assert.equal(duplicate.details.invoices,0);assert.equal(duplicate.reading.excludedInvoices,2);
});
test("Customer360 preserves source timestamp and cache marker rather than inventing refresh time",async()=>{
  const result=await detail(snapshot({cache:"hit"}));assert.equal(result.reading.observedAt,"2026-10-26T23:00:00Z");assert.ok(result.sources.every(source=>source.cache==="hit"&&source.updatedAt===result.reading.observedAt));
});
test("Customer360 latest payment is a validated date within consulted customer invoices",async()=>{
  const payment=(over)=>({id:"p1",customerId:id,invoiceId:"invoice-1",paidAt:"2026-10-20",method:"PIX",...over});
  const payments=[payment({}),payment({id:"p2",paidAt:"2026-10-25 09:30:00"}),payment({id:"p3",paidAt:"2026-10-26T01:00:00Z"}),payment({id:"bad",paidAt:"2026-10-26garbage"}),payment({id:"impossible",paidAt:"2026-02-30"}),payment({id:"bad-time",paidAt:"2026-10-26T25:00:00Z"}),payment({id:"future",paidAt:"2026-10-28"}),payment({id:"foreign",customerId:"other",paidAt:"2026-10-26"}),payment({id:"wrong-invoice",invoiceId:"other",paidAt:"2026-10-26"})];
  const result=await detail(snapshot({invoices:[invoice()],payments}));assert.equal(result.finance.lastPayment,"2026-10-25");assert.equal(result.details.payments,3);assert.equal(result.reading.coverage.payments.complete,false);
});
test("Customer360 offset payment dates use Brasília calendar instead of lexical timestamp order",async()=>{
  const payments=[{id:"early",customerId:id,invoiceId:"invoice-1",paidAt:"2026-10-26T01:00:00+03:00",method:"PIX"},{id:"later",customerId:id,invoiceId:"invoice-1",paidAt:"2026-10-25T23:30:00-04:00",method:"PIX"}];
  assert.equal((await detail(snapshot({invoices:[invoice()],payments}))).finance.lastPayment,"2026-10-26");
});
test("Customer360 rejects mismatched customer detail and list identity",async()=>{
  const data=snapshot();data.customer.id="other";await assert.rejects(()=>detail(data),/SCOPE_MISMATCH/);
  const list=await service(data).list();assert.equal(list.items[0].status,"Fonte indisponível");assert.equal(list.items[0].name,`Cadastro ${id}`);
});
test("invoice mapper preserves source and zero balance but rejects malformed and unsafe amounts",()=>{
  const raw={id:"i",id_cliente:id,status:"A",valor:"100.00"};
  assert.deepEqual([IxcInvoiceMapper.map({...raw,valor_aberto:"0.00"}).value,IxcInvoiceMapper.map({...raw,valor_aberto:"0.00"}).valueSource],[0,"open-balance"]);
  assert.equal(IxcInvoiceMapper.map(raw).valueSource,"face-value");assert.equal(IxcInvoiceMapper.map({...raw,valor_aberto:"1,20"}).value,1.2);
  for(const valor_aberto of ["n/a","-1","1e3",true,{},"Infinity",String(Number.MAX_SAFE_INTEGER)]){const result=IxcInvoiceMapper.map({...raw,valor_aberto});assert.equal(result.value,undefined);assert.equal(result.valueSource,"unavailable");}
});

const providerFixture=(overrides={},options={})=>{
  const calls=[];
  const defaults={cliente:[{id,razao:"Cliente sintético",ativo:"S"}],cliente_contrato:[{id:"contract-1",id_cliente:id,contrato:"Plano sintético",status:"I"}],fn_areceber:[{id:"invoice-1",id_cliente:id,status:"A",data_vencimento:"2026-10-25",valor_aberto:"40.00"}],fn_movim_finan:[{id:"payment-1",id_receber:"invoice-1",data:"2026-10-20"}],su_oss_chamado:[],radusuarios:[]};
  let clock=Date.parse("2026-10-26T23:00:00Z");
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"synthetic",allowedCustomerIds:[id],retryLimit:0,now:()=>clock,fetcher:async(url,init)=>{
    const resource=String(url).split("/").at(-1);const query=JSON.parse(init.body);calls.push({resource,query});
    const override=overrides[resource];if(override instanceof Error)throw override;
    const rows=defaults[resource]??[];return Response.json(override??{registros:rows,total:String(rows.length),page:"1"});
  },...options});
  return {provider,calls,tick:()=>{clock+=1000;}};
};
test("provider carries explicit complete coverage and original cached observation time",async()=>{
  const {provider,calls,tick}=providerFixture();const first=await provider.getSnapshot(id,"c1");
  assert.deepEqual(first.coverage.invoices,{read:1,total:1,complete:true,limit:20});assert.equal(first.coverage.payments.complete,true);
  const count=calls.length;tick();const cached=await provider.getSnapshot(id,"c2");assert.equal(cached.fetchedAt,first.fetchedAt);assert.equal(cached.cache,"hit");assert.equal(calls.length,count);
});
test("provider never infers complete invoices from absent/invalid totals, duplicate rows or later pages",async()=>{
  const row={id:"i",id_cliente:id,status:"R"};
  for(const override of [{registros:[row]},{registros:[row],total:"NaN"},{registros:[row],total:0},{registros:[row],total:1,page:2},{registros:[row,row],total:2},{registros:[row,null],total:2}]){
    const {provider}=providerFixture({fn_areceber:override});const result=await provider.getSnapshot(id,"bad-page");assert.equal(result.coverage.invoices.complete,false);
  }
});
test("provider does not follow wrong-customer invoice/contract identities with dependent reads",async()=>{
  const {provider,calls}=providerFixture({cliente_contrato:{registros:[{id:"c",id_cliente:"other",id_vd_contrato:"wrong-plan",status:"A"}],total:1},fn_areceber:{registros:[{id:"wrong-invoice",id_cliente:"other",status:"A"}],total:1}});
  const result=await provider.getSnapshot(id,"scope");assert.equal(calls.some(call=>["fn_movim_finan","vd_contratos"].includes(call.resource)),false);assert.equal(result.coverage.invoices.complete,false);assert.equal(result.coverage.payments.complete,false);
});
test("provider rejects wrong customer before any related lookup",async()=>{
  const {provider,calls}=providerFixture({cliente:{registros:[{id:"other"}],total:1}});await assert.rejects(()=>provider.getSnapshot(id,"scope"),/SCOPE_MISMATCH/);assert.equal(calls.length,1);
});
test("provider excludes cross-invoice payment response and marks coverage incomplete",async()=>{
  const {provider}=providerFixture({fn_movim_finan:{registros:[{id:"foreign",id_receber:"other",data:"2026-10-25"}],total:1}});const result=await provider.getSnapshot(id,"scope");assert.equal(result.payments.length,0);assert.equal(result.coverage.payments.complete,false);
});
test("provider declares payment limit and cannot claim full history above ten invoices",async()=>{
  const rows=Array.from({length:12},(_,i)=>({id:`i-${i}`,id_cliente:id,status:"R"}));
  const {provider,calls}=providerFixture({fn_areceber:{registros:rows,total:12},fn_movim_finan:{registros:[],total:0}});const result=await provider.getSnapshot(id,"bounded");assert.equal(calls.filter(call=>call.resource==="fn_movim_finan").length,10);assert.equal(result.coverage.invoices.complete,true);assert.equal(result.coverage.payments.complete,false);assert.equal(result.coverage.payments.total,null);
});
test("provider unavailable financial source remains unavailable, not zero",async()=>{
  const {provider}=providerFixture({fn_areceber:new Error("synthetic network failure")});const result=await detail(await provider.getSnapshot(id,"error"));assert.equal(result.reading.financeAvailable,false);assert.equal(result.finance.overdueAmount,null);
});
