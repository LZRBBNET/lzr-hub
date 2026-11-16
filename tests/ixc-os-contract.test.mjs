import test from "node:test";
import assert from "node:assert/strict";
import {IxcReadonlyProvider} from "../lib/integrations/ixc/readonly-provider.ts";
import {IxcServiceOrderMapper} from "../lib/integrations/ixc/mappers.ts";
import {openServiceOrder} from "../lib/integrations/ixc/write-client.ts";
import {MemoryIxcWriteOperationsRepository,requestServiceOrderOpen,serviceOrderLedgerResult} from "../lib/platform/ixc-write-service.ts";
function provider(body,capture=()=>{}) {return new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"synthetic",allowedCustomerIds:["101"],retryLimit:0,cacheTtlMs:0,fetcher:async(url,init)=>{capture(url,JSON.parse(init.body));return new Response(JSON.stringify(body))}})}
const contract={id:"202",id_cliente:"101",status:"A"};
test("exact contract read verifies active ownership with complete single result",async()=>{
 let query;const result=await provider({page:"1",total:"1",registros:[contract]},(_url,p)=>{query=p}).getServiceOrderContract("101","202","test");
 assert.deepEqual(result,{id:"202",customerId:"101",status:"A"});assert.equal(query.query,"202");assert.equal(query.rp,"2");
 assert.deepEqual(JSON.parse(query.grid_param),[{TB:"cliente_contrato.id_cliente",OP:"=",P:"101"}]);
});
test("missing, foreign, inactive or ambiguous contract cannot authorize OS",async()=>{
 for(const body of [
 {total:0,registros:[]}, {total:1,registros:[{...contract,id_cliente:"999"}]},
 {total:1,registros:[{...contract,status:"I"}]}, {total:2,registros:[contract,{...contract,id:"203"}]},
 {registros:[contract]}, {total:1,registros:[{...contract,id:"203"}]}]){
 await assert.rejects(provider(body).getServiceOrderContract("101","202","test"));
 }
});
test("OS reconciliation uses id_contrato_kit and rejects mismatched or missing linkage",async()=>{
 const order={id:"303",id_cliente:"101",id_contrato_kit:"202",status:"A"};let query;
 const value=await provider({total:1,registros:[order]},(_url,p)=>{query=p}).reconcileServiceOrder("101","202","303","test");
 assert.equal(value.contractId,"202");assert.equal(query.query,"303");
 assert.ok(JSON.parse(query.grid_param).some(f=>f.TB==="su_oss_chamado.id_contrato_kit"&&f.P==="202"));
 for(const body of [{total:1,registros:[{...order,id_contrato_kit:"999"}]},{total:1,registros:[{...order,id_cliente:"999"}]},{total:1,registros:[{...order,id_contrato_kit:undefined}]},{total:2,registros:[order,{...order,id:"304"}]},{total:0,registros:[]}]){
 await assert.rejects(provider(body).reconcileServiceOrder("101","202","303","test"));
 }
 assert.equal(IxcServiceOrderMapper.map(order).contractId,"202");
});
test("legacy write without selected contract is rejected before transport",async()=>{
 let calls=0;await assert.rejects(openServiceOrder({baseUrl:"https://ixc.invalid",token:"synthetic",fetcher:async()=>{calls++;return new Response("{}")}}, {customerId:"101"},"test"));assert.equal(calls,0);
});
test("policy refuses unproven contract even if caller supplies other valid fields",async()=>{
 process.env.FEATURE_IXC_WRITE="true";
 try {
 const valid={customerId:"101",contractId:"202",confirmedContract:{id:"202",customerId:"101",status:"A"},subjectId:"4",sectorId:"5",branchId:"1",priority:"1",message:"Synthetic local description",idempotencyKey:"synthetic",correlationId:"test",requestedBy:"test@example.invalid",knownSubjectIds:new Set(["4"]),knownSectorIds:new Set(["5"]),openSubjects:new Set()};
 for(const change of [{contractId:""},{confirmedContract:undefined},{confirmedContract:{id:"202",customerId:"999",status:"A"}},{confirmedContract:{id:"202",customerId:"101",status:"I"}}]){
 let calls=0;const result=await requestServiceOrderOpen({...valid,...change},new MemoryIxcWriteOperationsRepository(),async()=>{calls++;return {raw:{id:"303"}}});assert.equal(result.status,"blocked");assert.equal(calls,0);
 }
 assert.equal(serviceOrderLedgerResult({status:"success",detail:"legacy unscoped result"}).status,"unknown");
 const repo=new MemoryIxcWriteOperationsRepository();await requestServiceOrderOpen(valid,repo,async()=>({raw:{id:"303"}}));
 const saved=serviceOrderLedgerResult(repo.rows.find(r=>r.operation==="service_order.open"));assert.equal(saved.contractId,"202");assert.equal(saved.serviceOrderId,"303");
 } finally {delete process.env.FEATURE_IXC_WRITE;}
});
