import assert from 'node:assert/strict';
import test from 'node:test';
import { excludePromiseHeldInvoices } from '../lib/platform/collection-dispatch-source.ts';
import { evaluatePromiseHold } from '../services/queue-runtime/src/promise-hold.mjs';
const invoice={id:'901',customerId:'10',status:'A',dueAt:'2026-11-03',value:50};
const promise={id:'p',customerId:'10',invoiceId:'901',status:'pending',promisedFor:'2026-11-09'};
const repo=rows=>({listByCustomer:async()=>structuredClone(rows)});
for(const access of ['blocked','temporarily-enabled'])test(`inclusive Brazil day preserves ${access}`,async()=>{
 const row={...invoice,access};const at=new Date('2026-11-10T02:59:59.999Z');
 assert.deepEqual(await excludePromiseHeldInvoices([row],repo([promise]),at),{invoices:[],paused:1});assert.equal(row.access,access);
 assert.deepEqual(evaluatePromiseHold({complete:true,customerId:'10',invoiceId:'901',items:[promise]},'10','901',at),{state:'paused',through:'2026-11-09',resumeOn:'2026-11-10'});
});
test('next civil day releases eligibility, never selects a resumption step',async()=>{
 assert.deepEqual(await excludePromiseHeldInvoices([invoice],repo([promise]),new Date('2026-11-10T03:00:00Z')),{invoices:[invoice],paused:0});
});
test('known terminal promise statuses do not hold or infer invoice payment',async()=>{
 for(const status of ['fulfilled','broken'])assert.equal((await excludePromiseHeldInvoices([invoice],repo([{...promise,status}]),new Date('2026-11-09T15:00:00Z'))).paused,0);
 assert.equal(invoice.status,'A');
});
test('cancellation aliases are unsupported and fail closed without inventing transition',async()=>{
 for(const status of ['cancelled','canceled','cancelada'])await assert.rejects(excludePromiseHeldInvoices([invoice],repo([{...promise,status}]),new Date('2026-11-09T15:00:00Z')),/PROMISE_UNCONFIRMED/);
});
test('renewal extends the inclusive hold',async()=>{
 const next={...promise,id:'new',promisedFor:'2026-11-12'};assert.equal((await excludePromiseHeldInvoices([invoice],repo([promise,next]),new Date('2026-11-11T15:00:00Z'))).paused,1);
});
test('unavailable persistence and malformed sibling rows abort entire scope',async()=>{
 await assert.rejects(excludePromiseHeldInvoices([invoice],{listByCustomer:async()=>{throw Error('SQL_UNAVAILABLE');}},new Date()),/SQL_UNAVAILABLE/);
 for(const rows of [[promise,promise],[{...promise,invoiceId:'902',promisedFor:'2026-02-30'}],[{...promise,customerId:'20'}]])await assert.rejects(excludePromiseHeldInvoices([invoice],repo(rows),new Date('2026-11-09T15:00:00Z')));
});
