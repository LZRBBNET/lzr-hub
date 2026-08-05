import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { summarizeChurn } from "@/lib/platform/churn-service";
import { authorize } from "@/lib/platform/session-guard";

const PERIODS: Record<string, number> = { "30d": 30, "90d": 90, "365d": 365 };

/** Churn realizado. Depende de ler a base inteira — com allowlist não há o que medir. */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "30d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 30d, 90d ou 365d." }, { status: 400 });

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return NextResponse.json({ available: false, detail: "IXC desligado: sem fonte de contratos", period, summary: null });
  if (!runtime.config.ixcFullBase) return NextResponse.json({ available: false, detail: "Churn exige leitura da base inteira (FEATURE_IXC_FULL_BASE)", period, summary: null });

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const correlationId = crypto.randomUUID();
  try {
    const [cancellations, activations, active, inactive] = await Promise.all([
      runtime.provider.listCancellations(since, correlationId),
      runtime.provider.listActivations(since, correlationId, 1, 1),
      runtime.provider.countContractsByStatus("A", correlationId),
      runtime.provider.countContractsByStatus("I", correlationId),
    ]);
    const rows = cancellations.rows.map((row) => {
      const raw = row as Record<string, unknown>;
      const value = Number(String(raw.valor_plano ?? "").replace(",", "."));
      return {
        reasonCode: String(raw.motivo_cancelamento ?? ""),
        cancelledAt: String(raw.data_cancelamento ?? "") || undefined,
        monthlyValue: Number.isFinite(value) && value > 0 ? value : undefined,
      };
    });
    const summary = summarizeChurn(rows, {
      total: cancellations.total, truncated: cancellations.truncated,
      activeContracts: active, inactiveContracts: inactive,
      activationsInPeriod: activations.total,
    });
    return NextResponse.json({ available: true, period, since, summary });
  } catch {
    return NextResponse.json({ available: false, detail: "Consulta de contratos do IXC indisponível", period, summary: null });
  }
}
