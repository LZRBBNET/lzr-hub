import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { previewContract, validAuditId } from "@/lib/platform/contract-audit-preview";
import { authorize } from "@/lib/platform/session-guard";

export async function POST(request: Request) {
  const guard = await authorize(request, "audit.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const provider = getIxcRuntime().provider;
  if (provider?.health().scope !== "allowlist") {
    return NextResponse.json({ error: "Consulta individual restrita à homologação com lista de cadastros autorizados." }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("contractId" in body) || !("customerId" in body)
    || !validAuditId(body.contractId) || !validAuditId(body.customerId)) {
    return NextResponse.json({ error: "Informe os IDs numéricos de cliente e contrato." }, { status: 400 });
  }
  const result = await previewContract(provider, body.customerId, body.contractId, randomUUID());
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
