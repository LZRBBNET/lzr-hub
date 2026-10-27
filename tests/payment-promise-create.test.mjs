import test from "node:test";
import assert from "node:assert/strict";
import { createVerifiedPaymentPromise, MemoryPaymentPromiseRepository, PaymentPromiseValidationError, PaymentPromiseVerificationError, parsePromisedFor } from "../lib/platform/payment-promise-service.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";

const now=new Date("2026-10-27T02:30:00Z"); // 26 October in Brasília
const entry={customerId:"10",invoiceId:"901",promisedFor:"2026-10-28",registeredBy:"operator@example.invalid",correlationId:"synthetic-create"};
const invoice=(over={})=>({id:"901",customerId:"10",status:"A",...over});
function context(source={getInvoiceForCustomer:async()=>invoice()}){
  const repository=new MemoryPaymentPromiseRepository();let dbLoads=0;
  const create=(input=entry,clock=now)=>createVerifiedPaymentPromise(async()=>{dbLoads++;return repository;},source,input,clock);
  return {repository,create,dbLoads:()=>dbLoads};
}

test("create promise confirms exact invoice/customer freshly before touching repository",async()=>{
  const calls=[];const source={getInvoiceForCustomer:async(...args)=>{calls.push(args);return invoice();},getSnapshot:()=>assert.fail("no cached snapshot")};
  const {repository,create,dbLoads}=context(source);const row=await create();
  assert.deepEqual(calls,[["10","901","synthetic-create"]]);assert.equal(dbLoads(),1);assert.equal(repository.rows.length,1);
  assert.equal(row.status,"pending");assert.equal(row.registeredBy,entry.registeredBy);assert.equal(row.promisedFor,entry.promisedFor);
});

test("create accepts only the known open code, with trim/case normalization",async()=>{
  const ctx=context({getInvoiceForCustomer:async()=>invoice({status:" a "})});assert.equal((await ctx.create()).status,"pending");
});

for(const [label,source,status] of [
  ["source disabled",null,503],
  ["network failure",{getInvoiceForCustomer:async()=>{throw new Error("secret backend message");}},503],
  ["partial response",{getInvoiceForCustomer:async()=>{throw new Error("IXC_INCOMPLETE_INVOICE_RESPONSE");}},503],
  ["invoice absent",{getInvoiceForCustomer:async()=>undefined},404],
  ["paid",{getInvoiceForCustomer:async()=>invoice({status:"R"})},409],
  ["cancelled",{getInvoiceForCustomer:async()=>invoice({status:" c "})},409],
  ["unknown status",{getInvoiceForCustomer:async()=>invoice({status:"P"})},503],
  ["blank status",{getInvoiceForCustomer:async()=>invoice({status:""})},503],
  ["malformed status",{getInvoiceForCustomer:async()=>invoice({status:false})},503],
  ["wrong invoice",{getInvoiceForCustomer:async()=>invoice({id:"902"})},503],
  ["wrong customer",{getInvoiceForCustomer:async()=>invoice({customerId:"11"})},503],
])test(`create does not open database or persist promise when ${label}`,async()=>{
  const ctx=context(source);
  await assert.rejects(()=>ctx.create(),error=>error instanceof PaymentPromiseVerificationError&&error.status===status&&!error.message.includes("secret"));
  assert.equal(ctx.dbLoads(),0);assert.equal(ctx.repository.rows.length,0);
});

test("invalid IDs/date are rejected before any source or database call",async()=>{
  const ctx=context({getInvoiceForCustomer:()=>assert.fail("must validate first")});
  for(const id of ["", "0", "01", "-1", "1e3", "1 OR 1=1", "9".repeat(33)]){
    await assert.rejects(()=>ctx.create({...entry,invoiceId:id}),PaymentPromiseValidationError);
    await assert.rejects(()=>ctx.create({...entry,customerId:id}),PaymentPromiseValidationError);
  }
  for(const date of ["2026-11-31","2026-13-01","2026-10-00","2026-10-29junk","2026-10-25","2027-03-01"]){
    await assert.rejects(()=>ctx.create({...entry,promisedFor:date}),PaymentPromiseValidationError);
  }
  assert.equal(ctx.dbLoads(),0);assert.equal(ctx.repository.rows.length,0);
});

test("promised date uses real Gregorian dates and Brasília day/range boundaries",()=>{
  assert.equal(parsePromisedFor("2026-10-26",now),"2026-10-26");
  assert.equal(parsePromisedFor("2026-12-25",now),"2026-12-25");
  assert.throws(()=>parsePromisedFor("2026-12-26",now),PaymentPromiseValidationError);
  assert.throws(()=>parsePromisedFor("2027-02-29",new Date("2027-02-01T12:00:00Z")),PaymentPromiseValidationError);
  assert.equal(parsePromisedFor("2028-02-29",new Date("2028-02-01T12:00:00Z")),"2028-02-29");
});

test("second create rechecks source rather than reusing previous open status",async()=>{
  let reads=0;const ctx=context({getInvoiceForCustomer:async()=>invoice({status:++reads===1?"A":"R"})});
  await ctx.create();await assert.rejects(()=>ctx.create(),error=>error.status===409);
  assert.equal(reads,2);assert.equal(ctx.repository.rows.length,1);assert.equal(ctx.dbLoads(),1);
});

test("actual readonly provider finds an invoice outside first20 without snapshot lookup",async()=>{
  const calls=[];
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"synthetic",allowedCustomerIds:["10"],retryLimit:0,fetcher:async(url,init)=>{
    calls.push({url,method:init.method,command:new Headers(init.headers).get("ixcsoft"),query:JSON.parse(init.body)});
    return Response.json({registros:[{id:"901",id_cliente:"10",status:"A"}],total:"1"});
  }});
  provider.getSnapshot=()=>assert.fail("first20 snapshot must never be used");
  const ctx=context(provider);await ctx.create();
  assert.equal(ctx.repository.rows.length,1);assert.equal(calls.length,1);assert.equal(calls[0].command,"listar");
  assert.equal(calls[0].query.query,"901");assert.equal(calls[0].query.qtype,"fn_areceber.id");
  assert.deepEqual(JSON.parse(calls[0].query.grid_param),[{TB:"fn_areceber.id_cliente",OP:"=",P:"10"}]);
});

for(const [label,body] of [
  ["missing total",{registros:[{id:"901",id_cliente:"10",status:"A"}]}],
  ["wrong customer",{registros:[{id:"901",id_cliente:"11",status:"A"}],total:1}],
  ["duplicate invoice",{registros:[{id:"901",id_cliente:"10",status:"A"},{id:"901",id_cliente:"10",status:"A"}],total:2}],
])test(`actual provider ${label} cannot create a promise`,async()=>{
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"synthetic",allowedCustomerIds:["10"],retryLimit:0,fetcher:async()=>Response.json(body)});
  const ctx=context(provider);await assert.rejects(()=>ctx.create(),error=>error.status===503);assert.equal(ctx.dbLoads(),0);assert.equal(ctx.repository.rows.length,0);
});
