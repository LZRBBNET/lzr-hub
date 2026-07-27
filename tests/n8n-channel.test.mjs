import test from "node:test";
import assert from "node:assert/strict";
import { MemoryChannelRepository, processChannelMessage, CHANNEL_NAME } from "../lib/platform/n8n-channel-service.ts";

test("mensagem nova gera resposta, persiste histórico e audita",async()=>{
  const repository=new MemoryChannelRepository();
  const result=await processChannelMessage(repository,{externalConversationId:"55999999999",text:"estou sem internet",idempotencyKey:"key-1",correlationId:"corr-1"});
  assert.equal(typeof result.response,"string");assert.ok(result.response.length>0);
  const history=await repository.getHistory(CHANNEL_NAME,"55999999999");
  assert.equal(history.length,2);assert.equal(history[0].role,"customer");assert.equal(history[1].role,"agent");
  assert.equal(repository.audits.length,1);assert.equal(repository.audits[0].result,result.status);
});

test("mesma idempotencyKey não reprocessa nem duplica histórico",async()=>{
  const repository=new MemoryChannelRepository();
  const first=await processChannelMessage(repository,{externalConversationId:"55988888888",text:"quero a segunda via",idempotencyKey:"key-dup",correlationId:"corr-2"});
  const second=await processChannelMessage(repository,{externalConversationId:"55988888888",text:"quero a segunda via",idempotencyKey:"key-dup",correlationId:"corr-2"});
  assert.deepEqual(first,second);
  const history=await repository.getHistory(CHANNEL_NAME,"55988888888");
  assert.equal(history.length,2);
  assert.equal(repository.audits.length,1);
});

test("conversa mantém contexto entre mensagens (histórico reaproveitado)",async()=>{
  const repository=new MemoryChannelRepository();
  await processChannelMessage(repository,{externalConversationId:"55977777777",text:"estou sem internet",idempotencyKey:"key-a",correlationId:"corr-a"});
  const second=await processChannelMessage(repository,{externalConversationId:"55977777777",text:"sim",idempotencyKey:"key-b",correlationId:"corr-b"});
  assert.equal(typeof second.response,"string");
  const history=await repository.getHistory(CHANNEL_NAME,"55977777777");
  assert.equal(history.length,4);
});
