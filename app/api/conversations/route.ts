import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbConversationsRepository, replyWindowFrom } from "@/lib/platform/conversations-service";
import { metaSendConfigFromEnv } from "@/lib/integrations/meta/cloud-client";
import { REPLY_WINDOW_MS, attendantReplyEnabled } from "@/lib/platform/attendant-reply-service";
import { CHANNEL_NAME } from "@/lib/platform/n8n-channel-service";
import { authEnforced, authorize } from "@/lib/platform/session-guard";

const LIST_LIMIT = 40;
const MESSAGE_LIMIT = 200;

/**
 * Conversas reais gravadas pelos canais. Sem banco disponível a resposta diz
 * `available: false` — a tela mostra indisponível em vez de conversa inventada.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const channel = url.searchParams.get("channel") ?? CHANNEL_NAME;
  const channelEnabled = process.env.FEATURE_N8N_CHANNEL === "true";
  // A tela precisa saber se a IA está respondendo sozinha para não deixar o
  // atendente supor que a sugestão que ele lê já foi entregue.
  // `canReply` é o que habilita o campo de resposta: flag ligada, token e número
  // configurados e login exigido — sem autor identificado o envio é recusado, e
  // um campo ativo que sempre falha seria pior que um campo desabilitado.
  const channelState = {
    enabled: channelEnabled,
    autoReply: channelEnabled && process.env.FEATURE_N8N_AUTOREPLY === "true",
    canReply: attendantReplyEnabled() && authEnforced() && Boolean(metaSendConfigFromEnv()),
  };

  try {
    const repository = new DbConversationsRepository(await getDb());
    if (id) {
      const [messages, audit] = await Promise.all([
        repository.getMessages(channel, id, MESSAGE_LIMIT),
        // A ficha de auditoria vem junto: quem abre a conversa para entender o
        // que aconteceu não deveria precisar de uma segunda tela.
        repository.getAudit(channel, id).catch(() => undefined),
      ]);
      // A janela de 24 horas vem daqui, com a mesma régua do envio: a tela avisa
      // antes, em vez de deixar o atendente escrever para receber uma recusa.
      return NextResponse.json({ available: true, channel, id, messages, audit: audit ?? null, channelState, replyWindow: replyWindowFrom(messages, REPLY_WINDOW_MS) });
    }
    return NextResponse.json({ available: true, items: await repository.listConversations(LIST_LIMIT, url.searchParams.get("q")), channelState });
  } catch {
    return NextResponse.json({ available: false, detail: "Histórico de conversas indisponível", items: [], messages: [], channelState });
  }
}
