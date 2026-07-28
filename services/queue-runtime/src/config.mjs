export const queueNames = [
  "message-inbound",
  "message-outbound",
  "ixc-sync",
  "billing-reminders",
  "mass-campaigns",
  "network-alerts",
  "ai-evaluations",
  "knowledge-indexing",
];

export const deadLetterQueueName = "dead-letter";

function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}_INVALID`);
  return parsed;
}

export function loadConfig(source = process.env) {
  if (source.FEATURE_QUEUES !== "true") throw new Error("FEATURE_QUEUES_DISABLED");
  const redisUrl = source.REDIS_URL?.trim();
  const secret = source.QUEUE_SERVICE_SECRET?.trim();
  if (!redisUrl) throw new Error("REDIS_URL_REQUIRED");
  if (!secret || secret.length < 32) throw new Error("QUEUE_SERVICE_SECRET_TOO_SHORT");
  const parsed = new URL(redisUrl);
  if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("REDIS_URL_INVALID");
  return {
    redisUrl: parsed.toString(),
    secret,
    host: source.QUEUE_SERVICE_HOST ?? "0.0.0.0",
    port: integer(source.QUEUE_SERVICE_PORT, 8790, 1, 65535, "QUEUE_SERVICE_PORT"),
    prefix: source.QUEUE_PREFIX?.trim() || "lzr",
    concurrency: integer(source.QUEUE_WORKER_CONCURRENCY, 5, 1, 50, "QUEUE_WORKER_CONCURRENCY"),
    maxBodyBytes: integer(source.QUEUE_MAX_BODY_BYTES, 65_536, 1_024, 1_048_576, "QUEUE_MAX_BODY_BYTES"),
  };
}
