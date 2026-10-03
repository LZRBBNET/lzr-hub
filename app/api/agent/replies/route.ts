import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { sanitizeHandoffText } from "@/lib/agent/handoff";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import {
  DbReplyTemplatesRepository,
  ReplyTemplateValidationError,
  resetTemplate,
  saveTemplate,
  templatesView,
} from "@/lib/platform/reply-templates-service";
import { REPLY_INTENTS } from "@/lib/platform/reply-templates-shared";
import { authorize } from "@/lib/platform/session-guard";

const excerpt = (value: string | null | undefined) => `"${sanitizeHandoffText(value ?? "").slice(0, 200)}"`;

/**
 * Respostas aprovadas por intenção — o texto que o canal sugere (e, quando a
 * resposta automática for ligada, envia) no lugar do texto de homologação.
 *
 * Ler exige `customer.read`; editar exige `knowledge.publish`, a mesma permissão
 * de publicar conhecimento: as duas decidem o que o cliente lê da BBNET.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    return NextResponse.json({ available: true, items: await templatesView(new DbReplyTemplatesRepository(await getDb())) });
  } catch {
    // Sem banco não há como saber o que foi editado: mostrar só o padrão como se
    // fosse o texto em vigor seria afirmar o que não se sabe.
    return NextResponse.json({ available: false, detail: "Respostas indisponíveis: o banco não respondeu.", items: [] });
  }
}

export async function POST(request: Request) {
  const guard = await authorize(request, "knowledge.publish");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const repository = new DbReplyTemplatesRepository(await getDb());
    const actor = guard.user?.email ?? "anônimo";
    const label = (intent: string) => REPLY_INTENTS.find((entry) => entry.intent === intent)?.label ?? intent;

    if (body.action === "save") {
      const { saved, previous } = await saveTemplate(repository, { intent: body.intent, content: body.content }, actor);
      await logUnauthenticatedAction({
        action: "agent.reply.updated", entity: `reply-template:${saved.intent}`, result: "success", actor: guard.user,
        reason: `Resposta aprovada de "${label(saved.intent)}" alterada (versão ${saved.version}). Antes: ${excerpt(previous)}. Depois: ${excerpt(saved.content)}`,
      });
      return NextResponse.json({ ok: true, version: saved.version });
    }

    if (body.action === "reset") {
      const { intent, previous } = await resetTemplate(repository, body.intent);
      await logUnauthenticatedAction({
        action: "agent.reply.reset", entity: `reply-template:${intent}`, result: "success", actor: guard.user,
        reason: `Resposta aprovada de "${label(intent)}" voltou ao padrão. Edição descartada: ${excerpt(previous)}`,
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  } catch (error) {
    if (error instanceof ReplyTemplateValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Respostas indisponíveis: o banco não respondeu." }, { status: 503 });
  }
}
