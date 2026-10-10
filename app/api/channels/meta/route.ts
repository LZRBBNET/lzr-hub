import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { CHANNEL_NAME, D1ChannelRepository, MAX_MESSAGE_LENGTH, processChannelMessage, recordUnsupportedMessage } from "@/lib/platform/n8n-channel-service";
import { DbContactsRepository, rememberContactName } from "@/lib/platform/channel-contacts";
import { DbDeliveryRepository, applyStatuses } from "@/lib/platform/delivery-status-service";
import { DbReplyTemplatesRepository, loadOverrides } from "@/lib/platform/reply-templates-service";
import { DbSupportMetricsRepository } from "@/lib/platform/support-metrics";
import { DbCrmRepository, captureLeadFromContact } from "@/lib/platform/crm-service";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { parseMetaMessages, parseMetaStatuses, parseMetaWebhook, signatureIsValid } from "@/lib/integrations/meta/webhook-parser";
import { DbConversationStateRepository } from "@/lib/platform/conversation-state-service";
import { DbReplyRepository } from "@/lib/platform/attendant-reply-service";
import { metaAutoReplyOptions } from "@/lib/platform/meta-auto-reply-service";
import { metaSendConfigFromEnv } from "@/lib/integrations/meta/cloud-client";

/**
 * Webhook oficial do **WhatsApp Business Platform (Cloud API)**.
 *
 * Substitui o caminho da Evolution/Baileys, que é não oficial e fez a Meta
 * avisar que a conta poderia ser restringida. Tudo depois do webhook é o mesmo
 * pipeline já testado: classificação, sugestão, captação de lead, métricas.
 *
 * `FEATURE_META_WHATSAPP` liga esta rota. A flag existia no `.env` desde o
 * início do projeto sem nada por trás; agora tem.
 */
const metaEnabled = () => process.env.FEATURE_META_WHATSAPP === "true";
const autoReplyEnabled = () => process.env.FEATURE_N8N_AUTOREPLY === "true";

/**
 * Verificação do webhook: a Meta chama com `hub.challenge` e espera o valor de
 * volta, cru. É o handshake que prova que a URL é nossa.
 *
 * ⚠️ O `hub.verify_token` é escolhido por você no painel da Meta e conferido
 * aqui. Ele **não** é o segredo que protege as mensagens — esse é a assinatura
 * do POST. Confundir os dois deixaria o webhook aberto.
 */
export async function GET(request: Request) {
  if (!metaEnabled()) return NextResponse.json({ error: "Canal Meta desativado" }, { status: 503 });
  const url = new URL(request.url);
  const verifyToken = process.env.META_VERIFY_TOKEN?.trim();
  if (!verifyToken) return NextResponse.json({ error: "META_VERIFY_TOKEN não configurado" }, { status: 503 });

  if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === verifyToken) {
    // Texto puro, não JSON: a Meta compara o corpo com o desafio que enviou.
    return new Response(url.searchParams.get("hub.challenge") ?? "", {
      status: 200, headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.json({ error: "Verificação recusada" }, { status: 403 });
}

export async function POST(request: Request) {
  if (!metaEnabled()) return NextResponse.json({ error: "Canal Meta desativado" }, { status: 503 });
  const appSecret = process.env.META_APP_SECRET?.trim();
  // Sem segredo não dá para verificar assinatura — e aceitar sem verificar
  // deixaria qualquer um postar mensagem de cliente na nossa fila.
  if (!appSecret) return NextResponse.json({ error: "META_APP_SECRET não configurado" }, { status: 503 });

  // O corpo precisa ser lido cru: a assinatura é sobre os bytes exatos, e
  // reserializar o JSON muda espaçamento e ordem, quebrando o HMAC.
  const rawBody = await request.text();
  if (!signatureIsValid(rawBody, request.headers.get("x-hub-signature-256"), appSecret)) {
    return NextResponse.json({ error: "Assinatura inválida" }, { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "Corpo inválido" }, { status: 400 }); }

  // Um POST pode trazer várias mensagens e recibos de entrega juntos. Ler só o
  // primeiro item, como antes, perdia o resto em silêncio.
  const messages = parseMetaMessages(payload);
  const statuses = parseMetaStatuses(payload);
  if (messages.length === 0 && statuses.length === 0) {
    // Evento ignorado responde 200: a Meta reenvia o que não recebe 200, e um
    // evento recusado viraria reentrega infinita de algo que não queremos processar.
    const parsed = parseMetaWebhook(payload);
    return NextResponse.json({ ignored: true, reason: parsed.ok ? "sem-mensagem" : parsed.skip });
  }

  const db = await getDb();
  const channel = new D1ChannelRepository(db);
  const updated = statuses.length > 0 ? await applyStatuses(new DbDeliveryRepository(db), statuses) : 0;
  const templates = messages.some((message) => message.kind === "text") ? await loadOverrides(new DbReplyTemplatesRepository(db)) : undefined;
  const sendConfig = metaSendConfigFromEnv();

  const results = [];
  for (const message of messages) {
    const correlationId = randomUUID();
    // `wamid` é a chave de idempotência: a Meta reenvia o webhook quando não
    // recebe 200, e sem isso a reentrega viraria atendimento em dobro.
    if (message.kind === "text") {
      if (message.text.length > MAX_MESSAGE_LENGTH) { results.push({ ignored: true, reason: "mensagem-longa" }); continue; }
      results.push(await processChannelMessage(
        channel,
        { externalConversationId: message.phone, text: message.text, idempotencyKey: message.messageId, correlationId },
        new DbSupportMetricsRepository(db),
        // Com um humano à frente da conversa a IA só sugere: não responde por cima dele.
        // Quando responde, é pela Cloud API, e só fica gravado como enviado o que a Meta aceitou.
        {
          ...await metaAutoReplyOptions({
            enabled: autoReplyEnabled(), states: new DbConversationStateRepository(db), messages: channel, claims: new DbReplyRepository(db),
            config: sendConfig, channel: CHANNEL_NAME, customerMessageAt: message.sentAt,
          }, message.phone),
          templates,
        },
        (input) => captureLeadFromContact(
          new DbCrmRepository(db),
          input,
          async (contactPhone) => {
            const runtime = getIxcRuntime();
            if (!runtime.provider) throw new Error("IXC indisponível");
            return runtime.provider.findCustomerByPhone(contactPhone, correlationId);
          },
        ),
      ));
    } else {
      results.push(await recordUnsupportedMessage(channel, {
        externalConversationId: message.phone, idempotencyKey: message.messageId, correlationId, kind: message.kind, caption: message.caption,
      }));
    }
    await rememberContactName(new DbContactsRepository(db), CHANNEL_NAME, message.phone, message.profileName);
  }

  return NextResponse.json({ results, statuses: updated });
}
