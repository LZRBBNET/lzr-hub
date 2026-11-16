import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authorize, readSessionToken } from "@/lib/platform/session-guard";
import { CHANNEL_NAME } from "@/lib/platform/n8n-channel-service";
import { can } from "@/lib/platform/rbac";
import { DbDeliveryReconciliation, ReconciliationError } from "@/lib/platform/delivery-reconciliation-service";

const validId = (value: unknown): value is string => typeof value === "string" && /^\d{10,15}$/.test(value);
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!guard.user) return NextResponse.json({ error: "Sessão obrigatória" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("conversationId");
  if (!validId(id)) return NextResponse.json({ error: "Conversa inválida" }, { status: 400 });
  try {
    const delivery = await new DbDeliveryReconciliation(await getDb()).status(CHANNEL_NAME, id);
    return NextResponse.json({ delivery, canReconcile: can(guard.user.role, "support.reconcile") }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Estado do envio indisponível. Não reenvie." }, { status: 503 }); }
}
export async function POST(request: Request) {
  const guard = await authorize(request, "support.reconcile");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!guard.user) return NextResponse.json({ error: "Sessão obrigatória" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || !validId(body.conversationId) || typeof body.reservationId !== "string" || typeof body.outcome !== "string" || typeof body.evidence !== "string" || (body.messageId !== undefined && typeof body.messageId !== "string")) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });
  try {
    const result = await new DbDeliveryReconciliation(await getDb()).reconcile({ channel: CHANNEL_NAME, conversationId: body.conversationId, reservationId: body.reservationId, outcome: body.outcome, evidence: body.evidence, messageId: body.messageId, actor: guard.user, sessionToken: readSessionToken(request) ?? "" });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ReconciliationError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ ok: false, status: "unconfirmed", error: "Reconciliação não confirmada. Atualize para conferir; não reenvie a mensagem." }, { status: 503 });
  }
}
