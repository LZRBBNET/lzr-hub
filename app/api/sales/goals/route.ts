import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import {
  DbSalesGoalsRepository, GoalValidationError, PERIOD_PATTERN,
  currentPeriod, goalProgress, parseGoalInput, periodRange,
} from "@/lib/platform/sales-goals-service";
import { summarizeSales } from "@/lib/platform/sales-service";
import { authorize } from "@/lib/platform/session-guard";

const GOAL_LIMIT = 24;

/**
 * Realizado da competência, lido do IXC na hora.
 *
 * Devolve `null` quando o IXC não responde — a tela mostra a meta e diz que o
 * realizado está indisponível, em vez de comparar contra zero e anunciar que a
 * equipe não vendeu nada.
 */
async function realizedFor(period: string) {
  let runtime;
  try { runtime = getIxcRuntime(); } catch { return null; }
  if (!runtime?.provider || !runtime.config.ixcFullBase) return null;

  const { since, until } = periodRange(period);
  const correlationId = crypto.randomUUID();
  try {
    const activations = await runtime.provider.listActivations(since, correlationId, 4, 500, until);
    const planIds = activations.rows.map((row) => String((row as Record<string, unknown>).id_vd_contrato ?? "")).filter(Boolean);
    const plans = await runtime.provider.resolvePlanValues(planIds, correlationId);
    const summary = summarizeSales(
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
    );
    return {
      contracts: summary.activations,
      revenue: summary.monthlyRecurringAdded,
      alreadyCancelled: summary.alreadyCancelled,
      truncated: summary.truncated,
      withoutValue: summary.withoutValue,
    };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const requested = new URL(request.url).searchParams.get("period") ?? currentPeriod();
  if (!PERIOD_PATTERN.test(requested)) return NextResponse.json({ error: "Competência inválida. Use AAAA-MM." }, { status: 400 });

  let goals;
  try { goals = await new DbSalesGoalsRepository(await getDb()).list(GOAL_LIMIT); }
  catch { return NextResponse.json({ available: false, detail: "Metas indisponíveis: banco não configurado", period: requested, goals: [], realized: null, progress: null }); }

  const goal = goals.find((item) => item.period === requested) ?? null;
  const realized = await realizedFor(requested);
  return NextResponse.json({
    available: true,
    period: requested,
    currentPeriod: currentPeriod(),
    goals,
    realized,
    progress: goal && realized ? goalProgress(goal, realized.contracts, realized.revenue, new Date()) : null,
  });
}

/** Registrar meta é ato humano: fica auditado com quem registrou e para qual mês. */
export async function POST(request: Request) {
  const guard = await authorize(request, "sales.write-demo");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const input = parseGoalInput(body);
    const actor = guard.user?.email ?? "não identificado";
    const saved = await new DbSalesGoalsRepository(await getDb()).upsert(input, actor);
    await logUnauthenticatedAction({
      action: "sales.goal.save", entity: `sales_goal:${saved.period}`, result: "success",
      reason: `Meta de ${saved.period}: ${saved.targetContracts} contratos${saved.targetRevenue === null ? "" : ` e R$ ${saved.targetRevenue.toFixed(2)}`}`,
      actor: guard.user,
    });
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    if (error instanceof GoalValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Não foi possível salvar a meta" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const guard = await authorize(request, "sales.write-demo");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "";
  if (!PERIOD_PATTERN.test(period)) return NextResponse.json({ error: "Competência inválida. Use AAAA-MM." }, { status: 400 });

  try {
    const removed = await new DbSalesGoalsRepository(await getDb()).remove(period);
    if (!removed) return NextResponse.json({ error: "Não há meta registrada nessa competência" }, { status: 404 });
    await logUnauthenticatedAction({
      action: "sales.goal.delete", entity: `sales_goal:${period}`, result: "success",
      reason: `Meta de ${period} removida`, actor: guard.user,
    });
    return NextResponse.json({ removed: true });
  } catch {
    return NextResponse.json({ error: "Não foi possível remover a meta" }, { status: 503 });
  }
}
