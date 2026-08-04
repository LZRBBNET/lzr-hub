import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbConversationsRepository } from "@/lib/platform/conversations-service";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { authorize } from "@/lib/platform/session-guard";
import { DbSupportMetricsRepository, getSupportMetrics } from "@/lib/platform/support-metrics";

const PERIODS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };
const QUEUE_LIMIT = 6;

/**
 * Tudo que a Visão geral mostra vem daqui, e tudo é medido de verdade.
 * O que não temos como medir hoje (tempo médio de atendimento, custo por
 * conversa) sai como `null` e a tela escreve que não é medido — nunca um número.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "7d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 24h, 7d ou 30d." }, { status: 400 });
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const channelEnabled = process.env.FEATURE_N8N_CHANNEL === "true";
  const channel = { enabled: channelEnabled, configured: !!process.env.N8N_CHANNEL_SECRET, autoReply: channelEnabled && process.env.FEATURE_N8N_AUTOREPLY === "true" };
  let ixc: { mode: string; state: string } = { mode: "disabled", state: "off" };
  try { const runtime = getIxcRuntime(); ixc = { mode: runtime.config.ixcMode, state: runtime.provider ? runtime.provider.health().state : "off" }; }
  catch { ixc = { mode: "indisponível", state: "error" }; }

  try {
    const db = await getDb();
    const [metrics, queue] = await Promise.all([
      getSupportMetrics(new DbSupportMetricsRepository(db), since),
      new DbConversationsRepository(db).listConversations(QUEUE_LIMIT),
    ]);
    return NextResponse.json({
      period, since, available: true, metrics, queue,
      // Sem instrumentação de duração por conversa ainda (depende do Langfuse, issue #6).
      averageHandlingSeconds: null,
      integrations: { ixc, channel },
    });
  } catch {
    return NextResponse.json({
      period, since, available: false, detail: "Banco de métricas indisponível",
      metrics: null, queue: [], averageHandlingSeconds: null,
      integrations: { ixc, channel },
    });
  }
}
