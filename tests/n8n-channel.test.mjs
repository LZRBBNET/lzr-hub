import test from "node:test";
import assert from "node:assert/strict";
import { MemoryChannelRepository, processChannelMessage, CHANNEL_NAME, SUGGESTION_ROLE } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository, CSAT_QUESTION } from "../lib/platform/support-metrics.ts";

/** Com a resposta automática ligada o canal fala com o cliente; é o modo que essas provas cobrem. */
const REPLYING = { autoReply: true };

test("mensagem nova gera resposta, persiste histórico e audita",async()=>{
  const repository=new MemoryChannelRepository();
  const result=await processChannelMessage(repository,{externalConversationId:"55999999999",text:"estou sem internet",idempotencyKey:"key-1",correlationId:"corr-1"},undefined,REPLYING);
  assert.equal(typeof result.response,"string");assert.ok(result.response.length>0);assert.equal(result.autoReply,true);
  const history=await repository.getHistory(CHANNEL_NAME,"55999999999");
  assert.equal(history.length,2);assert.equal(history[0].role,"customer");assert.equal(history[1].role,"agent");
  assert.equal(repository.audits.length,1);assert.equal(repository.audits[0].result,result.status);
});

test("mesma idempotencyKey não reprocessa nem duplica histórico",async()=>{
  const repository=new MemoryChannelRepository();
  const first=await processChannelMessage(repository,{externalConversationId:"55988888888",text:"quero a segunda via",idempotencyKey:"key-dup",correlationId:"corr-2"},undefined,REPLYING);
  const second=await processChannelMessage(repository,{externalConversationId:"55988888888",text:"quero a segunda via",idempotencyKey:"key-dup",correlationId:"corr-2"},undefined,REPLYING);
  assert.deepEqual(first,second);
  const history=await repository.getHistory(CHANNEL_NAME,"55988888888");
  assert.equal(history.length,2);
  assert.equal(repository.audits.length,1);
});

test("conversa mantém contexto entre mensagens (histórico reaproveitado)",async()=>{
  const repository=new MemoryChannelRepository();
  await processChannelMessage(repository,{externalConversationId:"55977777777",text:"estou sem internet",idempotencyKey:"key-a",correlationId:"corr-a"},undefined,REPLYING);
  const second=await processChannelMessage(repository,{externalConversationId:"55977777777",text:"sim",idempotencyKey:"key-b",correlationId:"corr-b"},undefined,REPLYING);
  assert.equal(typeof second.response,"string");
  const history=await repository.getHistory(CHANNEL_NAME,"55977777777");
  assert.equal(history.length,4);
});

test("resposta automática nasce desligada: sem opção explícita, nada é enviado",async()=>{
  const repository=new MemoryChannelRepository();
  const result=await processChannelMessage(repository,{externalConversationId:"55966666666",text:"estou sem internet",idempotencyKey:"key-default",correlationId:"corr-default"});
  assert.equal(result.autoReply,false);
  assert.equal(result.response,null,"response null impede que um fluxo distraído envie mensagem vazia");
});

test("modo observação grava a resposta como sugestão, nunca como mensagem entregue",async()=>{
  const repository=new MemoryChannelRepository();
  const metrics=new MemorySupportMetricsRepository();
  const result=await processChannelMessage(repository,{externalConversationId:"55955555555",text:"quero a segunda via do boleto",idempotencyKey:"key-obs",correlationId:"corr-obs"},metrics,{autoReply:false});

  assert.equal(result.response,null);
  assert.ok(result.suggestion.length>0,"a sugestão fica disponível para quem for atender");
  assert.equal(result.status,"suggested");

  const history=await repository.getHistory(CHANNEL_NAME,"55955555555");
  assert.equal(history[0].role,"customer");
  assert.equal(history[1].role,SUGGESTION_ROLE,"a resposta não pode aparecer como se tivesse sido enviada");
  assert.equal(metrics.outcomes[0].finalStatus,"suggested");
});

test("sugestão não conta como atendimento resolvido pela IA",async()=>{
  const repository=new MemoryChannelRepository();
  const metrics=new MemorySupportMetricsRepository();
  await processChannelMessage(repository,{externalConversationId:"55944444444",text:"quero a segunda via do boleto",idempotencyKey:"key-m",correlationId:"corr-m"},metrics,{autoReply:false});

  const { getSupportMetrics } = await import("../lib/platform/support-metrics.ts");
  const result = await getSupportMetrics(metrics,"2000-01-01T00:00:00.000Z");
  assert.equal(result.conversations,1);
  assert.equal(result.resolvedWithoutHuman,0,"ninguém foi atendido: a resposta não saiu");
  assert.equal(result.suggestionsOnly,1);
});

test("modo observação não pede avaliação ao cliente",async()=>{
  const repository=new MemoryChannelRepository();
  const result=await processChannelMessage(repository,{externalConversationId:"55933333333",text:"quero a segunda via do boleto",idempotencyKey:"key-csat",correlationId:"corr-csat"},new MemorySupportMetricsRepository(),{autoReply:false});
  assert.ok(!result.suggestion.includes(CSAT_QUESTION),"não se avalia um atendimento que o cliente não recebeu");
});

test("sugestão não entra no histórico que a IA usa para decidir",async()=>{
  const repository=new MemoryChannelRepository();
  await processChannelMessage(repository,{externalConversationId:"55922222222",text:"estou sem internet",idempotencyKey:"key-h1",correlationId:"corr-h1"},undefined,{autoReply:false});
  await processChannelMessage(repository,{externalConversationId:"55922222222",text:"sim",idempotencyKey:"key-h2",correlationId:"corr-h2"},undefined,{autoReply:false});

  const history=await repository.getHistory(CHANNEL_NAME,"55922222222");
  assert.equal(history.filter((row)=>row.role===SUGGESTION_ROLE).length,2);
  assert.equal(history.filter((row)=>row.role==="agent").length,0,"nenhuma mensagem foi entregue ao cliente");
});
