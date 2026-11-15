import test from 'node:test';
import assert from 'node:assert/strict';
import {isBusinessHour,resolveTodayCandidates} from '../lib/platform/collection-dispatch-service.ts';

// Pure calendar contract only: no repository, queue, provider or transport call.
const invoice=dueAt=>({id:'synthetic-invoice',customerId:'synthetic-customer',status:'A',dueAt});
const rule=offsetDays=>({id:'synthetic-rule',name:'Calendar fixture',status:'draft',version:1,authorId:'fixture',updatedAt:'',steps:[{id:'synthetic-step',offsetDays,channel:'WhatsApp',templateId:'synthetic-no-send',attempts:1,active:true}]});
const candidates=(due,offset,now)=>resolveTodayCandidates(rule(offset),[invoice(due)],new Date(now));

test('D0 changes at Brazil midnight, not UTC midnight, and expires the next day',()=>{
 assert.equal(candidates('2026-08-10',0,'2026-08-10T02:59:59.999Z').length,0);
 assert.equal(candidates('2026-08-10',0,'2026-08-10T03:00:00.000Z').length,1);
 assert.equal(candidates('2026-08-10',0,'2026-08-11T02:59:59.999Z')[0].scheduledFor,'2026-08-10');
 assert.equal(candidates('2026-08-10',0,'2026-08-11T03:00:00.000Z').length,0);
});
test('positive offset selects only its exact overdue day, without catch-up',()=>{
 for(const [day,count] of [['10',0],['11',0],['12',0],['13',1],['14',0]])assert.equal(candidates('2026-08-10',3,`2026-08-${day}T15:00:00Z`).length,count);
});
for(const [due,day] of [['2026-01-31','2026-02-01'],['2024-02-29','2024-03-01'],['2026-12-31','2027-01-01']])test(`D+1 uses civil calendar across ${due}`,()=>{
 assert.equal(candidates(due,1,`${day}T15:00:00Z`)[0].scheduledFor,day);
});
test('accepted timestamp prefix stays a due-date label rather than an instant conversion',()=>{
 assert.equal(candidates('2026-08-10T23:00:00-03:00',0,'2026-08-10T15:00:00Z').length,1);
 assert.equal(candidates('2026-08-10T23:00:00-03:00',0,'2026-08-11T15:00:00Z').length,0);
});
test('business window includes exactly 08:00 and excludes exactly 20:00 Brazil',()=>{
 for(const [instant,expected] of [['2026-08-10T10:59:59.999Z',false],['2026-08-10T11:00:00.000Z',true],['2026-08-10T22:59:59.999Z',true],['2026-08-10T23:00:00.000Z',false]])assert.equal(isBusinessHour(new Date(instant)),expected,instant);
});
test('weekend candidates are not automatic Monday catch-up or permission to dispatch',()=>{
 assert.equal(candidates('2026-08-08',0,'2026-08-08T15:00:00Z').length,1);
 assert.equal(isBusinessHour(new Date('2026-08-08T15:00:00Z')),false);
 assert.equal(isBusinessHour(new Date('2026-08-09T15:00:00Z')),false);
 assert.equal(candidates('2026-08-08',0,'2026-08-10T15:00:00Z').length,0);
});
