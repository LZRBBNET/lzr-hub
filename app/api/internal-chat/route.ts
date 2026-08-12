import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  DbInternalChatRepository, InternalChatValidationError,
  normalizeParticipants, parseMessageBody, parseSubject,
} from "@/lib/platform/internal-chat-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize, currentUser } from "@/lib/platform/session-guard";

/**
 * Chat interno da equipe (issue #10).
 *
 * Exige `customer.read` só para separar quem é da casa de quem não é — não há
 * papel "sem chat". A separação que importa é a de participação, feita no
 * repositório: quem não participa não alcança a conversa, nem para ler nem
 * para escrever.
 *
 * ⚠️ Com `FEATURE_AUTH` desligada não existe "eu": todo mundo seria o mesmo
 * usuário anônimo e leria as conversas uns dos outros. Por isso a rota recusa
 * nesse caso, em vez de degradar para um chat compartilhado sem dono.
 */
async function requireIdentity(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return { error: NextResponse.json({ error: guard.error }, { status: guard.status }) };
  const user = guard.user ?? await currentUser(request);
  if (!user) {
    return { error: NextResponse.json({ error: "O chat interno exige login (FEATURE_AUTH). Sem identidade, não há como separar as conversas de cada pessoa." }, { status: 403 }) };
  }
  return { user };
}

export async function GET(request: Request) {
  const identity = await requireIdentity(request);
  if (identity.error) return identity.error;

  const threadId = new URL(request.url).searchParams.get("threadId");
  try {
    const repository = new DbInternalChatRepository(await getDb());
    if (threadId) {
      const view = await repository.getThread(threadId, identity.user.id);
      // Conversa alheia e conversa inexistente respondem igual: distinguir
      // revelaria quais conversas existem no sistema.
      if (!view) return NextResponse.json({ error: "Conversa não encontrada" }, { status: 404 });
      await repository.markRead(threadId, identity.user.id);
      return NextResponse.json({ available: true, ...view });
    }
    const [threads, people] = await Promise.all([
      repository.listThreadsFor(identity.user.id),
      repository.listPeople(),
    ]);
    return NextResponse.json({ available: true, threads, people, me: identity.user.id });
  } catch {
    return NextResponse.json({ available: false, detail: "Chat interno indisponível", threads: [], people: [] });
  }
}

export async function POST(request: Request) {
  const identity = await requireIdentity(request);
  if (identity.error) return identity.error;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const repository = new DbInternalChatRepository(await getDb());

    if (body.action === "create") {
      const subject = parseSubject(body.subject);
      const participantIds = normalizeParticipants(identity.user.id, body.participantIds);
      const linked = typeof body.linkedConversationId === "string" && body.linkedConversationId.trim() ? body.linkedConversationId.trim() : undefined;
      const threadId = await repository.createThread({ subject, linkedConversationId: linked, authorId: identity.user.id, participantIds });
      // O assunto entra na auditoria porque é escolhido por quem abre e serve
      // para achar a conversa depois. O corpo das mensagens nunca entra.
      await logUnauthenticatedAction({
        action: "internal_chat.thread.create", entity: `internal_thread:${threadId}`, result: "success",
        reason: `Conversa interna aberta com ${participantIds.length} participante(s): ${subject}`, actor: identity.user,
      });
      return NextResponse.json({ id: threadId }, { status: 201 });
    }

    if (body.action === "message") {
      const threadId = typeof body.threadId === "string" ? body.threadId : "";
      if (!threadId) return NextResponse.json({ error: "Informe a conversa" }, { status: 400 });
      const message = await repository.addMessage(threadId, identity.user.id, parseMessageBody(body.body));
      if (!message) return NextResponse.json({ error: "Conversa não encontrada" }, { status: 404 });
      await logUnauthenticatedAction({
        action: "internal_chat.message", entity: `internal_thread:${threadId}`, result: "success",
        // Sem o texto: conversa interna sobre cliente carrega dado pessoal por
        // natureza, e a auditoria é lida por quem não participa da conversa.
        reason: "Mensagem enviada no chat interno (conteúdo não registrado na auditoria)", actor: identity.user,
      });
      return NextResponse.json(message, { status: 201 });
    }

    return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  } catch (error) {
    if (error instanceof InternalChatValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Chat interno indisponível" }, { status: 503 });
  }
}
