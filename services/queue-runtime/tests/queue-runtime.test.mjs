import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "bullmq";
import { deadLetterQueueName, queueNames } from "../src/config.mjs";
import { createRuntime, enqueue, retryJob, stableJobId } from "../src/runtime.mjs";

const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
const secret = "integration-test-secret-at-least-32-characters";
const config = redisUrl ? {
  redisUrl,
  secret,
  prefix: `lzr-test-${process.pid}-${Date.now()}`,
  concurrency: 2,
} : null;

async function waitFor(check, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TEST_TIMEOUT");
}

test("BullMQ processa, faz retry, envia à DLQ, reprocessa e deduplica", { skip: !config }, async () => {
  const runtime = createRuntime(config);
  const executions = new Map();
  const workers = queueNames.map((name) => {
    const worker = new Worker(name, async (job) => {
      executions.set(job.id, (executions.get(job.id) ?? 0) + 1);
      const failures = Number(job.data?.payload?.simulateFailures ?? 0);
      if (failures > job.attemptsMade) throw new Error("EXPECTED_FAILURE");
      return { ok: true };
    }, { connection: runtime.connection, prefix: config.prefix, concurrency: 2 });
    worker.on("failed", async (job, error) => {
      if (!job || job.attemptsMade < Number(job.opts.attempts ?? 1)) return;
      await runtime.queue(deadLetterQueueName).add("failed-job", {
        originalQueue: name,
        originalJobId: String(job.id),
        correlationId: job.data.correlationId,
        idempotencyKey: job.data.idempotencyKey,
        error: error.message,
      }, { jobId: `dlq-${name}-${job.id}`, attempts: 1, removeOnComplete: false, removeOnFail: false });
    });
    return worker;
  });

  try {
    const normal = await enqueue(runtime, {
      queue: "message-outbound",
      name: "normal",
      idempotencyKey: "normal-001",
      correlationId: "correlation-normal-001",
      payload: {},
      maxAttempts: 3,
    });
    await waitFor(async () => (await runtime.queue("message-outbound").getJob(normal.job.id))?.isCompleted());
    assert.equal(executions.get(normal.job.id), 1);

    const duplicate = await enqueue(runtime, {
      queue: "message-outbound",
      name: "normal",
      idempotencyKey: "normal-001",
      correlationId: "correlation-normal-001",
      payload: {},
      maxAttempts: 3,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, normal.job.id);
    assert.equal(executions.get(normal.job.id), 1);

    const retrying = await enqueue(runtime, {
      queue: "billing-reminders",
      name: "retry-success",
      idempotencyKey: "retry-001",
      correlationId: "correlation-retry-001",
      payload: { simulateFailures: 2 },
      maxAttempts: 3,
    });
    await waitFor(async () => (await runtime.queue("billing-reminders").getJob(retrying.job.id))?.isCompleted());
    assert.equal(executions.get(retrying.job.id), 3);

    const failing = await enqueue(runtime, {
      queue: "mass-campaigns",
      name: "dlq-failure",
      idempotencyKey: "dlq-001",
      correlationId: "correlation-dlq-001",
      payload: { simulateFailures: 10 },
      maxAttempts: 2,
    });
    const dlqId = `dlq-mass-campaigns-${stableJobId("dlq-001")}`;
    await waitFor(() => runtime.queue(deadLetterQueueName).getJob(dlqId));
    assert.equal(executions.get(failing.job.id), 2);

    const original = await runtime.queue("mass-campaigns").getJob(failing.job.id);
    await original.updateData({ ...original.data, payload: { simulateFailures: 0 } });
    await retryJob(runtime, deadLetterQueueName, dlqId);
    await waitFor(async () => (await runtime.queue("mass-campaigns").getJob(failing.job.id))?.isCompleted());
    assert.equal(await runtime.queue(deadLetterQueueName).getJob(dlqId), undefined);
    assert.equal(executions.get(failing.job.id), 3);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    for (const name of [...queueNames, deadLetterQueueName]) await runtime.queue(name).obliterate({ force: true });
    await runtime.close();
  }
});
