export const queueNames = [
  "message-inbound",
  "message-outbound",
  "ixc-sync",
  "billing-reminders",
  "mass-campaigns",
  "network-alerts",
  "ai-evaluations",
  "knowledge-indexing",
  "dead-letter",
] as const;

export type QueueName = typeof queueNames[number];
export type JobStatus = "waiting" | "processing" | "completed" | "failed" | "cancelled";

export interface QueueJob {
  id: string;
  queue: QueueName;
  name: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  idempotencyKey: string;
  durationMs: number;
  error?: string;
  createdAt: string;
}

/** Compatibilidade temporária para consumidores que ainda usam o nome antigo. */
export type DemoJob = QueueJob;

export interface QueueSnapshot {
  enabled: boolean;
  runtime: "bullmq" | "disabled" | "unavailable";
  jobs: QueueJob[];
  counts: Record<QueueName, number>;
  detail?: string;
}

export interface EnqueueInput {
  queue: Exclude<QueueName, "dead-letter">;
  name: string;
  idempotencyKey: string;
  correlationId: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export type QueueAction =
  | { action: "enqueue"; job: EnqueueInput }
  | { action: "retry"; queue: QueueName; id: string }
  | { action: "cancel"; queue: QueueName; id: string };

const emptyCounts = () => Object.fromEntries(queueNames.map((queue) => [queue, 0])) as Record<QueueName, number>;

function disabledSnapshot(detail: string, runtime: QueueSnapshot["runtime"] = "disabled"): QueueSnapshot {
  return { enabled: false, runtime, jobs: [], counts: emptyCounts(), detail };
}

function queueRuntimeConfig(source: Record<string, string | undefined> = process.env) {
  if (source.FEATURE_QUEUES !== "true") return null;
  const url = source.QUEUE_SERVICE_URL?.trim();
  const secret = source.QUEUE_SERVICE_SECRET?.trim();
  if (!url || !secret) throw new Error("Filas habilitadas exigem QUEUE_SERVICE_URL e QUEUE_SERVICE_SECRET");
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "queue-api"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local) throw new Error("QUEUE_SERVICE_URL deve usar HTTPS fora do ambiente local");
  return { url: parsed.toString().replace(/\/$/, ""), secret };
}

async function runtimeRequest(path: string, init?: RequestInit) {
  const config = queueRuntimeConfig();
  if (!config) return null;
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.secret}`,
      "content-type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(result?.error ?? `QUEUE_RUNTIME_HTTP_${response.status}`);
  }
  return response;
}

export async function getQueueSnapshot(): Promise<QueueSnapshot> {
  if (!queueRuntimeConfig()) return disabledSnapshot("FEATURE_QUEUES=false");
  try {
    const response = await runtimeRequest("/v1/jobs");
    if (!response) return disabledSnapshot("Filas desabilitadas");
    return await response.json() as QueueSnapshot;
  } catch {
    return disabledSnapshot("Serviço de filas indisponível", "unavailable");
  }
}

export async function executeQueueAction(action: QueueAction) {
  const response = await runtimeRequest("/v1/actions", {
    method: "POST",
    body: JSON.stringify(action),
  });
  if (!response) throw new Error("Filas desabilitadas");
  return response.json() as Promise<{ ok: true; job?: QueueJob; duplicate?: boolean }>;
}
