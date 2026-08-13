import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { DbConversationsRepository } from "@/lib/platform/conversations-service";
import { DbKnowledgeRepository } from "@/lib/platform/knowledge-service";
import { CHANNEL_NAME } from "@/lib/platform/n8n-channel-service";
import { askCopilot, copilotLlmConfigFromEnv, intentTerms, lastQuestionFrom, summarizeConversation } from "@/lib/platform/copilot-service";
import { authorize } from "@/lib/platform/session-guard";

const KNOWLEDGE_LIMIT = 200;
const MESSAGE_LIMIT = 200;
const MAX_QUESTION = 600;

/**
 * Copiloto do atendente (issue #11).
 *
 * Exige `customer.read`: quem não pode ver cliente não pode pedir resumo de
 * conversa de cliente. A base de conhecimento **não é segmentada por perfil** —
 * todo documento publicado é visível a quem tem essa permissão. Isso é um limite
 * real, não um esquecimento: não existe hoje conceito de documento restrito.
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  const action = typeof body.action === "string" ? body.action : "";
  const channel = typeof body.channel === "string" && body.channel.trim() ? body.channel.trim() : CHANNEL_NAME;
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";

  try {
    if (action === "ask" || action === "suggest") {
      let question = typeof body.question === "string" ? body.question.trim() : "";
      let hint = "";

      if (action === "suggest") {
        // A sugestão parte da última fala do cliente, lida do banco. Aceitar o
        // texto do navegador deixaria a tela escolher sobre o que a IA responde.
        if (!conversationId) return NextResponse.json({ error: "Informe a conversa" }, { status: 400 });
        const repository = new DbConversationsRepository(await getDb());
        const [messages, outcome] = await Promise.all([
          repository.getMessages(channel, conversationId, MESSAGE_LIMIT),
          repository.getOutcome(channel, conversationId),
        ]);
        const lastQuestion = lastQuestionFrom(messages);
        if (!lastQuestion) {
          return NextResponse.json({
            error: "Nenhuma fala do cliente aqui tem conteúdo para responder — a última é saudação ou nota de avaliação. Use o campo de pergunta.",
          }, { status: 400 });
        }
        question = lastQuestion;
        // O cliente escreve "ta sem net"; o documento se chama "sem conexão". A
        // intenção já classificada é a ponte entre os dois vocabulários.
        hint = intentTerms(outcome?.intent);
      }

      if (question.length < 3) return NextResponse.json({ error: "Escreva a pergunta" }, { status: 400 });
      const documents = await new DbKnowledgeRepository(await getDb()).list(KNOWLEDGE_LIMIT);
      const answer = await askCopilot(documents, question.slice(0, MAX_QUESTION), copilotLlmConfigFromEnv(), hint);
      return NextResponse.json({ available: true, ...answer, question: action === "suggest" ? question.slice(0, MAX_QUESTION) : undefined });
    }

    if (action === "summary") {
      if (!conversationId) return NextResponse.json({ error: "Informe a conversa" }, { status: 400 });
      const repository = new DbConversationsRepository(await getDb());
      const [messages, outcome] = await Promise.all([
        repository.getMessages(channel, conversationId, MESSAGE_LIMIT),
        repository.getOutcome(channel, conversationId),
      ]);
      return NextResponse.json({ available: true, summary: summarizeConversation({ externalConversationId: conversationId, messages, outcome }) });
    }

    if (action === "used") {
      // "Usada" é o que dá para afirmar: o atendente copiou o texto. Enviar pela
      // tela ainda não existe, então dizer "enviada" seria registrar o que não
      // aconteceu. O texto em si não entra na auditoria — ele carrega a fala do
      // cliente, e a auditoria é lida por quem não estava no atendimento.
      const kind = body.kind === "summary" ? "resumo" : "sugestão de resposta";
      await logUnauthenticatedAction({
        action: "copilot.suggestion.used",
        entity: conversationId ? `conversation:${conversationId}` : "copilot",
        result: "success",
        reason: `Atendente copiou ${kind} do copiloto (conteúdo não registrado; o envio ao cliente não é feito pela tela)`,
        actor: guard.user,
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  } catch {
    // Sem banco não há base de conhecimento nem histórico. Dizer isso é melhor
    // que responder de cabeça — que é exatamente o que o copiloto não faz.
    return NextResponse.json({ available: false, detail: "Copiloto indisponível: a base de conhecimento não respondeu." }, { status: 503 });
  }
}
