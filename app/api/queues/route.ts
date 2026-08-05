import { NextResponse } from "next/server";
import {
  executeQueueAction,
  getQueueSnapshot,
  queueNames,
  type QueueAction,
  type QueueName,
} from "@/lib/platform/queue-service";
import { authorize } from "@/lib/platform/session-guard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isQueueName(value: string): value is QueueName {
  return (queueNames as readonly string[]).includes(value);
}

function validAction(value: unknown): value is QueueAction {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  if (value.action === "retry" || value.action === "cancel") {
    return typeof value.id === "string"
      && typeof value.queue === "string"
      && isQueueName(value.queue);
  }
  if (value.action !== "enqueue" || !isRecord(value.job)) return false;
  const job = value.job;
  return typeof job.queue === "string"
    && job.queue !== "dead-letter"
    && isQueueName(job.queue)
    && typeof job.name === "string"
    && job.name.length > 0
    && job.name.length <= 80
    && typeof job.idempotencyKey === "string"
    && job.idempotencyKey.length >= 4
    && job.idempotencyKey.length <= 160
    && typeof job.correlationId === "string"
    && job.correlationId.length >= 8
    && job.correlationId.length <= 128
    && (job.payload === undefined || isRecord(job.payload))
    && (job.maxAttempts === undefined || (typeof job.maxAttempts === "number" && Number.isInteger(job.maxAttempts) && job.maxAttempts >= 1 && job.maxAttempts <= 10));
}

/**
 * Enfileirar, reprocessar e cancelar job são ações de operação — e passavam sem
 * qualquer verificação de sessão. Com FEATURE_QUEUES desligada o estrago era
 * limitado, mas a rota não pode depender de uma flag para não ser um buraco.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  return NextResponse.json(await getQueueSnapshot());
}

export async function POST(request: Request) {
  const guard = await authorize(request, "support.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = await request.json().catch(() => null);
  if (!validAction(body)) {
    return NextResponse.json({ error: "Ação de fila inválida" }, { status: 400 });
  }
  try {
    return NextResponse.json(await executeQueueAction(body));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Serviço de filas indisponível" },
      { status: 503 },
    );
  }
}
