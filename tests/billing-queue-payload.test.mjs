import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCollectionDispatchRepository, runTodayDispatch } from "../lib/platform/collection-dispatch-service.ts";
import { createProcessor } from "../services/queue-runtime/src/processor.mjs";

// This fake captures the existing queue client's request. No HTTP/Redis/IXC or
// messaging service is contacted; environment and fetch are restored afterward.
test("new dispatch payload carries context but cannot authorize itself", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(["FEATURE_QUEUES", "QUEUE_SERVICE_URL", "QUEUE_SERVICE_SECRET"].map((key) => [key, process.env[key]]));
  const captured = [];
  const now = new Date("2026-11-05T15:00:00.000Z");
  const rule = {
    id: "rule-fictional", version: 2, name: "Fictícia", status: "draft", authorId: "fictional", updatedAt: now.toISOString(),
    steps: [{ id: "step-fictional", offsetDays: 0, active: true, channel: "WhatsApp", templateId: "template-fictional", attempts: 1 }],
  };
  try {
    process.env.FEATURE_QUEUES = "true";
    process.env.QUEUE_SERVICE_URL = "https://queue.invalid";
    process.env.QUEUE_SERVICE_SECRET = "fictional-test-only-secret";
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://queue.invalid/v1/actions");
      captured.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await runTodayDispatch(rule, [{ id: "invoice-fictional", customerId: "customer-fictional", status: "A", dueAt: "2026-11-05" }], new MemoryCollectionDispatchRepository(), now, "fictional-correlation");
    assert.equal(result.enqueued, 1);
    assert.equal(captured.length, 1);
    const input = captured[0].job;
    assert.deepEqual(input.payload, {
      schemaVersion: 1, invoiceId: "invoice-fictional", customerId: "customer-fictional", ruleId: "rule-fictional", ruleVersion: 2,
      stepId: "step-fictional", scheduledFor: "2026-11-05", channel: "WhatsApp", templateId: "template-fictional",
    });
    assert.equal("status" in input.payload, false);
    assert.equal("observedAt" in input.payload, false);
    const job = { queueName: input.queue, name: input.name, data: { ...input } };
    await assert.rejects(createProcessor("billing-reminders", { now: () => now })(job), { code: "BILLING_EVIDENCE_SOURCE_UNAVAILABLE" });
    let continuationCalls = 0;
    const processor = createProcessor("billing-reminders", {
      now: () => now,
      readEvidence: async () => ({
        complete: true, observedAt: now.toISOString(),
        invoice: { id: "invoice-fictional", customerId: "customer-fictional", status: "R", dueAt: "2026-11-05" },
        intent: { ...input.payload, idempotencyKey: input.idempotencyKey, current: true, active: true, cancelled: false, offsetDays: 0 },
      }),
      continueEligible: async () => { continuationCalls += 1; return { simulated: true, delivered: false }; },
    });
    await assert.rejects(processor(job), { code: "BILLING_INVOICE_NOT_OPEN" });
    assert.equal(continuationCalls, 0, "paying after enqueue must block the existing job");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
