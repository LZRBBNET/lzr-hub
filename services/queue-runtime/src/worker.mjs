import { Worker } from "bullmq";
import { deadLetterQueueName, loadConfig, queueNames } from "./config.mjs";
import { createRuntime } from "./runtime.mjs";

const config = loadConfig();
const runtime = createRuntime(config);

async function processor(job) {
  const simulateFailures = Number(job.data?.payload?.simulateFailures ?? 0);
  if (Number.isInteger(simulateFailures) && simulateFailures > job.attemptsMade) {
    throw new Error("SIMULATED_TRANSIENT_FAILURE");
  }
  return {
    processedAt: new Date().toISOString(),
    correlationId: job.data?.correlationId,
    queue: job.queueName,
  };
}

const workers = queueNames.map((name) => {
  const worker = new Worker(name, processor, {
    connection: runtime.connection,
    prefix: config.prefix,
    concurrency: config.concurrency,
  });

  worker.on("completed", (job) => {
    console.info(JSON.stringify({ event: "queue-job-completed", queue: name, jobId: job.id, attempts: job.attemptsMade }));
  });

  worker.on("failed", async (job, error) => {
    if (!job) return;
    const maximum = Number(job.opts.attempts ?? 1);
    console.warn(JSON.stringify({ event: "queue-job-failed", queue: name, jobId: job.id, attempts: job.attemptsMade, maximum, error: error.message }));
    if (job.attemptsMade < maximum) return;
    try {
      const dlq = runtime.queue(deadLetterQueueName);
      const dlqId = `dlq-${name}-${job.id}`.replaceAll(":", "-");
      if (await dlq.getJob(dlqId)) return;
      await dlq.add("failed-job", {
        originalQueue: name,
        originalJobId: String(job.id),
        correlationId: job.data?.correlationId,
        idempotencyKey: job.data?.idempotencyKey,
        failedAt: new Date().toISOString(),
        error: error.message.slice(0, 180),
      }, {
        jobId: dlqId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });
      console.warn(JSON.stringify({ event: "queue-job-dead-lettered", queue: name, jobId: job.id, dlqId }));
    } catch (dlqError) {
      console.error(JSON.stringify({ event: "queue-dlq-write-failed", queue: name, jobId: job.id, error: dlqError instanceof Error ? dlqError.message : "UNKNOWN" }));
    }
  });

  worker.on("error", (error) => {
    console.error(JSON.stringify({ event: "queue-worker-error", queue: name, error: error.message }));
  });
  return worker;
});

async function shutdown(signal) {
  console.info(JSON.stringify({ event: "queue-workers-shutdown", signal }));
  await Promise.all(workers.map((worker) => worker.close()));
  await runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
console.info(JSON.stringify({ event: "queue-workers-ready", queues: queueNames, concurrency: config.concurrency }));
