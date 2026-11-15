// Executable specification ONLY. No database, worker, transport or environment integration.
import assert from 'node:assert/strict';
export class FakeTransactionalStore {
 #data; #tail=Promise.resolve(); #fail=false;
 constructor(snapshot={rows:[],sequence:0}){this.#data=structuredClone(snapshot);}
 failNextCommit(){this.#fail=true;}
 async transaction(operation){
  const pending=this.#tail.then(()=>{
   const draft=structuredClone(this.#data),result=operation(draft);
   assert.ok(!result?.then,'SYNCHRONOUS_TRANSACTION_ONLY');
   if(this.#fail){this.#fail=false;throw Error('SYNTHETIC_COMMIT_FAILURE');}
   this.#data=structuredClone(draft);return structuredClone(result);
  });
  this.#tail=pending.catch(()=>{});return pending;
 }
 async snapshot(){await this.#tail;return structuredClone(this.#data);}
 async close(){await this.#tail;this.#data={rows:[],sequence:0};}
}
const keyFor=b=>`${b.invoiceId}:${b.stepId}:${b.scheduledFor}`;
const identity=b=>JSON.stringify([b.customerId,b.invoiceId,b.stepId,b.scheduledFor,b.ruleVersion,b.templateVersion]);
function rowFor(data,key,attempt){const row=data.rows.find(r=>r.key===key);assert.ok(row&&row.attempt===attempt,'ATTEMPT_MISMATCH');return row;}
function receiptFor(row,receipt){
 assert.deepEqual(Object.keys(receipt).sort(),['attempt','authority','effectId','key','kind']);
 assert.equal(receipt.authority,'trusted-fixture-adapter');assert.equal(receipt.key,row.key);assert.equal(receipt.attempt,row.attempt);
 assert.ok(['accepted','no-effect-final'].includes(receipt.kind));
 if(receipt.kind==='accepted')assert.ok(typeof receipt.effectId==='string'&&receipt.effectId.length>0);
 else assert.equal(receipt.effectId,null);
}
export function reservationModel(store){return {
 async reserve(binding,now,leaseUntil){
  assert.ok(Number.isSafeInteger(now)&&Number.isSafeInteger(leaseUntil)&&leaseUntil>now);
  assert.deepEqual(Object.keys(binding).sort(),['customerId','invoiceId','ruleVersion','scheduledFor','stepId','templateVersion']);
  return store.transaction(data=>{
   const key=keyFor(binding),existing=data.rows.find(r=>r.key===key);
   if(existing){assert.equal(identity(existing.binding),identity(binding),'BINDING_CONFLICT');return existing;}
   const row={key,binding:structuredClone(binding),attempt:++data.sequence,state:'reserved',leaseUntil};data.rows.push(row);return row;
  });
 },
 async begin(key,attempt,now,evidence){return store.transaction(data=>{
  const row=rowFor(data,key,attempt);if(row.state!=='reserved')return {dispatchAllowed:false,state:row.state};
  assert.ok(Number.isSafeInteger(now));
  if(now>=row.leaseUntil){row.state='expired';return {dispatchAllowed:false,state:row.state};}
  const valid=evidence?.complete===true&&evidence.invoiceId===row.binding.invoiceId&&evidence.customerId===row.binding.customerId
   &&evidence.open===true&&evidence.promiseActive===false&&Number.isSafeInteger(evidence.observedAt)&&Number.isSafeInteger(evidence.validUntil)
   &&evidence.observedAt<=now&&now<=evidence.validUntil&&typeof evidence.revision==='string'&&evidence.revision.length>0;
  if(!valid){row.state='blocked';return {dispatchAllowed:false,state:row.state};}
  row.state='intent';row.evidenceRevision=evidence.revision;
  return {dispatchAllowed:true,key,attempt}; // Returned only AFTER fake commit; no effect in this transaction.
 });},
 async recover(key,attempt,now){return store.transaction(data=>{
  const row=rowFor(data,key,attempt);assert.ok(Number.isSafeInteger(now));
  if(row.state==='intent')row.state='unresolved';
  else if(row.state==='reserved'&&now>=row.leaseUntil)row.state='expired';
  return row;
 });},
 async ambiguous(key,attempt){return store.transaction(data=>{const row=rowFor(data,key,attempt);if(row.state==='intent')row.state='unresolved';return row;});},
 async reconcile(key,attempt,receipt){return store.transaction(data=>{
  const row=rowFor(data,key,attempt);receiptFor(row,receipt);
  const target=receipt.kind==='accepted'?'confirmed':'no-effect-confirmed';
  if(['confirmed','no-effect-confirmed'].includes(row.state)){assert.equal(row.state,target,'RECONCILIATION_CONFLICT');assert.equal(row.effectId,receipt.effectId,'RECEIPT_CONFLICT');return row;}
  assert.ok(['intent','unresolved'].includes(row.state),'RECONCILIATION_STATE_REFUSED');
  row.state=target;row.effectId=receipt.effectId;return row;
 });},
};}
