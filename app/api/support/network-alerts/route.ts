import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbNetworkAlertsRepository, MASSIVA_SUGGESTION_THRESHOLD, suggestsMassiva } from "@/lib/platform/network-alerts-service";
import { authorize } from "@/lib/platform/session-guard";

const PERIODS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };

/**
 * Alertas reais do Telegram (ver app/api/integrations/telegram/webhook). Sem a
 * flag ligada não há ingestão nenhuma — a resposta diz isso, não devolve lista
 * vazia como se fosse "rede saudável".
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  if (process.env.FEATURE_TELEGRAM_ALERTS !== "true") {
    return NextResponse.json({ available: false, detail: "Ingestão de alertas desligada (FEATURE_TELEGRAM_ALERTS)", open: [], recent: [], suggestMassiva: false });
  }

  const period = new URL(request.url).searchParams.get("period") ?? "24h";
  const days = PERIODS[period] ?? 1;

  try {
    const repository = new DbNetworkAlertsRepository(await getDb());
    const [open, recent] = await Promise.all([
      repository.listOpen(),
      repository.listSince(new Date(Date.now() - days * 86_400_000).toISOString()),
    ]);
    return NextResponse.json({
      available: true, period, open, recent,
      suggestMassiva: suggestsMassiva(open), threshold: MASSIVA_SUGGESTION_THRESHOLD,
    });
  } catch {
    return NextResponse.json({ available: false, detail: "Alertas de rede indisponíveis", open: [], recent: [], suggestMassiva: false });
  }
}
