import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { CHANNEL_NAME } from "@/lib/platform/n8n-channel-service";
import { DbConversationStateRepository, changeConversationState } from "@/lib/platform/conversation-state-service";
import { authorize } from "@/lib/platform/session-guard";
import { DbTicketRepository, closeOpenTicket } from "@/lib/platform/triage-service";

/**
 * Assumir, devolver para a IA, resolver ou reabrir uma conversa.
 *
 * O canal vem do servidor, não do corpo — mesma regra da resposta: quem escolhe
 * o canal escolhe sobre qual cliente está agindo. Regras e auditoria no serviço.
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "support.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const db = await getDb();
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const result = await changeConversationState(new DbConversationStateRepository(db), {
      channel: CHANNEL_NAME,
      conversationId,
      action: typeof body.action === "string" ? body.action : "",
      takeOver: body.takeOver === true,
      actor: guard.user ? { id: guard.user.id, name: guard.user.name, email: guard.user.email, role: guard.user.role } : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.reason, state: result.state ?? null }, { status: result.status });
    // Resolver fecha o atendimento: a próxima fala do cliente ganha outro protocolo.
    // Melhor esforço — a conversa já está resolvida, e o atendimento parado fecha sozinho em 24 horas.
    if (result.changed && result.state.status === "resolved") await closeOpenTicket(new DbTicketRepository(db), CHANNEL_NAME, conversationId.trim()).catch(() => undefined);
    return NextResponse.json({ ok: true, state: result.state, changed: result.changed });
  } catch {
    return NextResponse.json({ error: "Não consegui mudar a conversa agora." }, { status: 503 });
  }
}
