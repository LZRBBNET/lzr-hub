import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { BillingReminderBlockedError } from "../src/billing-reminders.mjs";
import { createProcessor } from "../src/processor.mjs";

const NOW = "2026-11-05T15:00:00.000Z";
function job() {
  return {
    queueName: "billing-reminders", name: "collection-step:step-fictional", attemptsMade: 0,
    data: {
      correlationId: "fictional-correlation", idempotencyKey: "invoice-fictional:step-fictional:2026-11-05",
      payload: {
        schemaVersion: 1, invoiceId: "invoice-fictional", customerId: "customer-fictional",
        ruleId: "rule-fictional", ruleVersion: 1, stepId: "step-fictional",
        scheduledFor: "2026-11-05", channel: "WhatsApp", templateId: "template-fictional",
      },
    },
  };
}
function evidence(input = job()) {
  const context = { ...input.data.payload };
  delete context.schemaVersion;
  return {
    complete: true, observedAt: NOW,
    invoice: { id: context.invoiceId, customerId: context.customerId, status: "A", dueAt: "2026-11-05", value: 50, valueSource: "open-balance" },
    intent: { ...context, idempotencyKey: input.data.idempotencyKey, offsetDays: 0, current: true, active: true, cancelled: false },
  };
}
function harness(overrides = {}) {
  const continuations = [];
  const processor = createProcessor("billing-reminders", {
    readEvidence: async () => evidence(), now: () => new Date(NOW),
    continueEligible: async (context) => { continuations.push(context); return { simulated: true, delivered: false }; },
    ...overrides,
  });
  return { processor, continuations };
}
async function blocked(input, expected, options) {
  const { processor, continuations } = harness(options);
  await assert.rejects(processor(input), (error) => error instanceof BillingReminderBlockedError && error.code === expected);
  assert.equal(continuations.length, 0, "no continuation may run before the guard accepts fresh evidence");
}

test("billing is wired into the real worker with no source or continuation configured", async () => {
  const worker = await readFile(new URL("../src/worker.mjs", import.meta.url), "utf8");
  assert.match(worker, /const processor = createProcessor\(name\);/);
  assert.match(worker, /new Worker\(name, processor,/);
  await blocked(job(), "BILLING_EVIDENCE_SOURCE_UNAVAILABLE", { readEvidence: undefined });
  // Calling the exact default factory also cannot fabricate a completion,
  // irrespective of wall-clock date or the business-hour window.
  await assert.rejects(createProcessor("billing-reminders")(job()), BillingReminderBlockedError);
});

test("fresh exact open evidence reaches only the injected fake continuation", async () => {
  const order = [];
  const input = job();
  const processor = createProcessor("billing-reminders", {
    now: () => new Date(NOW),
    readEvidence: async (context, options) => {
      order.push("read");
      assert.equal(options.requestedAt, NOW);
      assert.equal(options.signal.aborted, false);
      assert.equal(context.invoiceId, input.data.payload.invoiceId);
      assert.equal(Object.isFrozen(context), true);
      return evidence();
    },
    continueEligible: async (context) => {
      order.push("fake-only");
      assert.equal(context.idempotencyKey, input.data.idempotencyKey);
      assert.equal("status" in context, false);
      return { simulated: true, delivered: false };
    },
  });
  assert.deepEqual(await processor(input), { simulated: true, delivered: false });
  assert.deepEqual(order, ["read", "fake-only"]);
});

for (const [name, mutate, code = "BILLING_JOB_INVALID"] of [
  ["legacy payload", (j) => { delete j.data.payload.schemaVersion; }],
  ["missing rule", (j) => { delete j.data.payload.ruleId; }],
  ["missing date", (j) => { delete j.data.payload.scheduledFor; }],
  ["invalid date", (j) => { j.data.payload.scheduledFor = "2026-02-30"; }],
  ["unknown schema", (j) => { j.data.payload.schemaVersion = 2; }],
  ["invalid version", (j) => { j.data.payload.ruleVersion = "1"; }],
  ["missing customer", (j) => { j.data.payload.customerId = ""; }],
  ["wrong channel", (j) => { j.data.payload.channel = "unknown"; }],
  ["missing template", (j) => { j.data.payload.templateId = " "; }],
  ["payload array", (j) => { j.data.payload = []; }],
  ["idempotency mismatch", (j) => { j.data.idempotencyKey = "old-job"; }, "BILLING_JOB_CONTEXT_MISMATCH"],
  ["step name mismatch", (j) => { j.name = "collection-step:other"; }, "BILLING_JOB_CONTEXT_MISMATCH"],
  ["cancelled job", (j) => { j.data.cancelled = true; }, "BILLING_JOB_CANCELLED"],
  ["malformed cancellation", (j) => { j.data.cancelled = "false"; }, "BILLING_JOB_CANCELLED"],
  ["forged queue", (j) => { j.queueName = "message-outbound"; }],
  ["missing queue", (j) => { delete j.queueName; }],
]) {
  test(`rejects ${name} without reading a source or calling a continuation`, async () => {
    const input = job(); mutate(input);
    let reads = 0;
    await blocked(input, code, { readEvidence: async () => { reads += 1; return evidence(); } });
    assert.equal(reads, 0);
  });
}

for (const value of [null, undefined, [], {}, { complete: false }, { complete: true }]) {
  test(`missing/partial evidence is not sufficient: ${JSON.stringify(value)}`, async () => {
    await blocked(job(), "BILLING_EVIDENCE_INCOMPLETE", { readEvidence: async () => value });
  });
}

for (const status of ["P", "R", "pago", "recebido", "cancelado", "C", "", "unknown", null, undefined, 1]) {
  test(`non-open invoice status ${JSON.stringify(status)} never reaches a continuation`, async () => {
    const value = evidence(); value.invoice.status = status;
    await blocked(job(), "BILLING_INVOICE_NOT_OPEN", { readEvidence: async () => value });
  });
}
for (const status of ["A", "aberta", "Aberto", " em aberto "]) {
  test(`accepts positively open status ${JSON.stringify(status)} with all other evidence`, async () => {
    const value = evidence(); value.invoice.status = status;
    const { processor, continuations } = harness({ readEvidence: async () => value });
    assert.deepEqual(await processor(job()), { simulated: true, delivered: false });
    assert.equal(continuations.length, 1);
  });
}

for (const [name, mutate, code] of [
  ["wrong invoice", (e) => { e.invoice.id = "other"; }, "BILLING_INVOICE_IDENTITY_MISMATCH"],
  ["wrong owner", (e) => { e.invoice.customerId = "other"; }, "BILLING_INVOICE_IDENTITY_MISMATCH"],
  ["wrong intent customer", (e) => { e.intent.customerId = "other"; }, "BILLING_INTENT_MISMATCH"],
  ["superseded rule", (e) => { e.intent.ruleId = "new-rule"; }, "BILLING_INTENT_MISMATCH"],
  ["superseded version", (e) => { e.intent.ruleVersion = 2; }, "BILLING_INTENT_MISMATCH"],
  ["different step", (e) => { e.intent.stepId = "other"; }, "BILLING_INTENT_MISMATCH"],
  ["changed template", (e) => { e.intent.templateId = "other"; }, "BILLING_INTENT_MISMATCH"],
  ["changed channel", (e) => { e.intent.channel = "SMS"; }, "BILLING_INTENT_MISMATCH"],
  ["different day", (e) => { e.intent.scheduledFor = "2026-11-06"; }, "BILLING_INTENT_MISMATCH"],
  ["missing intent binding", (e) => { delete e.intent.idempotencyKey; }, "BILLING_INTENT_MISMATCH"],
  ["cancelled authoritative intent", (e) => { e.intent.cancelled = true; }, "BILLING_INTENT_INACTIVE"],
  ["unknown cancellation", (e) => { delete e.intent.cancelled; }, "BILLING_INTENT_INACTIVE"],
  ["disabled step", (e) => { e.intent.active = false; }, "BILLING_INTENT_INACTIVE"],
  ["obsolete intent", (e) => { e.intent.current = false; }, "BILLING_INTENT_INACTIVE"],
  ["unknown current state", (e) => { delete e.intent.current; }, "BILLING_INTENT_INACTIVE"],
  ["missing due date", (e) => { delete e.invoice.dueAt; }, "BILLING_EVIDENCE_INCOMPLETE"],
  ["impossible due date", (e) => { e.invoice.dueAt = "2026-02-30"; }, "BILLING_EVIDENCE_INCOMPLETE"],
  ["unknown offset", (e) => { delete e.intent.offsetDays; }, "BILLING_EVIDENCE_INCOMPLETE"],
  ["offset outside range", (e) => { e.intent.offsetDays = 181; }, "BILLING_EVIDENCE_INCOMPLETE"],
  ["changed due date", (e) => { e.invoice.dueAt = "2026-11-06"; }, "BILLING_JOB_OBSOLETE"],
  ["changed offset", (e) => { e.intent.offsetDays = 1; }, "BILLING_JOB_OBSOLETE"],
]) {
  test(`rejects ${name}`, async () => {
    const value = evidence(); mutate(value);
    await blocked(job(), code, { readEvidence: async () => value });
  });
}

for (const observedAt of ["2026-11-05T14:59:59.999Z", "2026-11-05T15:00:00.001Z", "2026-02-30T15:00:00.000Z", NOW.slice(0, 10), null, undefined]) {
  test(`rejects cached/future/malformed observation ${JSON.stringify(observedAt)}`, async () => {
    const value = evidence(); value.observedAt = observedAt;
    await blocked(job(), "BILLING_EVIDENCE_STALE", { readEvidence: async () => value });
  });
}

test("freshness is measured again when the source returns", async () => {
  let reads = 0;
  await blocked(job(), "BILLING_EVIDENCE_STALE", { now: () => new Date(reads++ === 0 ? NOW : "2026-11-05T15:00:05.001Z") });
});

test("payload status and timestamps cannot override fresh paid evidence", async () => {
  const input = job();
  Object.assign(input.data.payload, { status: "A", observedAt: NOW, evidence: evidence(), complete: true, current: true, cancelled: false });
  const value = evidence(); value.invoice.status = "R";
  await blocked(input, "BILLING_INVOICE_NOT_OPEN", { readEvidence: async () => value });
});

test("source errors are sanitized and do not run the continuation", async () => {
  await blocked(job(), "BILLING_EVIDENCE_UNAVAILABLE", { readEvidence: async () => { throw new Error("fictional-private-details"); } });
});

test("a hung source is aborted and cannot later run the continuation", async () => {
  let resolveSource, signal;
  const h = harness({ readEvidence: (_, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveSource = resolve; });
  } });
  await assert.rejects(h.processor(job()), { code: "BILLING_EVIDENCE_UNAVAILABLE" });
  assert.equal(signal.aborted, true);
  resolveSource(evidence());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.continuations.length, 0);
});

test("cancellation during the read blocks the continuation", async () => {
  const input = job();
  await blocked(input, "BILLING_JOB_CANCELLED", { readEvidence: async () => { input.data.cancelled = true; return evidence(); } });
});

test("every retry re-reads evidence; a payment after a previous attempt blocks", async () => {
  let reads = 0;
  const h = harness({ readEvidence: async () => { const value = evidence(); if (reads++ > 0) value.invoice.status = "R"; return value; } });
  const input = job();
  await h.processor(input);
  input.attemptsMade += 1;
  await assert.rejects(h.processor(input), { code: "BILLING_INVOICE_NOT_OPEN" });
  assert.equal(reads, 2);
  assert.equal(h.continuations.length, 1);
});

for (const current of ["2026-11-06T15:00:00.000Z", "2026-11-05T10:59:59.000Z", "2026-11-05T23:00:00.000Z"]) {
  test(`old/future/out-of-hours jobs remain blocked at ${current}`, async () => {
    await blocked(job(), "BILLING_JOB_OBSOLETE", { now: () => new Date(current) });
  });
}

test("source returning after the business window cannot authorize a continuation", async () => {
  let calls = 0;
  const value = evidence(); value.observedAt = "2026-11-05T22:59:59.000Z";
  await blocked(job(), "BILLING_JOB_OBSOLETE", {
    now: () => new Date(calls++ === 0 ? "2026-11-05T22:59:59.000Z" : "2026-11-05T23:00:00.000Z"),
    readEvidence: async () => value,
  });
});

test("missing or invalid clock fails closed", async () => {
  await blocked(job(), "BILLING_CLOCK_INVALID", { now: () => new Date("bad-date") });
  await blocked(job(), "BILLING_CLOCK_INVALID", { now: () => NOW });
  await blocked(job(), "BILLING_CLOCK_INVALID", { now: () => { throw new Error("clock failure"); } });
});

test("valid evidence without a continuation is not successful processing", async () => {
  await blocked(job(), "BILLING_CONTINUATION_UNAVAILABLE", { continueEligible: undefined });
});

test("continuation failure or missing return cannot fabricate success", async () => {
  let failedCalls = 0;
  const failed = harness({ continueEligible: async () => { failedCalls += 1; throw new Error("fictional-provider-private-detail"); } });
  await assert.rejects(failed.processor(job()), { code: "BILLING_CONTINUATION_FAILED" });
  assert.equal(failedCalls, 1, "a failed continuation did run, so a future sender must handle uncertain effects");
  for (const result of [undefined, null, true, []]) {
    let calls = 0;
    const h = harness({ continueEligible: async () => { calls += 1; return result; } });
    await assert.rejects(h.processor(job()), { code: "BILLING_CONTINUATION_RESULT_INVALID" });
    assert.equal(calls, 1, "invalid return blocks success, but cannot undo an already attempted effect");
  }
});

for (const day of ["2026-11-07", "2026-11-08"]) {
  test(`weekend intent is blocked before consulting the source: ${day}`, async () => {
    const input = job();
    input.data.payload.scheduledFor = day;
    input.data.idempotencyKey = `invoice-fictional:step-fictional:${day}`;
    let reads = 0;
    await blocked(input, "BILLING_JOB_OBSOLETE", {
      now: () => new Date(`${day}T15:00:00.000Z`),
      readEvidence: async () => { reads += 1; return evidence(input); },
    });
    assert.equal(reads, 0);
  });
}

test("exact five-second freshness boundary is accepted but a longer total read is not", async () => {
  let ticks = 0;
  const h = harness({ now: () => new Date(ticks++ === 0 ? NOW : "2026-11-05T15:00:05.000Z") });
  assert.deepEqual(await h.processor(job()), { simulated: true, delivered: false });
  assert.equal(h.continuations.length, 1);
  ticks = 0;
  const value = evidence(); value.observedAt = "2026-11-05T15:00:05.001Z";
  await blocked(job(), "BILLING_EVIDENCE_STALE", {
    now: () => new Date(ticks++ === 0 ? NOW : value.observedAt),
    readEvidence: async () => value,
  });
});

for (const offsetDays of [-30, 180]) {
  test(`valid offset boundary ${offsetDays} is recalculated from fresh due date`, async () => {
    const value = evidence(); value.intent.offsetDays = offsetDays;
    const due = new Date("2026-11-05T00:00:00.000Z"); due.setUTCDate(due.getUTCDate() - offsetDays);
    value.invoice.dueAt = due.toISOString().slice(0, 10);
    const h = harness({ readEvidence: async () => value });
    assert.deepEqual(await h.processor(job()), { simulated: true, delivered: false });
    assert.equal(h.continuations.length, 1);
  });
}

test("offset below the allowed range is incomplete evidence", async () => {
  const value = evidence(); value.intent.offsetDays = -31;
  await blocked(job(), "BILLING_EVIDENCE_INCOMPLETE", { readEvidence: async () => value });
});

test("non-billing simulated queues preserve retry and processedAt behavior", async () => {
  const processor = createProcessor("knowledge-indexing");
  const input = { attemptsMade: 0, data: { correlationId: "fictional", payload: { simulateFailures: 1 } } };
  await assert.rejects(processor(input), /SIMULATED_TRANSIENT_FAILURE/);
  input.attemptsMade += 1;
  const result = await processor(input);
  assert.equal(result.queue, "knowledge-indexing");
  assert.equal(result.correlationId, "fictional");
  assert.ok(Number.isFinite(new Date(result.processedAt).getTime()));
});

for (const [label, value, valueSource] of [
  ['zero',0,'open-balance'],['negative',-1,'open-balance'],['missing',undefined,'open-balance'],
  ['string','50','open-balance'],['NaN',NaN,'open-balance'],['infinite',Infinity,'open-balance'],
  ['overflow',1e20,'open-balance'],['below-cent',0.001,'open-balance'],
  ['face-value',50,'face-value'],['unknown-source',50,undefined],['unavailable',50,'unavailable'],
]) test(`open status does not authorize reminder with ${label} balance`,async()=>{
  const current=evidence();current.invoice.value=value;current.invoice.valueSource=valueSource;
  await blocked(job(),'BILLING_INVOICE_BALANCE_UNCONFIRMED',{readEvidence:async()=>current});
});

for(const value of [0.01,0.29,15.75])test(`confirmed positive balance ${value} reaches fake continuation only`,async()=>{
 const current=evidence();current.invoice.value=value;
 const h=harness({readEvidence:async()=>current});assert.deepEqual(await h.processor(job()),{simulated:true,delivered:false});assert.equal(h.continuations.length,1);
});
