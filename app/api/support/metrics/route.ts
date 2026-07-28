import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbSupportMetricsRepository, getSupportMetrics } from "@/lib/platform/support-metrics";

const PERIODS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };

export async function GET(request: Request) {
  const period = new URL(request.url).searchParams.get("period") ?? "7d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 24h, 7d ou 30d." }, { status: 400 });

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const metrics = await getSupportMetrics(new DbSupportMetricsRepository(await getDb()), since);
    return NextResponse.json({ period, since, available: true, ...metrics });
  } catch {
    // Sem banco configurado o painel mostra "indisponível" em vez de número inventado.
    return NextResponse.json({ period, since, available: false, detail: "Fonte de métricas indisponível" }, { status: 200 });
  }
}
