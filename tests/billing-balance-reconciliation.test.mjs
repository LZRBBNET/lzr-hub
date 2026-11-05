import test from 'node:test';
import assert from 'node:assert/strict';
import { IxcReadonlyProvider } from '../lib/integrations/ixc/readonly-provider.ts';
import { MemoryPaymentPromiseRepository, reconcilePaymentPromises } from '../lib/platform/payment-promise-service.ts';
import { MemoryCollectionDispatchRepository, resolveTodayCandidates } from '../lib/platform/collection-dispatch-service.ts';
import { createProcessor } from '../services/queue-runtime/src/processor.mjs';
const now=new Date('2026-11-05T15:00:00.000Z');
const rule={id:'synthetic-rule',version:1,steps:[{id:'synthetic-step',active:true,offsetDays:0,channel:'WhatsApp',templateId:'synthetic-template'}]};
function fixture(){
 const state={status:'A',balance:'50',customerId:'10',total:1},reads=[];
 const provider=new IxcReadonlyProvider({baseUrl:'https://synthetic.invalid',token:'synthetic-not-a-credential',allowedCustomerIds:['10'],retryLimit:0,rateLimitPerMinute:1000,
  fetcher:async(url,init)=>{assert.equal(new Headers(init.headers).get('ixcsoft'),'listar');const body=JSON.parse(init.body);reads.push(body);
   const resource=new URL(url).pathname.split('/').at(-1);
   return Response.json(resource==='cliente'?{registros:[{id:'10',razao:'DEMO Cliente',ativo:'S'}],total:1}:resource==='fn_areceber'?{registros:state.total===0?[]:[{id:'901',id_cliente:state.customerId,linha_digitavel:'SYNTHETIC-NOT-PAYABLE',status:state.status,data_vencimento:'2026-11-05',valor:'50',...(state.balance===undefined?{}:{valor_aberto:state.balance})}],total:state.total}:{registros:[],total:0});}});
 return{state,reads,provider};
}
test('saldo zera antes do status: promessa não vira cumprida por inferência e job capturado não continua',async()=>{
 const {provider,state,reads}=fixture(),promises=new MemoryPaymentPromiseRepository();
 const promise=await promises.create({customerId:'10',invoiceId:'901',promisedFor:'2026-11-05',registeredBy:'operator@example.invalid',correlationId:'synthetic-review'});
 const original=await provider.getInvoiceBalanceForCustomer('10','901','synthetic-before');
 assert.deepEqual(Object.keys(original).sort(),['customerId','dueAt','id','status','value','valueSource']);
 const candidates=resolveTodayCandidates(rule,[original],now),ledger=new MemoryCollectionDispatchRepository();
 assert.equal(candidates.length,1);await ledger.record(candidates.map(c=>({...c,correlationId:'synthetic-decision'})));
 const decision=ledger.rows[0],payload={schemaVersion:1,invoiceId:decision.invoiceId,customerId:decision.customerId,ruleId:rule.id,ruleVersion:1,stepId:decision.stepId,scheduledFor:decision.scheduledFor,channel:'WhatsApp',templateId:'synthetic-template'};
 const job={queueName:'billing-reminders',name:'collection-step:synthetic-step',data:{idempotencyKey:'901:synthetic-step:2026-11-05',payload}};
 let continued=0;
 const processor=createProcessor('billing-reminders',{now:()=>now,readEvidence:async context=>({complete:true,observedAt:now.toISOString(),invoice:await provider.getInvoiceBalanceForCustomer(context.customerId,context.invoiceId,'synthetic-worker'),intent:{...context,offsetDays:0,active:true,current:true,cancelled:false}}),continueEligible:async()=>{continued++;return{simulated:true,delivered:false};}});
 state.balance='0';
 const inconclusive=await reconcilePaymentPromises(promises,provider,'synthetic-zero',now);
 assert.deepEqual(inconclusive.stillPending,[promise.id]);assert.deepEqual(inconclusive.fulfilled,[]);
 await assert.rejects(processor(job),{code:'BILLING_INVOICE_BALANCE_UNCONFIRMED'});assert.equal(continued,0);
 state.balance=undefined;await assert.rejects(processor(job),{code:'BILLING_INVOICE_BALANCE_UNCONFIRMED'});assert.equal(continued,0,'nominal value is not open debt');
 state.status='R';state.balance='0';
 const paid=await reconcilePaymentPromises(promises,provider,'synthetic-paid',now);assert.deepEqual(paid.fulfilled,[promise.id]);
 await assert.rejects(processor(job),{code:'BILLING_INVOICE_NOT_OPEN'});assert.equal(continued,0);
 assert.equal(ledger.rows.length,1,'guard never creates another decision');assert.ok(reads.some(r=>r.qtype==='fn_areceber.id'));
});

test('consulta de saldo é fresca, mínima e recusa identidade/recorte inconsistentes',async()=>{
 const {provider,state}=fixture();const first=await provider.getInvoiceBalanceForCustomer('10','901','synthetic-first');assert.equal(first.value,50);
 assert.equal('paymentCode' in first,false);state.balance='0';assert.equal((await provider.getInvoiceBalanceForCustomer('10','901','synthetic-second')).value,0);
 assert.deepEqual(await provider.getInvoiceForCustomer('10','901','synthetic-minimal'),{id:'901',customerId:'10',status:'A'});
 state.customerId='20';await assert.rejects(provider.getInvoiceBalanceForCustomer('10','901','synthetic-wrong-owner'),/SCOPE_MISMATCH/);
 state.customerId='10';state.total=2;await assert.rejects(provider.getInvoiceBalanceForCustomer('10','901','synthetic-partial'),/INCOMPLETE_INVOICE_RESPONSE/);
 state.total=0;assert.equal(await provider.getInvoiceBalanceForCustomer('10','901','synthetic-missing'),undefined);
});
