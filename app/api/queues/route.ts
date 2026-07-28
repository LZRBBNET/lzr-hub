import { NextResponse } from "next/server";
import {
  executeQueueAction,
  getQueueSnapshot,
  queueNames,
  type QueueAction,
} from "@/lib/platform/queue-service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validAction(value: unknown): value is QueueAction {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  if (value.action === "retry" || value.action === "cancel") {
    return typeof value.id === "string"
      && typeof value.queue === "string"
      && queueNames.includes(value.queue as never);
  }
  if (value.action !== "enqueue" || !isRecord(value.job)) return false;
  const job = value.job;
  return typeof job.queue === "string"
    && job.queue !== "dead-letter"
    && queueNames.includes(job.queue as never)
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
    && (job.maxAttempts === undefined || (Number.isInteger(job.maxAttempts) && Number(job.maxAttempts) >= 1 && Number(job.maxAttempts) <= 10));
}

export async function GET() {
  return NextResponse.json(await getQueueSnapshot());
}

export async function POST(request: Request) {
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
