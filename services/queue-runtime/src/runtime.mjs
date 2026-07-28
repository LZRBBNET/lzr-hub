import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { deadLetterQueueName, queueNames } from "./config.mjs";

export function connectionOptions(redisUrl) {
  const url = new URL(redisUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isInteger(database) ? database : 0,
    maxRetriesPerRequest: null,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function createRuntime(config) {
  const connection = connectionOptions(config.redisUrl);
  const names = [...queueNames, deadLetterQueueName];
  const queues = new Map(names.map((name) => [name, new Queue(name, {
    connection,
    prefix: config.prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  })]));

  const queue = (name) => {
    const value = queues.get(name);
    if (!value) throw new Error("QUEUE_NOT_ALLOWED");
    return value;
  };

  return {
    connection,
    queue,
    async close() {
      await Promise.all([...queues.values()].map((item) => item.close()));
    },
  };
}

export function stableJobId(idempotencyKey) {
  return `job-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}`;
}

function safeString(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 180) : fallback;
}

export function validateEnqueue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOB_INVALID");
  if (!queueNames.includes(value.queue)) throw new Error("QUEUE_NOT_ALLOWED");
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 80) throw new Error("JOB_NAME_INVALID");
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length < 4 || value.idempotencyKey.length > 160) throw new Error("IDEMPOTENCY_KEY_INVALID");
  if (typeof value.correlationId !== "string" || value.correlationId.length < 8 || value.correlationId.length > 128) throw new Error("CORRELATION_ID_INVALID");
  if (value.payload !== undefined && (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload))) throw new Error("PAYLOAD_INVALID");
  const maxAttempts = value.maxAttempts === undefined ? 3 : Number(value.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("MAX_ATTEMPTS_INVALID");
  return {
    queue: value.queue,
    name: value.name,
    idempotencyKey: value.idempotencyKey,
    correlationId: value.correlationId,
    payload: value.payload ?? {},
    maxAttempts,
  };
}

export async function enqueue(runtime, input) {
  const value = validateEnqueue(input);
  const target = runtime.queue(value.queue);
  const id = stableJobId(value.idempotencyKey);
  const existing = await target.getJob(id);
  if (existing) return { job: await publicJob(existing, value.queue), duplicate: true };
  const job = await target.add(value.name, {
    payload: value.payload,
    correlationId: value.correlationId,
    idempotencyKey: value.idempotencyKey,
    queuedAt: new Date().toISOString(),
  }, {
    jobId: id,
    attempts: value.maxAttempts,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: false,
    removeOnFail: false,
  });
  return { job: await publicJob(job, value.queue), duplicate: false };
}

function mappedStatus(state, cancelled) {
  if (cancelled) return "cancelled";
  if (state === "active") return "processing";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return "waiting";
}

export async function publicJob(job, queueName) {
  const state = await job.getState();
  const started = job.processedOn ?? job.timestamp;
  const ended = job.finishedOn ?? Date.now();
  return {
    id: String(job.id),
    queue: queueName,
    name: job.name,
    status: mappedStatus(state, job.data?.cancelled === true),
    attempts: job.attemptsMade,
    maxAttempts: Number(job.opts.attempts ?? 1),
    correlationId: safeString(job.data?.correlationId, "unavailable"),
    idempotencyKey: safeString(job.data?.idempotencyKey, "unavailable"),
    durationMs: Math.max(0, ended - started),
    ...(job.failedReason ? { error: safeString(job.failedReason, "Falha no processamento") } : {}),
    createdAt: new Date(job.timestamp).toISOString(),
  };
}

export async function snapshot(runtime) {
  const allNames = [...queueNames, deadLetterQueueName];
  const jobs = [];
  const counts = Object.fromEntries(allNames.map((name) => [name, 0]));
  for (const name of allNames) {
    const selected = await runtime.queue(name).getJobs(["active", "waiting", "delayed", "failed", "completed"], 0, 49, false);
    counts[name] = selected.length;
    for (const job of selected) jobs.push(await publicJob(job, name));
  }
  jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { enabled: true, runtime: "bullmq", jobs: jobs.slice(0, 100), counts };
}

export async function retryJob(runtime, queueName, id) {
  if (queueName === deadLetterQueueName) {
    const dlqJob = await runtime.queue(deadLetterQueueName).getJob(id);
    if (!dlqJob) throw new Error("JOB_NOT_FOUND");
    const originalQueue = dlqJob.data?.originalQueue;
    const originalJobId = dlqJob.data?.originalJobId;
    if (!queueNames.includes(originalQueue) || typeof originalJobId !== "string") throw new Error("DLQ_RECORD_INVALID");
    const original = await runtime.queue(originalQueue).getJob(originalJobId);
    if (!original) throw new Error("ORIGINAL_JOB_NOT_FOUND");
    await original.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
    await dlqJob.remove();
    return publicJob(original, originalQueue);
  }
  if (!queueNames.includes(queueName)) throw new Error("QUEUE_NOT_ALLOWED");
  const job = await runtime.queue(queueName).getJob(id);
  if (!job) throw new Error("JOB_NOT_FOUND");
  await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
  return publicJob(job, queueName);
}

export async function cancelJob(runtime, queueName, id) {
  if (!queueNames.includes(queueName)) throw new Error("QUEUE_NOT_ALLOWED");
  const job = await runtime.queue(queueName).getJob(id);
  if (!job) throw new Error("JOB_NOT_FOUND");
  const state = await job.getState();
  if (!["waiting", "delayed"].includes(state)) throw new Error("JOB_CANNOT_BE_CANCELLED");
  await job.updateData({ ...job.data, cancelled: true });
  const result = await publicJob(job, queueName);
  await job.remove();
  return { ...result, status: "cancelled" };
}
