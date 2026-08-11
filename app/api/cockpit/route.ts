import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { businessToday } from "@/lib/platform/billing-service";
import { buildCockpitSnapshot } from "@/lib/platform/cockpit-service";
import { DbIncidentsRepository } from "@/lib/platform/incidents-service";
import { DbSalesGoalsRepository, currentPeriod, periodRange } from "@/lib/platform/sales-goals-service";
import { summarizeSales } from "@/lib/platform/sales-service";
import { DbSupportMetricsRepository, getSupportMetrics } from "@/lib/platform/support-metrics";
import { fetchLangfuseCost, langfuseCostOptionsFromEnv } from "@/lib/observability/langfuse-cost";
import { listAuditEvents } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

const PERIODS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };
const ACTIVITY_LIMIT = 8;
const INCIDENT_LIMIT = 50;

/** Só o que o resultado precisa: `null` quando a fonte falhou, para o serviço decidir o texto. */
const settled = <T>(result: PromiseSettledResult<T>): T | null => result.status === "fulfilled" ? result.value : null;

/**
 * Cockpit do gestor (issue #22). Cada módulo é consultado em paralelo e falha
 * isolada: o `Promise.allSettled` existe justamente para uma fonte fora do ar
 * não apagar as outras da tela. Ver cockpit-service.ts para a regra de nunca
 * transformar indisponibilidade em zero.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "7d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 24h, 7d ou 30d." }, { status: 400 });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  const provider = runtime?.provider;
  const fullBase = !!runtime?.config.ixcFullBase;

  const db = await getDb().catch(() => null);
  const goalPeriod = currentPeriod();

  const langfuse = langfuseCostOptionsFromEnv();
  const [
    activeContracts, openInvoices, overdue, support, incidents, goal, realized, audit, aiCost,
  ] = await Promise.allSettled([
    provider ? provider.countActiveContracts(crypto.randomUUID()) : Promise.reject(new Error("IXC off")),
    provider ? provider.countOpenInvoices(crypto.randomUUID()) : Promise.reject(new Error("IXC off")),
    // Uma página de um registro só: o que interessa aqui é o `total` do IXC,
    // que já vem exato. Varrer as ~3,5 mil vencidas para somar o valor levava
    // até 12 consultas e estourava o tempo ao abrir a tela — a soma continua
    // na tela de Cobrança, onde a espera se justifica.
    provider && fullBase
      ? provider.listOverdueInvoices(businessToday(new Date()), crypto.randomUUID(), 1, 1)
      : Promise.reject(new Error("full base off")),
    db ? getSupportMetrics(new DbSupportMetricsRepository(db), since) : Promise.reject(new Error("db off")),
    db ? new DbIncidentsRepository(db).list(INCIDENT_LIMIT) : Promise.reject(new Error("db off")),
    db ? new DbSalesGoalsRepository(db).findByPeriod(goalPeriod) : Promise.reject(new Error("db off")),
    realizedContractsFor(goalPeriod, provider, fullBase),
    listAuditEvents(ACTIVITY_LIMIT),
    langfuse ? fetchLangfuseCost(langfuse, since, new Date().toISOString()) : Promise.reject(new Error("langfuse off")),
  ]);

  const overdueRows = settled(overdue);
  const goalRow = settled(goal);
  const snapshot = buildCockpitSnapshot({
    period, since,
    // O cockpit conta a base inteira. Em modo allowlist o IXC responde, mas o
    // guard recusa a contagem — dizer "indisponível" mandaria procurar defeito
    // onde não há.
    ixcUnavailableReason: !provider
      ? "IXC desligado (IXC_MODE)"
      : !fullBase
        ? "Exige leitura da base inteira (FEATURE_IXC_FULL_BASE)"
        : "IXC não respondeu",
    activeContracts: settled(activeContracts),
    openInvoices: settled(openInvoices),
    overdueInvoices: overdueRows ? overdueRows.total : null,
    support: settled(support),
    incidents: settled(incidents),
    goal: goalRow ? { targetContracts: goalRow.targetContracts, realizedContracts: settled(realized) } : null,
    audit: settled(audit),
    aiCost: settled(aiCost),
  });

  return NextResponse.json({ available: true, ...snapshot });
}

/**
 * Contratos ativados no período da meta. Mesma leitura que a tela de Metas faz
 * — sem base inteira liberada não há como contar, e devolver zero diria que a
 * equipe não vendeu nada.
 */
async function realizedContractsFor(
  period: string,
  provider: ReturnType<typeof getIxcRuntime>["provider"] | undefined,
  fullBase: boolean,
): Promise<number | null> {
  if (!provider || !fullBase) return null;
  const { since, until } = periodRange(period);
  const correlationId = crypto.randomUUID();
  const activations = await provider.listActivations(since, correlationId, 4, 500, until);
  const planIds = activations.rows.map((row) => String((row as Record<string, unknown>).id_vd_contrato ?? "")).filter(Boolean);
  const plans = await provider.resolvePlanValues(planIds, correlationId);
  // `activeContracts: 0` aqui é só para satisfazer a assinatura: o cockpit lê a
  // contagem de ativos direto de countActiveContracts, não deste resumo.
  return summarizeSales(
    activations.rows.map((row) => {
      const raw = row as Record<string, unknown>;
      return {
        planName: String(raw.contrato ?? raw.plano ?? ""),
        monthlyValue: plans.get(String(raw.id_vd_contrato ?? ""))?.value,
        activatedAt: String(raw.data_ativacao ?? "") || undefined,
        status: String(raw.status ?? "") || undefined,
      };
    }),
    { total: activations.total, truncated: activations.truncated, activeContracts: 0 },
  ).activations;
}
