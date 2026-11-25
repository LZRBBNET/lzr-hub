import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { previewContract, validAuditId } from "@/lib/platform/contract-audit-preview";
import { authEnforced, authorize } from "@/lib/platform/session-guard";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  // The shared guard allows synthetic demo traffic when auth is disabled.
  // Never allow it for an endpoint that can consult a real IXC record.
  if (!authEnforced()) return json({ error: "A prévia exige autenticação ativa." }, 503);
  const guard = await authorize(request, "audit.read");
  if (!guard.allowed) return json({ error: guard.error }, guard.status);
  if (!guard.user) return json({ error: "Sessão inválida ou expirada" }, 401);
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("contractId" in body) || !("customerId" in body)
    || !validAuditId(body.contractId) || !validAuditId(body.customerId)) {
    return json({ error: "Informe os IDs numéricos de cliente e contrato." }, 400);
  }
  try {
    const provider = getIxcRuntime().provider;
    if (provider?.health().scope !== "allowlist") {
      return json({ error: "Consulta individual restrita à homologação com lista de cadastros autorizados." }, 403);
    }
    return json(await previewContract(provider, body.customerId, body.contractId, randomUUID()));
  } catch {
    return json({ error: "A integração de homologação não está disponível." }, 503);
  }
}
