import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSyntheticHandoffFixture } from '../lib/platform/synthetic-handoff-fixture.ts';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';
import { loadConversationSummary } from '../lib/platform/copilot-summary-service.ts';
import { MemoryConversationStateRepository, changeConversationState, stateKey } from '../lib/platform/conversation-state-service.ts';
const config=()=>({...stagingDemoRequirements,FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1'});
const now=new Date('2026-11-05T15:00:00Z');
test('fixture alimenta resumo e assumir reais, sem fabricar envio nem reiniciar responsável',async()=>{
  const plan=prepareSyntheticHandoffFixture(config(),now);const {channel,externalConversationId:id}=plan.message;
  const repository=new MemoryConversationStateRepository();repository.conversations.set(stateKey(channel,id),plan.message.createdAt);
  const reads=[];
  const conversations={
    async getMessages(c,i){assert.equal(c,channel);assert.equal(i,id);reads.push('messages');return [plan.message];},
    async getAudit(c,i){assert.equal(c,channel);assert.equal(i,id);reads.push('outcome');return plan.outcome;},
  };
  const before=await loadConversationSummary(conversations,repository,channel,id);
  assert.match(before,/Cliente pediu atendente/);assert.match(before,/ainda não atribuído/);assert.match(before,/fatura fictícia 901/);
  const actor={id:'synthetic-operator',name:'DEMO Operador',email:'operator@example.invalid',role:'Supervisor'};
  assert.equal((await changeConversationState(repository,{channel,conversationId:id,action:'claim',actor})).ok,true);
  const after=await loadConversationSummary(conversations,repository,channel,id);assert.match(after,/Responsável atual: DEMO Operador/);
  assert.match(after,/Nenhuma resposta enviada está registrada/);assert.equal(repository.audits.length,1);
  prepareSyntheticHandoffFixture(config(),new Date('2026-11-06T15:00:00Z'));
  assert.equal((await repository.get(channel,id)).assigneeId,actor.id);
  assert.deepEqual(reads,['messages','outcome','messages','outcome']);
});
