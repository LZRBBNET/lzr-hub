import test from 'node:test';import assert from 'node:assert/strict';
import {FakeTransactionalStore,reservationModel} from './helpers/billing-reservation-model.mjs';
const binding=()=>({customerId:'synthetic-customer',invoiceId:'synthetic-invoice',stepId:'synthetic-step',scheduledFor:'2026-11-13',ruleVersion:1,templateVersion:1});
const evidence=(over={})=>({complete:true,customerId:'synthetic-customer',invoiceId:'synthetic-invoice',open:true,promiseActive:false,observedAt:10,validUntil:20,revision:'fixture-revision-1',...over});
const receipt=(r,over={})=>({authority:'trusted-fixture-adapter',key:r.key,attempt:r.attempt,kind:'accepted',effectId:'synthetic-effect',...over});
async function fixture(run){const store=new FakeTransactionalStore();try{await run(store,reservationModel(store));}finally{await store.close();assert.equal((await store.snapshot()).rows.length,0);}}
const reserve=m=>m.reserve(binding(),10,30);

test('concurrent reservation and begin return exactly one local dispatch permit',()=>fixture(async(s,m)=>{
 const reservations=await Promise.all([reserve(m),reserve(m)]);assert.equal(reservations[0].attempt,reservations[1].attempt);const r=reservations[0];
 const permits=await Promise.all([m.begin(r.key,r.attempt,11,evidence()),m.begin(r.key,r.attempt,11,evidence())]);assert.equal(permits.filter(p=>p.dispatchAllowed).length,1);assert.equal((await s.snapshot()).rows.length,1);
}));
test('crash before reservation commit leaves no intent or effect',()=>fixture(async(s,m)=>{
 s.failNextCommit();await assert.rejects(reserve(m),/COMMIT_FAILURE/);assert.equal((await s.snapshot()).rows.length,0);assert.equal((await reserve(m)).state,'reserved');
}));
test('failed intent commit never returns permission to call a mock effect',()=>fixture(async(s,m)=>{
 const r=await reserve(m);s.failNextCommit();let effects=0;await assert.rejects(async()=>{const permit=await m.begin(r.key,r.attempt,11,evidence());if(permit.dispatchAllowed)effects++;},/COMMIT_FAILURE/);assert.equal(effects,0);assert.equal((await s.snapshot()).rows[0].state,'reserved');
}));
for(const effectOccurred of [false,true])test(`restore committed intent after crash (effect=${effectOccurred}) never reissues permit`,()=>fixture(async(s,m)=>{
 const r=await reserve(m);assert.equal((await m.begin(r.key,r.attempt,11,evidence())).dispatchAllowed,true);let simulatedEffects=0;if(effectOccurred)simulatedEffects++; // Crash point: before or after the no-send effect counter.
 const restored=new FakeTransactionalStore(await s.snapshot());try{const restart=reservationModel(restored);assert.equal((await restart.recover(r.key,r.attempt,100)).state,'unresolved');const replay=await restart.begin(r.key,r.attempt,11,evidence());if(replay.dispatchAllowed)simulatedEffects++;assert.equal(replay.dispatchAllowed,false);assert.equal(simulatedEffects,effectOccurred?1:0);}finally{await restored.close();}
}));
test('reserved restart requires fresh eligibility; expired reservation stays closed',()=>fixture(async(s,m)=>{
 const r=await reserve(m),restored=new FakeTransactionalStore(await s.snapshot());try{const restart=reservationModel(restored);assert.equal((await restart.recover(r.key,r.attempt,30)).state,'expired');assert.equal((await restart.begin(r.key,r.attempt,11,evidence())).dispatchAllowed,false);assert.equal((await reserve(restart)).state,'expired');}finally{await restored.close();}
}));
for(const change of [{open:false},{promiseActive:true},{complete:false},{validUntil:10},{observedAt:12},{customerId:'different'}])test(`changed/unverified evidence blocks before intent: ${JSON.stringify(change)}`,()=>fixture(async(s,m)=>{
 const r=await reserve(m);assert.equal((await m.begin(r.key,r.attempt,11,evidence(change))).dispatchAllowed,false);assert.equal((await m.begin(r.key,r.attempt,11,evidence())).dispatchAllowed,false);
}));
test('payment or promise change after intent cannot prove no effect or enable replay',()=>fixture(async(s,m)=>{
 const r=await reserve(m);await m.begin(r.key,r.attempt,11,evidence());await m.ambiguous(r.key,r.attempt);
 for(const update of [{open:false},{promiseActive:true}])assert.equal((await m.begin(r.key,r.attempt,11,evidence(update))).dispatchAllowed,false);
 assert.equal((await m.recover(r.key,r.attempt,1000)).state,'unresolved');
}));
test('matching receipt is idempotent; conflicting receipt rolls back',()=>fixture(async(s,m)=>{
 const r=await reserve(m);await m.begin(r.key,r.attempt,11,evidence());await m.reconcile(r.key,r.attempt,receipt(r));const saved=await s.snapshot();
 await m.reconcile(r.key,r.attempt,receipt(r));assert.deepEqual(await s.snapshot(),saved);await assert.rejects(m.reconcile(r.key,r.attempt,receipt(r,{effectId:'other'})),/RECEIPT_CONFLICT/);assert.deepEqual(await s.snapshot(),saved);
}));
test('lost confirmation commit remains unresolved until matching authoritative reconciliation',()=>fixture(async(s,m)=>{
 const r=await reserve(m);await m.begin(r.key,r.attempt,11,evidence());s.failNextCommit();await assert.rejects(m.reconcile(r.key,r.attempt,receipt(r)),/COMMIT_FAILURE/);
 await m.recover(r.key,r.attempt,100);assert.equal((await m.begin(r.key,r.attempt,11,evidence())).dispatchAllowed,false);assert.equal((await m.reconcile(r.key,r.attempt,receipt(r))).state,'confirmed');
}));
test('absence is not negative proof; final no-effect proof is terminal, not retry permission',()=>fixture(async(s,m)=>{
 const r=await reserve(m);await m.begin(r.key,r.attempt,11,evidence());await m.ambiguous(r.key,r.attempt);await assert.rejects(m.reconcile(r.key,r.attempt,receipt(r,{kind:'not-found',effectId:null})));
 assert.equal((await m.reconcile(r.key,r.attempt,receipt(r,{kind:'no-effect-final',effectId:null}))).state,'no-effect-confirmed');assert.equal((await m.begin(r.key,r.attempt,11,evidence())).dispatchAllowed,false);
 await assert.rejects(m.reconcile(r.key,r.attempt,receipt(r)),/RECONCILIATION_CONFLICT/);
}));
test('mismatched attempt, authority, binding or receipt scope cannot mutate state',()=>fixture(async(s,m)=>{
 const r=await reserve(m);await m.begin(r.key,r.attempt,11,evidence());const saved=await s.snapshot();
 for(const patch of [{attempt:r.attempt+1},{key:'other'},{authority:'payload-claim'},{extra:'untrusted'}])await assert.rejects(m.reconcile(r.key,r.attempt,receipt(r,patch)));
 await assert.rejects(m.recover(r.key,r.attempt+1,100),/ATTEMPT_MISMATCH/);await assert.rejects(m.reserve({...binding(),customerId:'other'},10,30),/BINDING_CONFLICT/);await assert.rejects(m.reserve({...binding(),templateVersion:2},10,30),/BINDING_CONFLICT/);assert.deepEqual(await s.snapshot(),saved);
}));
test('returned rows, input snapshots and transaction rollback cannot mutate retained state',()=>fixture(async(s,m)=>{
 const r=await reserve(m);r.binding.customerId='tampered';const snap=await s.snapshot(),restored=new FakeTransactionalStore(snap);snap.rows[0].binding.customerId='tampered';try{assert.equal((await restored.snapshot()).rows[0].binding.customerId,'synthetic-customer');await assert.rejects(s.transaction(d=>{d.rows[0].state='confirmed';throw Error('fixture-rollback');}));assert.equal((await s.snapshot()).rows[0].state,'reserved');}finally{await restored.close();}
}));

test('committed draft aliases cannot mutate stored state after transaction',()=>fixture(async(s,m)=>{
 await reserve(m);let retained;await s.transaction(d=>{retained=d;return null;});retained.rows[0].state='confirmed';assert.equal((await s.snapshot()).rows[0].state,'reserved');
}));
test('attempt sequence survives snapshot restore and stale token cannot address another intent',()=>fixture(async(s,m)=>{
 const first=await reserve(m),restored=new FakeTransactionalStore(await s.snapshot());try{const restart=reservationModel(restored),second=await restart.reserve({...binding(),invoiceId:'second-invoice'},10,30);assert.ok(second.attempt>first.attempt);await assert.rejects(restart.begin(second.key,first.attempt,11,evidence()),/ATTEMPT_MISMATCH/);assert.equal((await restored.snapshot()).rows[1].state,'reserved');}finally{await restored.close();}
}));
