import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { DbIncidentsRepository, IncidentValidationError, parseIncidentInput } from "@/lib/platform/incidents-service";
import { authorize } from "@/lib/platform/session-guard";

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    const items = await new DbIncidentsRepository(await getDb()).list(LIST_LIMIT);
    return NextResponse.json({ available: true, items });
  } catch {
    return NextResponse.json({ available: false, detail: "Registro de massivas indisponível", items: [] });
  }
}

/**
 * Registrar ou encerrar uma massiva é ação de operação: exige permissão de
 * escrita e fica auditada. Nada é comunicado a cliente nenhum daqui.
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "support.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const repository = new DbIncidentsRepository(await getDb());

    if (body.action === "close") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return NextResponse.json({ error: "Informe a massiva a encerrar" }, { status: 400 });
      const closed = await repository.close(id);
      await logUnauthenticatedAction({ action: "support.incident.close", entity: `incident:${id}`, result: closed ? "success" : "not_found", reason: "Encerramento de massiva", actor: guard.user });
      return closed ? NextResponse.json(closed) : NextResponse.json({ error: "Massiva não encontrada" }, { status: 404 });
    }

    const created = await repository.create(parseIncidentInput(body));
    await logUnauthenticatedAction({ action: "support.incident.create", entity: `incident:${created.id}`, result: "success", reason: "Registro de massiva", actor: guard.user });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof IncidentValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Registro de massivas indisponível" }, { status: 503 });
  }
}
