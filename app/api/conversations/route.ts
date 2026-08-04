import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbConversationsRepository } from "@/lib/platform/conversations-service";
import { CHANNEL_NAME } from "@/lib/platform/n8n-channel-service";
import { authorize } from "@/lib/platform/session-guard";

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
  const channelState = { enabled: channelEnabled, autoReply: channelEnabled && process.env.FEATURE_N8N_AUTOREPLY === "true" };

  try {
    const repository = new DbConversationsRepository(await getDb());
    if (id) {
      const messages = await repository.getMessages(channel, id, MESSAGE_LIMIT);
      return NextResponse.json({ available: true, channel, id, messages, channelState });
    }
    return NextResponse.json({ available: true, items: await repository.listConversations(LIST_LIMIT), channelState });
  } catch {
    return NextResponse.json({ available: false, detail: "Histórico de conversas indisponível", items: [], messages: [], channelState });
  }
}
