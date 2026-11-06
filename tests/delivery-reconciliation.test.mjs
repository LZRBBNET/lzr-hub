import test from 'node:test';
import assert from 'node:assert/strict';
import {DbDeliveryReconciliation} from '../lib/platform/delivery-reconciliation-service.ts';
import {can,roles} from '../lib/platform/rbac.ts';
const forbiddenDb=new Proxy({}, {get(){throw Error('unauthorized database access');}});
const input={channel:'synthetic',conversationId:'5511000000000',reservationId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',outcome:'not_sent',evidence:'Protocolo sintético de revisão',actor:{id:'qa',name:'QA',email:'qa@example.invalid',role:'Supervisor'}};
for(const role of roles)test(`reconciliação: permissão explícita de ${role}`,async()=>{
 assert.equal(can(role,'support.reconcile'),['Administrador','Supervisor'].includes(role));
 if(!can(role,'support.reconcile'))await assert.rejects(()=>new DbDeliveryReconciliation(forbiddenDb).reconcile({...input,actor:{...input.actor,role}}),e=>e.status===403);
});
test('conclusão vaga e ausência de prova são recusadas antes da transação',async()=>{
 for(const changes of [{outcome:'unknown'},{evidence:'curta'},{reservationId:'outra'},{outcome:'accepted'},{outcome:'not_sent',messageId:'synthetic-id'}])await assert.rejects(()=>new DbDeliveryReconciliation(forbiddenDb).reconcile({...input,...changes}),e=>e.status===400);
});
