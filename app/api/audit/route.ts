import { NextResponse } from "next/server";
import { listAuditEvents } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

export async function GET(request: Request) {
  const guard = await authorize(request, "audit.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    return NextResponse.json({ available: true, events: await listAuditEvents(50) });
  } catch {
    // Sem banco não há rastro para mostrar; a tela informa em vez de exibir dado falso.
    return NextResponse.json({ available: false, events: [], detail: "Rastro de auditoria indisponível" });
  }
}
