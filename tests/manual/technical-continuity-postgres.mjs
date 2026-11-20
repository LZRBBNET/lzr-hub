// This module receives only the fresh, socket-local synthetic cluster in handoff-postgres.mjs.
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { DbReplyRepository } from "../../lib/platform/attendant-reply-service.ts";
import { DbConversationDelivery } from "../../lib/platform/conversation-delivery-service.ts";
import { DbConversationStateRepository, changeConversationState } from "../../lib/platform/conversation-state-service.ts";
import { currentTicketGates } from "../../lib/platform/current-support-tone.ts";
import { DbDeliveryRepository, applyStatuses } from "../../lib/platform/delivery-status-service.ts";
import { askDoubtBot } from "../../lib/platform/doubt-bot-service.ts";
import { metaAutoReplySender } from "../../lib/platform/meta-auto-reply-service.ts";
import { CHANNEL_NAME, D1ChannelRepository, processChannelMessage } from "../../lib/platform/n8n-channel-service.ts";
import { claimTechnicalFollowup, reserveTechnicalInbound } from "../../lib/platform/technical-inbound-repository.ts";

const channel = CHANNEL_NAME;
const pgQuestion = "O problema acontece em outro aparelho?";
const pgFollowup = "Alguma luz do roteador está vermelha?";
const syntheticHook = "https://technical-continuity.example.invalid/webhook/synthetic";
const syntheticSecret = "synthetic-test-only-secret-not-a-credential";
const actor = { id: "synthetic-continuity-operator", email: "synthetic-operator@example.invalid", name: "Synthetic operator", role: "Atendente" };
const connectionId = index => `5500000005${String(index).padStart(3, "0")}`;
const turn = (name, index, text = "Estou sem internet") => ({ text, idempotencyKey: `wamid.continuity-${name}`,
  externalConversationId: connectionId(index), correlationId: `synthetic-continuity-${name}` });

export async function runTechnicalContinuityQA(admin, runtime, record) {
  const db = drizzle(runtime), realRepo = new D1ChannelRepository(db);
  const states = new DbConversationStateRepository(db);
  const claims = new DbReplyRepository(db), delivery = new DbConversationDelivery(db);
  const receipts = new DbDeliveryRepository(drizzle(admin));
  const modelRequests = [], providerRequests = [];
  const now = () => new Date().toISOString();
  const sharedOptions = (input, { sentAt = now(), beforeModelReturn, unsafeAction, answerText, replyToMessageId, gates } = {}) => ({
    channel, eligible: true, privateFlowPending: false, humanHandoff: false, ...gates,
    reserveInbound: value => reserveTechnicalInbound(db, channel, value),
    continuation: { sentAt, replyToMessageId, claimAnchor: anchor => claimTechnicalFollowup(db, channel, input.externalConversationId, anchor) },
    answer: async req => askDoubtBot({
      url: syntheticHook, secret: syntheticSecret, fetcher: async (url, init) => {
        const payload = JSON.parse(init.body);
        modelRequests.push({ url, method: init.method, auth: init.headers.Authorization, payload, key: input.idempotencyKey });
        await beforeModelReturn?.();
        return Response.json({ answer: answerText ?? (payload.question.startsWith("Cliente relata") ? pgFollowup : pgQuestion),
          state: "ongoing", ...(unsafeAction ? { action: "trust_unlock" } : {}) });
      },
    }, req, []),
    sender: metaAutoReplySender({
      claims, delivery, channel, customerMessageAt: sentAt,
      config: { accessToken: "synthetic-fake-meta", phoneNumberId: "synthetic-only", graphVersion: "v26.0", fetcher: async (url, init) => {
        const messageId = `wamid.synthetic-accepted-${providerRequests.length + 1}`;
        providerRequests.push({ url, body: JSON.parse(init.body), messageId });
        return Response.json({ messages: [{ id: messageId }] });
      } },
    }),
  });
  const run = async (input, opts, repository = realRepo) => {
    const result = await processChannelMessage(repository, input, undefined, {
      autoReply: false, technicalEmergency: sharedOptions(input, opts),
    });
    if (result.externalMessageId && !opts?.skipReceipt) {
      // Fake the webhook delivery receipt through the real status writer after
      // projecting the accepted send. The privileged fixture stays isolated.
      await applyStatuses(receipts, [{ messageId: result.externalMessageId, status: "delivered", at: now() }]);
    }
    return result;
  };
  const anchoredCount = async id => Number((await admin.query(
    "select count(*) from channel_idempotency_keys where channel = $1 and external_conversation_id = $2 and idempotency_key like 'technical-followup:%'",
    [channel,id],
  )).rows[0].count);
  const auditOutcomes = async keys => (await admin.query(
    "select result from audit_events where action = 'whatsapp.technical_safety' and correlation_id = any($1)",
    [keys],
  )).rows.map(row => row.result);
  const initial = turn("real-race-init", 1);
  const first = await run(initial);
  assert.equal(first.response, pgQuestion);
  assert.equal(first.technicalQuestionStage, "initial");
  assert.equal((await realRepo.findIdempotent(initial.idempotencyKey)).externalMessageId, first.externalMessageId);

  // Ensure both requests see the same snapshot before either enters actual Postgres reservation.
  let staged = 0;
  let releaseRead;
  const ready = new Promise(resolve => { releaseRead = resolve; });
  class SimultaneousHistory extends D1ChannelRepository {
    async getHistory(name, id) {
      const snapshot = await super.getHistory(name, id);
      if (++staged === 2) releaseRead();
      await ready;
      return snapshot;
    }
  }
  const repository = new SimultaneousHistory(db);
  const left = turn("real-distinct-left", 1, "Sim");
  const right = turn("real-distinct-right", 1, "Nos dois aparelhos");
  const results = await Promise.all([run(left, {}, repository), run(right, {}, repository)]);
  assert.equal(staged, 2);
  assert.deepEqual(results.map(res => res.status).sort(), ["replied", "waiting_manual_review"]);
  assert.equal(results.find(res => res.technicalQuestionStage === "followup")?.response, pgFollowup);
  assert.equal(await anchoredCount(initial.externalConversationId), 1);
  assert.equal(providerRequests.length, 2);
  assert.equal(modelRequests.length, 2);
  assert.deepEqual(providerRequests.map(entry => entry.body.text.body), [pgQuestion, pgFollowup]);
  assert.equal(providerRequests[1].body.to, initial.externalConversationId);
  assert.equal(new URL(providerRequests[1].url).hostname, "graph.facebook.com");
  let rows = await realRepo.getHistory(channel, initial.externalConversationId);
  assert.equal(rows.filter(row => row.role === "customer").length, 3);
  assert.equal(rows.filter(row => row.role === "agent").length, 2);
  assert.ok(rows.some(row => row.externalMessageId === left.idempotencyKey));
  assert.ok(rows.some(row => row.externalMessageId === right.idempotencyKey));
  const outcomes = await auditOutcomes([left.correlationId, right.correlationId]);
  assert.ok(outcomes.includes("guard_technical_followup_anchor_unavailable"));
  assert.equal((await run(left)).status, results[0].status);
  assert.equal((await run(right)).status, results[1].status);
  assert.equal((await run(turn("no-third", 1, "A luz está vermelha"))).response, null);
  assert.equal(providerRequests.length, 2);
  assert.equal(modelRequests.length, 2);
  record("technical_continuity_postgres_anchor_concurrent", { sharedSnapshotReaders: staged, distinctIncomingRows: 2, anchorClaims: 1, continuationModelMocks: 1, continuationMetaMocks: 1, replayAdditionalSends: 0, realMessages: 0 });

  for (const [{ url, method, auth, payload }, expected] of [
    [modelRequests[0], "Estou sem internet"],
    [modelRequests[1], "Cliente relata que o problema acontece em mais de um aparelho."],
  ]) {
    assert.equal(url, syntheticHook);
    assert.equal(method, "POST");
    assert.equal(auth, `Bearer ${syntheticSecret}`);
    assert.deepEqual(Object.keys(payload).sort(), ["facts", "history", "intent", "mode", "question", "sources", "task"]);
    assert.equal(payload.question, expected);
    assert.equal(payload.mode, "agent");
    assert.deepEqual([payload.history, payload.facts, payload.sources], [[], [], []]);
    assert.equal(payload.intent, "technical_no_connection");
  }
  assert.match(modelRequests[1].payload.task, /Pergunte apenas se alguma luz do roteador está vermelha/);
  record("technical_continuity_n8n_wire_contract", { logicalRequests: 2, usesActualClientWithInjectedFetch: true, currentNormalizedReportOnly: true, contactsHistorySourcesAndFactsExcluded: true, realModelCalls: 0 });

  const unverifiedInitial = turn("unverified-init", 2);
  await run(unverifiedInitial);
  // Mere transcript content, even with IDs present, is insufficient without ledger provenance.
  await admin.query("update channel_idempotency_keys set response_json = response_json - 'technicalQuestionStage' where idempotency_key = $1", [unverifiedInitial.idempotencyKey]);
  const missed = turn("unverified-followup", 2, "Sim");
  let accepts = providerRequests.length, models = modelRequests.length;
  assert.equal((await run(missed)).response, null);
  assert.equal(providerRequests.length, accepts);
  assert.equal(modelRequests.length, models);
  assert.equal(await anchoredCount(unverifiedInitial.externalConversationId), 0);
  rows = await realRepo.getHistory(channel, unverifiedInitial.externalConversationId);
  assert.ok(rows.some(row => row.externalMessageId === missed.idempotencyKey));

  const staleInitial = turn("current-start", 3);
  await run(staleInitial);
  accepts = providerRequests.length; models = modelRequests.length;
  assert.equal((await run(turn("timestamp-old", 3, "Só no celular"), { sentAt: new Date(Date.now() - 30_000).toISOString() })).response, null);
  assert.equal(providerRequests.length, accepts);
  assert.equal(modelRequests.length, models);
  assert.equal(await anchoredCount(staleInitial.externalConversationId), 0);
  record("technical_continuity_postgres_provenance_timing", { unprovenLedgerHeldWithoutModel: true, predatingProviderTimestampHeld: true, inboundPreserved: true, zeroAnchorForBoth: true });

  const ownerInitial = turn("owner-init", 4);
  await run(ownerInitial);
  const ownerTurn = turn("owner-took-during-model", 4, "Só no celular");
  accepts = providerRequests.length; models = modelRequests.length;
  const blocked = await run(ownerTurn, { beforeModelReturn: async () => {
    const result = await changeConversationState(states, { channel, conversationId: ownerTurn.externalConversationId, action: "claim", actor });
    assert.equal(result.ok, true);
  } });
  assert.equal(blocked.response, null);
  assert.equal(modelRequests.length, models + 1);
  assert.equal(providerRequests.length, accepts);
  assert.equal(await anchoredCount(ownerTurn.externalConversationId), 1);
  assert.equal((await states.get(channel, ownerTurn.externalConversationId))?.assigneeId, actor.id);
  assert.equal((await run(ownerTurn)).response, null);
  assert.equal(modelRequests.length, models + 1);
  assert.equal(providerRequests.length, accepts);

  const actionInitial = turn("action-init", 5);
  await run(actionInitial);
  accepts = providerRequests.length; models = modelRequests.length;
  assert.equal((await run(turn("action-block", 5, "Sim"), { unsafeAction: true })).response, null);
  assert.equal(modelRequests.length, models + 1);
  assert.equal(providerRequests.length, accepts);
  assert.equal(await anchoredCount(actionInitial.externalConversationId), 1);
  record("technical_continuity_postgres_dispatch_safety", { newHumanOwnerRetained: true, metaCallsAfterHumanClaim: 0, modelActionBlocked: true, realMessages: 0 });

  const greetingInitial = turn("greeting-precedent-init", 6);
  await run(greetingInitial);
  const greetingText = "Boa tarde! Como posso ajudar?";
  const greeting = await run(turn("greeting-over-technical", 6, "Boa tarde"), { answerText: greetingText });
  assert.equal(greeting.response, greetingText);
  assert.equal(greeting.technicalQuestionStage, undefined);
  assert.equal(modelRequests.at(-1).payload.question, "Boa tarde");
  assert.deepEqual(modelRequests.at(-1).payload.history, []);

  const exactReport = "Boa tarde, estou sem internet";
  const greetedQuestion = `Boa tarde! ${pgQuestion}`;
  const requested = await run(turn("explicit-greeting-known-need", 6, exactReport), { answerText: greetedQuestion });
  assert.equal(requested.response, greetedQuestion);
  assert.match(modelRequests.at(-1).payload.task, /já descreveu a necessidade/);
  assert.equal(modelRequests.at(-1).payload.question, exactReport);
  assert.deepEqual(modelRequests.at(-1).payload.history, []);

  const angryText = "Que merda, estou sem internet de novo";
  const empathetic = `Sinto muito pelo transtorno. ${pgQuestion}`;
  const angry = await run(turn("new-rude-current-complaint", 6, angryText), { answerText: empathetic });
  assert.equal(angry.response, empathetic);
  assert.equal(angry.technicalQuestionStage, "initial");
  const currentOnly = modelRequests.at(-1).payload;
  assert.equal(currentOnly.question, "Cliente relata que está sem internet.");
  assert.deepEqual([currentOnly.history, currentOnly.facts, currentOnly.sources], [[], [], []]);
  assert.doesNotMatch(JSON.stringify(currentOnly), /merda|O\.S\.|óptico/);
  assert.match(currentOnly.task, /está frustrada/);
  assert.equal(providerRequests.at(-1).body.text.body, empathetic);

  accepts = providerRequests.length; models = modelRequests.length;
  const risky = turn("threat-guard", 6, "Estou sem internet, vou te matar");
  assert.equal((await run(risky)).response, null);
  assert.equal(modelRequests.length, models);
  assert.equal(providerRequests.length, accepts);
  assert.ok((await realRepo.getHistory(channel, risky.externalConversationId)).some(row => row.externalMessageId === risky.idempotencyKey));
  record("technical_current_turn_postgres_greeting_empathy", { greetingOverridesTechnicalAnchor: true, greetingWithNeedSkipsGenericQuestion: true, rudeCurrentReportNormalized: true, threatPreservedWithoutCalls: true, realMessages: 0 });

  const oldDate = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  const staleGates = currentTicketGates({ status: "open", stage: "handoff", intent: "financial_invoice",
    lastCustomerAt: oldDate, selfService: { step: "awaiting_cpf", at: oldDate, attempts: 0 } });
  const greetingAfterStale = await run(turn("greeting-after-stale", 7, "Boa tarde"), { gates: staleGates, answerText: greetingText });
  assert.equal(greetingAfterStale.response, greetingText);
  const needAfterStale = await run(turn("need-after-stale", 7, exactReport), { gates: staleGates, answerText: greetedQuestion });
  assert.equal(needAfterStale.response, greetedQuestion);
  assert.deepEqual(modelRequests.at(-1).payload.history, []);
  assert.equal(needAfterStale.technicalQuestionStage, "initial");
  const currentGates = currentTicketGates({ status: "open", stage: "routed", intent: "financial_invoice",
    lastCustomerAt: "invalid", selfService: { step: "awaiting_cpf", at: "invalid", attempts: 0 } });
  accepts = providerRequests.length; models = modelRequests.length;
  assert.equal((await run(turn("private-active-invalid-time", 8, "Boa tarde"), { gates: currentGates, answerText: greetingText })).response, null);
  assert.equal(providerRequests.length, accepts);
  assert.equal(modelRequests.length, models);
  record("technical_current_turn_postgres_stale_ticket", { staleHandoffAndPrivateStepIgnored: true, recentExplicitGreetingAndNeedCurrent: true, uncertainActivePrivateStepHeld: true, realMessages: 0 });

  const unconfirmed = await run(turn("accepted-without-receipt", 9), { skipReceipt: true });
  assert.ok(unconfirmed.externalMessageId);
  assert.equal((await realRepo.getHistory(channel, connectionId(9))).at(-1).deliveryStatus, undefined);
  accepts = providerRequests.length; models = modelRequests.length;
  assert.equal((await run(turn("unquoted-not-delivered", 9, "Sim"))).response, null);
  assert.equal(providerRequests.length, accepts);
  assert.equal(modelRequests.length, models);

  const quoted = await run(turn("accepted-quote-start", 10), { skipReceipt: true });
  accepts = providerRequests.length; models = modelRequests.length;
  const quoteRows = await realRepo.getHistory(channel, connectionId(10));
  const second = Math.floor(Date.parse(quoteRows.at(-1).createdAt) / 1_000) * 1_000;
  const exact = await run(turn("quoted-same-second", 10, "Sim"), { sentAt: new Date(second).toISOString(), replyToMessageId: quoted.externalMessageId });
  assert.equal(exact.response, pgFollowup);
  assert.equal(exact.technicalQuestionStage, "followup");
  assert.equal(modelRequests.length, models + 1);
  assert.equal(providerRequests.length, accepts + 1);
  record("technical_continuity_postgres_delivery_or_quote", { recordedDeliveryRequiredForUnquoted: true, exactQuoteAllowedWithinSameSecond: true, missingDeliveryHeldWithoutCalls: true, realMessages: 0 });
}

export async function assertTechnicalContinuityAfterRestart(runtime, record) {
  const db = drizzle(runtime), repository = new D1ChannelRepository(db);
  const priorInputs = [turn("real-distinct-left", 1), turn("real-distinct-right", 1)];
  const replies = await Promise.all(priorInputs.map(input => repository.findIdempotent(input.idempotencyKey)));
  assert.equal(replies.filter(reply => reply?.technicalQuestionStage === "followup").length, 1);
  const resume = turn("restart-extra-inbound", 1, "Sim");
  let newActions = 0;
  const resumed = await processChannelMessage(repository, resume, undefined, {
    autoReply: false,
    technicalEmergency: {
      channel, eligible: true, privateFlowPending: false, humanHandoff: false,
      reserveInbound: input => reserveTechnicalInbound(db, channel, input),
      continuation: {
        sentAt: new Date().toISOString(),
        claimAnchor: async () => { newActions++; return false; },
      },
      answer: async () => { newActions++; return { kind: "none" }; },
      sender: async () => { newActions++; return { sent: false, outcome: "blocked" }; },
    },
  });
  assert.equal(newActions, 0);
  assert.equal(resumed.status, "waiting_manual_review");
  assert.equal(resumed.response, null);
  const history = await repository.getHistory(channel, resume.externalConversationId);
  assert.ok(history.some(row => row.externalMessageId === resume.idempotencyKey));
  record("technical_continuity_postgres_restart", { priorFollowupPersisted: true, additionalInboundHeld: true, addedSends: 0 });
}
