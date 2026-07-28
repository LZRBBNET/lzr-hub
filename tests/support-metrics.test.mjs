import assert from "node:assert/strict";
import test from "node:test";
import {
  CSAT_QUESTION,
  CSAT_THANKS,
  MemorySupportMetricsRepository,
  getSupportMetrics,
  isAwaitingCsat,
  parseCsatScore,
  shouldAskCsat,
} from "../lib/platform/support-metrics.ts";
import { MemoryChannelRepository, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";

const PAST = "2000-01-01T00:00:00.000Z";

test("nota de CSAT é lida só quando está entre 1 e 5", () => {
  assert.equal(parseCsatScore("4"), 4);
  assert.equal(parseCsatScore("nota 5"), 5);
  assert.equal(parseCsatScore("3/5"), 3);
  assert.equal(parseCsatScore("0"), null);
  assert.equal(parseCsatScore("9"), null);
  assert.equal(parseCsatScore("minha internet caiu"), null);
});

test("avaliação só é pedida quando a IA resolveu sozinha", () => {
  assert.equal(shouldAskCsat("resolved", false), true);
  assert.equal(shouldAskCsat("resolved", true), false, "transbordo não é avaliado pela IA");
  assert.equal(shouldAskCsat("handoff", false), false);
  assert.equal(shouldAskCsat("failed", false), false);
});

test("só interpreta número como nota logo após a pergunta de avaliação", () => {
  assert.equal(isAwaitingCsat(`Tudo certo.\n\n${CSAT_QUESTION}`), true);
  assert.equal(isAwaitingCsat("Seu boleto foi enviado."), false);
  assert.equal(isAwaitingCsat(undefined), false);
});

test("métricas agregam resolução, transbordo e CSAT", async () => {
  const repository = new MemorySupportMetricsRepository();
  const outcome = (finalStatus, handoff, handoffReason = null) => ({
    channel: "n8n-whatsapp", externalConversationId: `c-${Math.random()}`,
    intent: "financial_invoice", finalStatus, handoff, handoffReason, correlationId: "corr",
  });
  await repository.saveOutcome(outcome("resolved", false));
  await repository.saveOutcome(outcome("resolved", false));
  await repository.saveOutcome(outcome("handoff", true, "customer_requested_human"));
  await repository.saveOutcome(outcome("handoff", true, "customer_irritated"));
  await repository.saveRating({ channel: "n8n-whatsapp", externalConversationId: "c1", score: 5 });
  await repository.saveRating({ channel: "n8n-whatsapp", externalConversationId: "c2", score: 4 });

  const metrics = await getSupportMetrics(repository, PAST);
  assert.equal(metrics.conversations, 4);
  assert.equal(metrics.resolvedWithoutHuman, 2);
  assert.equal(metrics.resolutionRate, 0.5);
  assert.equal(metrics.handoffs, 2);
  assert.deepEqual(metrics.handoffReasons, { customer_requested_human: 1, customer_irritated: 1 });
  assert.equal(metrics.csatAverage, 4.5);
  assert.equal(metrics.csatCount, 2);
  assert.equal(metrics.costPerConversation, null, "custo depende do Langfuse e nunca é inventado");
});

test("métricas sem dados não inventam número", async () => {
  const metrics = await getSupportMetrics(new MemorySupportMetricsRepository(), PAST);
  assert.equal(metrics.conversations, 0);
  assert.equal(metrics.resolutionRate, null);
  assert.equal(metrics.csatAverage, null);
});

test("a mesma conversa não é avaliada duas vezes", async () => {
  const repository = new MemorySupportMetricsRepository();
  await repository.saveRating({ channel: "n8n-whatsapp", externalConversationId: "c1", score: 5 });
  await repository.saveRating({ channel: "n8n-whatsapp", externalConversationId: "c1", score: 1 });
  const metrics = await getSupportMetrics(repository, PAST);
  assert.equal(metrics.csatCount, 1);
  assert.equal(metrics.csatAverage, 5);
});

test("canal registra desfecho e coleta a nota do cliente", async () => {
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  const conversation = "5579999990000";

  const first = await processChannelMessage(channel, {
    externalConversationId: conversation, text: "quero a segunda via do boleto",
    idempotencyKey: "k1", correlationId: "corr-1",
  }, metrics);

  assert.equal(first.handoff, false);
  assert.equal(first.status, "simulated");
  assert.equal(metrics.outcomes.length, 1, "desfecho da conversa foi registrado");
  assert.ok(first.response.includes(CSAT_QUESTION), "pergunta de avaliação foi anexada");

  const rated = await processChannelMessage(channel, {
    externalConversationId: conversation, text: "5",
    idempotencyKey: "k2", correlationId: "corr-2",
  }, metrics);

  assert.equal(rated.response, CSAT_THANKS);
  assert.equal(rated.status, "rated");
  assert.equal(metrics.ratings.length, 1);
  assert.equal(metrics.ratings[0].score, 5);
  assert.equal(metrics.outcomes.length, 1, "a resposta de nota não vira uma nova conversa");
});

test("transbordo não pede avaliação ao cliente", async () => {
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  const result = await processChannelMessage(channel, {
    externalConversationId: "5579999990002", text: "quero falar com atendente",
    idempotencyKey: "k1", correlationId: "corr-1",
  }, metrics);

  assert.equal(result.handoff, true);
  assert.ok(!result.response.includes(CSAT_QUESTION));
  assert.equal(metrics.outcomes[0].handoff, true);
  assert.equal(metrics.outcomes[0].handoffReason, "customer_requested_human");
});

test("conversa ainda em andamento não pede avaliação", async () => {
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  const result = await processChannelMessage(channel, {
    externalConversationId: "5579999990003", text: "minha internet está lenta",
    idempotencyKey: "k1", correlationId: "corr-1",
  }, metrics);

  assert.equal(result.status, "waiting_customer");
  assert.ok(!result.response.includes(CSAT_QUESTION), "não pede nota no meio do atendimento");
});

test("número solto fora do contexto de avaliação continua indo para a IA", async () => {
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  const result = await processChannelMessage(channel, {
    externalConversationId: "5579999990001", text: "5",
    idempotencyKey: "k1", correlationId: "corr-1",
  }, metrics);
  assert.notEqual(result.status, "rated");
  assert.equal(metrics.ratings.length, 0);
  assert.equal(metrics.outcomes.length, 1);
});
