import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { metaSendConfigFromEnv } from "@/lib/integrations/meta/cloud-client";
import { DbReplyRepository, attendantReplyEnabled, sendAttendantReply } from "@/lib/platform/attendant-reply-service";
import { CHANNEL_NAME } from "@/lib/platform/n8n-channel-service";
import { DbConversationStateRepository, claimIfUnassigned } from "@/lib/platform/conversation-state-service";
import { authorize } from "@/lib/platform/session-guard";

/**
 * O atendente responde ao cliente pelo WhatsApp (Meta Cloud API).
 *
 * Fina de propósito: login e permissão aqui, todo o resto — flag, janela de 24
 * horas, idempotência, auditoria — no serviço. O canal vem do servidor, não do
 * corpo: quem escolhe o canal da resposta escolhe por onde o cliente é alcançado.
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "support.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const result = await sendAttendantReply(
      { repository: new DbReplyRepository(await getDb()), config: metaSendConfigFromEnv(), enabled: attendantReplyEnabled() },
      {
        channel: CHANNEL_NAME,
        conversationId: typeof body.conversationId === "string" ? body.conversationId : "",
        text: typeof body.text === "string" ? body.text : "",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        actor: guard.user ? { email: guard.user.email, role: guard.user.role } : undefined,
      },
    );
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.status });
    // Quem respondeu vira o responsável, se ninguém era — e com isso a IA para de
    // falar por cima nesta conversa quando a resposta automática for ligada.
    if (!result.duplicate) await claimIfUnassigned(new DbConversationStateRepository(await getDb()), CHANNEL_NAME, String(body.conversationId ?? ""), guard.user);
    return NextResponse.json({ ok: true, messageId: result.messageId, duplicate: result.duplicate, recorded: result.recorded });
  } catch {
    return NextResponse.json({ error: "Não consegui concluir o envio agora. Nada foi enviado." }, { status: 503 });
  }
}
