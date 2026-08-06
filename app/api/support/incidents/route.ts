import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { DbIncidentsRepository, IncidentValidationError, parseIncidentInput } from "@/lib/platform/incidents-service";
import {
  DbMassNoticeRepository, NOTICE_KINDS, runNoticeDispatch, type AffectedCustomer, type NoticeKind,
} from "@/lib/platform/mass-notice-service";
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
 * Clientes da allowlist com cidade e bairro reais, para casar contra a área da
 * massiva. Full base não entra aqui: o IXC não tem busca por bairro na base
 * inteira sem varrer a base — inventar essa cobertura seria mentir sobre o que
 * está sendo avisado de fato.
 */
async function loadAllowlistCustomers(): Promise<AffectedCustomer[]> {
  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return [];
  const settled = await Promise.allSettled(runtime.config.ixcAllowlist.map((id) => runtime.provider!.getSnapshot(id, crypto.randomUUID())));
  return settled.flatMap((result) => result.status === "fulfilled"
    ? [{ customerId: result.value.customer.id, city: result.value.customer.city, neighborhood: result.value.customer.neighborhood }]
    : []);
}

/**
 * Registrar, encerrar ou avisar uma massiva é ação de operação: exige
 * permissão de escrita e fica auditada. Registrar e encerrar continuam sem
 * comunicar ninguém. "notify" decide **quem seria avisado**, revalidando a
 * área na hora, e registra isso numa fila — ver mass-notice-service.ts para o
 * limite exato do que isto significa sem ponte de envio.
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

    if (body.action === "notify") {
      const id = typeof body.id === "string" ? body.id : "";
      const kind = body.kind as NoticeKind;
      if (!id) return NextResponse.json({ error: "Informe a massiva a avisar" }, { status: 400 });
      if (!NOTICE_KINDS.includes(kind)) return NextResponse.json({ error: "Tipo de aviso inválido" }, { status: 400 });

      const incidents = await repository.list(LIST_LIMIT);
      const incident = incidents.find((item) => item.id === id);
      if (!incident) return NextResponse.json({ error: "Massiva não encontrada" }, { status: 404 });

      const customers = await loadAllowlistCustomers();
      const correlationId = crypto.randomUUID();
      const result = await runNoticeDispatch(incident, kind, customers, new DbMassNoticeRepository(await getDb()), correlationId);

      await logUnauthenticatedAction({
        action: "support.incident.notify", entity: `incident:${id}`, result: "success",
        reason: `Aviso de ${kind === "opened" ? "abertura" : "normalização"}: ${result.matched} cliente(s) na área, ${result.recorded} registrado(s), ${result.duplicates} já avisado(s) antes, ${result.enqueued} enfileirado(s)${result.queueEnabled ? "" : " (fila desligada)"}`,
        actor: guard.user,
      });
      return NextResponse.json(result);
    }

    const created = await repository.create(parseIncidentInput(body));
    await logUnauthenticatedAction({ action: "support.incident.create", entity: `incident:${created.id}`, result: "success", reason: "Registro de massiva", actor: guard.user });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof IncidentValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Registro de massivas indisponível" }, { status: 503 });
  }
}
