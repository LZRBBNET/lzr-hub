import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbCrmRepository, CrmValidationError, funnelMetrics, isStage, parseLeadInput } from "@/lib/platform/crm-service";
import { CLOSED_STAGES } from "@/lib/platform/crm-shared";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

const LIST_LIMIT = 300;
const PERIODS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Funil comercial real (issue #17).
 *
 * Escrever no funil exige `sales.write-demo` — a permissão que já separa quem
 * mexe em comercial. Não é escrita no ERP: lead vive só aqui, e mover cartão
 * não produz efeito no mundo do cliente.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "30d";
  const days = PERIODS[period] ?? 30;

  try {
    const repository = new DbCrmRepository(await getDb());
    const [all, recent] = await Promise.all([
      repository.list(LIST_LIMIT),
      repository.createdSince(new Date(Date.now() - days * 86_400_000).toISOString()),
    ]);
    const activities = await repository.activities(all.map((lead) => lead.id));
    return NextResponse.json({ available: true, period, leads: all, activities, metrics: funnelMetrics(all, recent) });
  } catch {
    // Sem banco não há funil. Dizer isso evita que a tela leia "nenhum lead"
    // como "ninguém entrou em contato".
    return NextResponse.json({ available: false, detail: "Funil indisponível: o banco não respondeu", leads: [], activities: [], metrics: null });
  }
}

export async function POST(request: Request) {
  const guard = await authorize(request, "sales.write-demo");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });
  const actorId = guard.user?.email ?? "não identificado";

  try {
    const repository = new DbCrmRepository(await getDb());

    if (body.action === "create") {
      const input = parseLeadInput(body);
      const lead = await repository.create({ ...input, contactKey: null, actorId });
      await logUnauthenticatedAction({
        action: "crm.lead.create", entity: `lead:${lead.id}`, result: "success",
        reason: `Lead registrado na etapa "${lead.stage}" (origem: ${lead.source})`, actor: guard.user,
      });
      return NextResponse.json(lead, { status: 201 });
    }

    if (body.action === "move") {
      const leadId = typeof body.leadId === "string" ? body.leadId : "";
      if (!leadId || !isStage(body.toStage)) return NextResponse.json({ error: "Informe o lead e a etapa de destino" }, { status: 400 });
      const detail = typeof body.detail === "string" ? body.detail.trim() : "";
      // Perder sem dizer por quê deixa o funil com um número que ninguém sabe
      // explicar — e o motivo da perda é metade do valor de medir perda.
      if (body.toStage === "perdido" && detail.length < 3) return NextResponse.json({ error: "Diga por que o lead foi perdido" }, { status: 400 });
      const moved = await repository.move({ leadId, toStage: body.toStage, detail: detail || `Movido para ${body.toStage}`, actorId });
      if (!moved) return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
      await logUnauthenticatedAction({
        action: "crm.lead.move", entity: `lead:${leadId}`, result: "success",
        reason: `Lead movido para "${body.toStage}"${CLOSED_STAGES.includes(body.toStage) ? " (encerrado)" : ""}`, actor: guard.user,
      });
      return NextResponse.json(moved);
    }

    if (body.action === "activity") {
      const leadId = typeof body.leadId === "string" ? body.leadId : "";
      const detail = typeof body.detail === "string" ? body.detail.trim() : "";
      if (!leadId || detail.length < 3) return NextResponse.json({ error: "Escreva o que aconteceu" }, { status: 400 });
      const kind = body.kind === "contact" ? "contact" : "note";
      const activity = await repository.addActivity(leadId, kind, detail, actorId);
      if (!activity) return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
      return NextResponse.json(activity, { status: 201 });
    }

    return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  } catch (error) {
    if (error instanceof CrmValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Funil indisponível" }, { status: 503 });
  }
}
