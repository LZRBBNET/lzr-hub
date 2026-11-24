import test from "node:test";
import assert from "node:assert/strict";
import { currentTrustRequest } from "../lib/platform/n8n-channel-service.ts";
import { AI_AGENT_SENDER } from "../lib/platform/conversation-state-shared.ts";

const now = Date.parse("2026-11-24T23:45:00Z");
const row = (role, content, ms, sentBy) => ({role, content, createdAt: new Date(now-ms).toISOString(), sentBy});
const request = row("customer", "Pode liberar minha internet?", 120_000);
const prompt = row("agent", "Quando você consegue pagar?", 60_000, AI_AGENT_SENDER);

test("novo pedido explícito funciona com saudação e referências naturais de pagamento", () => {
  for (const text of [
    "Boa noite, pode liberar por confiança? Só consigo pagar amanhã.",
    "Poderiam desbloquear minha internet? Pago sexta.",
    "Libera minha internet por favor",
    "Pode liberar minha internet",
  ]) assert.ok(currentTrustRequest(text, [], now), text);
});

test("só interpreta data relativa quando responde a uma pergunta recente e diretamente ligada ao pedido", () => {
  assert.ok(currentTrustRequest("amanhã", [request,prompt],now));
  assert.ok(currentTrustRequest("pago outro dia", [request,prompt],now));
  for (const rows of [
    [request],
    [request, {...prompt,sentBy:"human"}],
    [request, row("agent", "A luz LOS está vermelha?", 60_000, AI_AGENT_SENDER)],
    [request, row("agent", prompt.content, 301_000, AI_AGENT_SENDER)],
    [request, prompt, row("customer", "Quero saber meu plano", 20_000)],
  ]) assert.equal(currentTrustRequest("amanhã",rows,now),false);
});

test("saudação, silêncio, resposta curta, hipótese, negativa e mudança de assunto nunca autorizam confiança", () => {
  for (const text of [
    "Boa noite!", "sim", "pode ser", "não libera minha internet",
    "se eu pedir pode liberar minha internet?", "na verdade quero meu pix",
    "não era para desbloquear minha internet", "preciso de segunda via",
  ]) assert.equal(currentTrustRequest(text,[request,prompt],now),false,text);
});

test("reentrega simultânea na fila conserva uma fala sem chamar IA nem enviar", async () => {
  const { processChannelMessage, MemoryChannelRepository, CHANNEL_NAME } = await import("../lib/platform/n8n-channel-service.ts");
  const repo = new MemoryChannelRepository();
  const claimed = new Set();
  let replies = 0, modelCalls = 0;
  const options = {
    autoReply: true,
    send: async () => { replies++; return {sent:true}; },
    doubtBot: { agent:true, handedOff:true, answer: async () => { modelCalls++; return {kind:"none"}; } },
    holdActionInbound: async input => {
      if (claimed.has(input.idempotencyKey)) return false;
      claimed.add(input.idempotencyKey);
      await repo.saveMessages(CHANNEL_NAME,input.externalConversationId,[{role:"customer",content:input.text}]);
      return true;
    },
  };
  const input = {externalConversationId:"synthetic-thread",text:"Boa noite",idempotencyKey:"synthetic-event",correlationId:"synthetic-corr"};
  const results = await Promise.all([1,2].map(() => processChannelMessage(repo,input,undefined,options)));
  assert.deepEqual(results.map(result => result.status),["human_queue_held","human_queue_held"]);
  assert.equal((await repo.getHistory(CHANNEL_NAME,input.externalConversationId)).length,1);
  assert.equal(replies,0);
  assert.equal(modelCalls,0);
});
