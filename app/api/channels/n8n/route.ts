import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { D1ChannelRepository, MAX_MESSAGE_LENGTH, processChannelMessage } from "@/lib/platform/n8n-channel-service";
import { DbSupportMetricsRepository } from "@/lib/platform/support-metrics";

/**
 * Resposta automática nasce desligada, como toda flag que produz efeito no
 * mundo real: ligada, a IA fala com o cliente sem ninguém no meio.
 */
const autoReplyEnabled = () => process.env.FEATURE_N8N_AUTOREPLY === "true";

/** Estado do canal, sem nada sensível — usado pelo painel de integrações para não mentir sobre o status real. */
export async function GET() {
  const enabled = process.env.FEATURE_N8N_CHANNEL === "true";
  const configured = enabled && !!process.env.N8N_CHANNEL_SECRET;
  return NextResponse.json({ enabled, configured, autoReply: enabled && autoReplyEnabled() });
}

export async function POST(request: Request) {
  if (process.env.FEATURE_N8N_CHANNEL !== "true") {
    return NextResponse.json({ error: "Canal n8n desativado" }, { status: 503 });
  }
  const secret = process.env.N8N_CHANNEL_SECRET;
  if (!secret) return NextResponse.json({ error: "Canal n8n mal configurado" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const parsed = await request.json().catch(() => null) as Record<string, unknown> | null;
  const externalConversationId = typeof parsed?.externalConversationId === "string" ? parsed.externalConversationId.trim() : "";
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  const idempotencyKey = typeof parsed?.idempotencyKey === "string" ? parsed.idempotencyKey.trim() : "";
  const correlationId = typeof parsed?.correlationId === "string" && parsed.correlationId.trim() ? parsed.correlationId.trim() : randomUUID();

  if (!externalConversationId || !text || !idempotencyKey) {
    return NextResponse.json({ error: "Campos obrigatórios: externalConversationId, text, idempotencyKey" }, { status: 400 });
  }
  if (text.length > MAX_MESSAGE_LENGTH) return NextResponse.json({ error: "Mensagem acima do limite" }, { status: 413 });

  const db = await getDb();
  const result = await processChannelMessage(
    new D1ChannelRepository(db),
    { externalConversationId, text, idempotencyKey, correlationId },
    new DbSupportMetricsRepository(db),
    { autoReply: autoReplyEnabled() },
  );
  return NextResponse.json(result);
}
