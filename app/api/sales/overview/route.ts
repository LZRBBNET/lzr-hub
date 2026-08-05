import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { summarizeSales } from "@/lib/platform/sales-service";
import { authorize } from "@/lib/platform/session-guard";

const PERIODS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Vendas fechadas no período. Só existe com o IXC ligado — sem ele não há
 * contrato para contar, e devolver zero seria lido como "não vendemos nada".
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "30d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 7d, 30d ou 90d." }, { status: 400 });

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) {
    return NextResponse.json({ available: false, detail: "IXC desligado: sem fonte de contratos", period, summary: null });
  }
  if (!runtime.config.ixcFullBase) {
    // Com allowlist, "vendas do período" seria a venda de um cadastro — número
    // sem significado comercial. Melhor não responder do que responder isso.
    return NextResponse.json({ available: false, detail: "Desempenho comercial exige leitura da base inteira (FEATURE_IXC_FULL_BASE)", period, summary: null });
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const correlationId = crypto.randomUUID();
  try {
    const [activations, activeContracts] = await Promise.all([
      runtime.provider.listActivations(since, correlationId),
      runtime.provider.countActiveContracts(correlationId),
    ]);
    // O contrato não traz valor: a mensalidade vem do plano (`vd_contratos`).
    // São poucos planos distintos por período, então isso custa uma dezena de
    // consultas, não uma por contrato.
    const planIds = activations.rows.map((row) => String((row as Record<string, unknown>).id_vd_contrato ?? "")).filter(Boolean);
    const plans = await runtime.provider.resolvePlanValues(planIds, correlationId);
    const rows = activations.rows.map((row) => {
      const raw = row as Record<string, unknown>;
      const plan = plans.get(String(raw.id_vd_contrato ?? ""));
      return {
        planName: String(raw.contrato ?? raw.plano ?? ""),
        monthlyValue: plan?.value,
        activatedAt: String(raw.data_ativacao ?? "") || undefined,
      };
    });
    const summary = summarizeSales(rows, { total: activations.total, truncated: activations.truncated, activeContracts });
    return NextResponse.json({ available: true, period, since, summary });
  } catch {
    return NextResponse.json({ available: false, detail: "Consulta de contratos do IXC indisponível", period, summary: null });
  }
}
