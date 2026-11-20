// Imported by the disposable-only harness in handoff-postgres.mjs.
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { DbReplyRepository } from "../../lib/platform/attendant-reply-service.ts";
import { DbConversationDelivery } from "../../lib/platform/conversation-delivery-service.ts";
import { DbConversationStateRepository, changeConversationState } from "../../lib/platform/conversation-state-service.ts";
import { metaAutoReplySender } from "../../lib/platform/meta-auto-reply-service.ts";
import { D1ChannelRepository, processChannelMessage } from "../../lib/platform/n8n-channel-service.ts";
import { reserveTechnicalInbound, technicalInboundKey } from "../../lib/platform/technical-inbound-repository.ts";

export async function runTechnicalInboundQA(admin, runtime, record) {
  const channel = "synthetic-emergency";
  const db = drizzle(runtime);
  const question = "O problema acontece em outro aparelho?";
  const calls = { model: 0, send: 0 };
  const input = key => ({
    text: "Estou sem internet", externalConversationId: "synthetic-emergency-conversation",
    idempotencyKey: `wamid.synthetic-${key}`, correlationId: `synthetic-correlation-${key}`,
  });
  const run = (turn, persistence = db, eligibility = {}) => processChannelMessage(
    new D1ChannelRepository(persistence), turn, undefined, { technicalEmergency: {
      channel, eligible: true, privateFlowPending: false, humanHandoff: false,
      answer: async () => { calls.model++; return { kind: "answer", text: question, state: "ongoing", sources: [] }; },
      sender: async () => { calls.send++; return { sent: true, messageId: "wamid.synthetic-outbound" }; },
      reserveInbound: value => reserveTechnicalInbound(persistence, channel, value),
      ...eligibility,
    } },
  );
  const count = async (sql, values) => Number((await admin.query(sql, values)).rows[0].count);
  const inbound = turn => count("select count(*) from channel_messages where channel=$1 and role='customer' and external_message_id=$2", [channel, turn.idempotencyKey]);
  const claim = turn => count("select count(*) from channel_idempotency_keys where idempotency_key=$1", [technicalInboundKey(turn.idempotencyKey)]);
  const live = input("race");
  const replies = await Promise.all(Array.from({ length: 8 }, () => run(live)));
  assert.ok(replies.some(reply => reply.response === question));
  // A duplicate arriving after completion may receive the cached response; actual sends are counted independently.
  assert.deepEqual(calls, { model: 1, send: 1 });
  assert.equal(await inbound(live), 1);
  assert.equal(await claim(live), 1);
  await run(live);
  assert.deepEqual(calls, { model: 1, send: 1 });
  record("technical_inbound_postgres_concurrent", { concurrent: 8, inboundRows: 1, claims: 1, modelMocks: 1, metaMocks: 1 });

  // A trigger vetoing the audit-history insert without an SQL error must not leave a claim or permit any send.
  const suppressed = input("suppressed");
  await admin.query(`CREATE FUNCTION synthetic_suppress_technical_inbound() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.channel='synthetic-emergency' AND NEW.external_message_id='wamid.synthetic-suppressed'
    THEN RETURN NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_suppress_technical_inbound BEFORE INSERT ON channel_messages
    FOR EACH ROW EXECUTE FUNCTION synthetic_suppress_technical_inbound()`);
  try {
    await assert.rejects(() => run(suppressed), /TECHNICAL_INBOUND_UNCONFIRMED/);
    assert.equal(await inbound(suppressed), 0);
    assert.equal(await claim(suppressed), 0);
    assert.deepEqual(calls, { model: 1, send: 1 });
  } finally {
    await admin.query("DROP TRIGGER synthetic_suppress_technical_inbound ON channel_messages; DROP FUNCTION synthetic_suppress_technical_inbound()");
  }
  record("technical_inbound_postgres_rollback", { insertSuppressed: true, claimRolledBack: true, mockCallsAdded: 0 });

  const committed = input("commit-ack-lost");
  const client = await runtime.connect();
  const original = client.query;
  let fault = false;
  client.query = async (...args) => {
    const statement = typeof args[0] === "string" ? args[0] : args[0].text;
    const result = await original.apply(client, args);
    if (!fault && statement.trim().toLowerCase() === "commit") {
      fault = true;
      throw Error("SYNTHETIC_LOST_COMMIT_ACK");
    }
    return result;
  };
  try {
    await assert.rejects(() => run(committed, drizzle(client)), error =>
      [error, error?.cause, error?.cause?.cause].some(item => item?.message === "SYNTHETIC_LOST_COMMIT_ACK"));
    assert.equal(fault, true);
  } finally {
    client.query = original;
    client.release(true);
  }
  assert.equal(await inbound(committed), 1);
  assert.equal(await claim(committed), 1);
  assert.equal((await run(committed)).response, null);
  assert.deepEqual(calls, { model: 1, send: 1 });
  record("technical_inbound_postgres_ambiguous_commit", { driverFaultAfterCommit: true, freshConnectionReplay: true, mockCallsAdded: 0 });

  for (const [name, settings] of [
    ["ineligible", { eligible: false }],
    ["human", { humanHandoff: true }],
    ["timeout", { answer: async () => { throw Error("SYNTHETIC_TIMEOUT"); } }],
  ]) {
    const turn = input(name);
    assert.equal((await run(turn, db, settings)).response, null);
    assert.equal(await inbound(turn), 1);
    assert.equal(await claim(turn), 1);
  }
  const legacy = input("legacy-already-stored");
  await new D1ChannelRepository(db).saveMessages(channel, legacy.externalConversationId, [{
    role: "customer", content: legacy.text, correlationId: legacy.correlationId, externalMessageId: legacy.idempotencyKey,
  }]);
  assert.equal((await run(legacy)).response, null);
  assert.equal(await inbound(legacy), 1);
  assert.deepEqual(calls, { model: 1, send: 1 });
  record("technical_inbound_postgres_fail_closed", { noProviderEligibility: true, assignedHuman: true, modelTimeout: true, legacyInbound: true, mockCallsAdded: 0 });

  // The application's actual dispatch adapter must recheck ownership after the model, not merely consume the initial snapshot.
  // Digits are synthetic and only used with the injected fetcher; this does not contact the provider.
  const inFlight = { ...input("owner-changes"), externalConversationId: "5500000000001" };
  const states = new DbConversationStateRepository(db);
  const claims = new DbReplyRepository(db);
  const delivery = new DbConversationDelivery(db);
  let providerCalls = 0;
  const send = (fetcher) => metaAutoReplySender({
    claims, delivery, channel, customerMessageAt: new Date().toISOString(),
    config: { accessToken: "synthetic", phoneNumberId: "synthetic", graphVersion: "v26.0", fetcher },
  });
  const held = await run(inFlight, db, {
    answer: async () => {
      const result = await changeConversationState(states, { channel, conversationId: inFlight.externalConversationId,
        action: "claim", actor: { id: "synthetic-owner", name: "Synthetic owner", email: "synthetic-owner@example.invalid", role: "Atendente" } });
      assert.equal(result.ok, true);
      return { kind: "answer", state: "ongoing", text: question };
    },
    sender: send(async () => { providerCalls++; return Response.json({ messages: [{ id: "wamid.synthetic-unexpected" }] }); }),
  });
  assert.equal((await states.get(channel, inFlight.externalConversationId))?.assigneeId, "synthetic-owner");
  assert.equal(held.response, null);
  assert.equal(providerCalls, 0);
  const timeout = { ...input("dispatch-timeout"), externalConversationId: "5500000000002" };
  const timeoutOptions = { sender: send(async () => {
    providerCalls++;
    throw new DOMException("Synthetic timeout", "AbortError");
  }) };
  assert.equal((await run(timeout, db, timeoutOptions)).response, null);
  assert.equal((await run(timeout, db, timeoutOptions)).response, null);
  assert.equal(providerCalls, 1);
  assert.equal((await claims.claimState(`autoreply:${timeout.idempotencyKey}`))?.status, "unknown");
  record("technical_inbound_postgres_real_dispatch_mock_transport", {
    lateHumanClaimRetained: true, blockedHumanTransportCalls: 0, ambiguousTimeoutTransportCalls: 1, realMessages: 0,
  });
}

export async function assertTechnicalReplayAfterRestart(runtime, record) {
  const db = drizzle(runtime);
  const channel = "synthetic-emergency";
  const idempotencyKey = "wamid.synthetic-commit-ack-lost";
  const input = {
    externalConversationId: "synthetic-emergency-conversation", text: "Estou sem internet",
    idempotencyKey, correlationId: "synthetic-correlation-replayed-after-restart",
  };
  let modelCalls = 0, sends = 0;
  const pending = await processChannelMessage(new D1ChannelRepository(db), input, undefined, {
    technicalEmergency: {
      channel, eligible: true, privateFlowPending: false, humanHandoff: false,
      answer: async () => { modelCalls++; return { kind: "answer", state: "ongoing", text: "O problema acontece em outro aparelho?" }; },
      sender: async () => { sends++; return { sent: true, messageId: "wamid.synthetic-must-not-send" }; },
      reserveInbound: value => reserveTechnicalInbound(db, channel, value),
    },
  });
  assert.equal(modelCalls, 0);
  assert.equal(sends, 0);
  assert.equal(pending.status, "waiting_manual_review");
  assert.equal(pending.response, null);
  record("technical_inbound_postgres_restart", { databaseRestarted: true, ambiguousCommitNotReplayed: true, realMessages: 0 });
}
