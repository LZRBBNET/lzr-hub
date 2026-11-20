import { explicitHumanHandoff, requestsHuman } from "@/lib/platform/explicit-human-handoff";
import { processMetaBatch } from "@/lib/platform/meta-batch-service";
import { DbConversationFence } from "@/lib/platform/conversation-fence";
import { DbConversationDelivery } from "@/lib/platform/conversation-delivery-service";
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
import { metaAutoReplyOptions, metaAutoReplySender } from "@/lib/platform/meta-auto-reply-service";
import { metaSendConfigFromEnv } from "@/lib/integrations/meta/cloud-client";
import { DbOutboundRepository } from "@/lib/platform/outbound-service";
import { OPT_IN_REPLY, OPT_OUT_REPLY, canonicalPhone, isOptIn, isOptOut } from "@/lib/platform/outbound-shared";
import { fetchPixCode } from "@/lib/integrations/ixc/write-client";
import { DbTicketRepository, ixcDiagnose, ixcInvoiceLookup, startTriage } from "@/lib/platform/triage-service";
import { DbIncidentsRepository } from "@/lib/platform/incidents-service";
import { isBusinessHours } from "@/lib/platform/triage-shared";
import { doubtBotAnswerer, doubtBotConfigFromEnv } from "@/lib/platform/doubt-bot-service";
import { DbKnowledgeRepository } from "@/lib/platform/knowledge-service";
import { openAiServiceOrder } from "@/lib/platform/ai-service-order";
import { DbIxcWriteOperationsRepository } from "@/lib/platform/ixc-write-service";
import { openServiceOrder, trustUnlock } from "@/lib/integrations/ixc/write-client";
import { aiTrustUnlock } from "@/lib/platform/ai-trust-unlock";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";

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
/** A IA manda vencimento, valor e linha digitável ao cliente. Nasce desligada, como toda flag com efeito no mundo. */
const aiInvoiceEnabled = () => process.env.FEATURE_AI_INVOICE === "true";
/**
 * Fora do horário comercial (seg–sex, 8h–12h e 14h–18h) a IA responde sozinha:
 * lista de assuntos, respostas aprovadas e autoatendimento. Dentro do horário,
 * só com `FEATURE_N8N_AUTOREPLY`. Nasce desligada como toda flag com efeito no mundo.
 */
const offHoursAutoReplyEnabled = () => process.env.FEATURE_OFF_HOURS_AUTOREPLY === "true";
/**
 * Modo autônomo: a IA atende sozinha, a qualquer hora, e conduz a conversa — responde
 * cada fala pela base de conhecimento (n8n), roda os autoatendimentos e só passa para o
 * atendente o que exige gente. Precisa do n8n configurado (`N8N_BOT_URL`/`N8N_BOT_SECRET`):
 * sem ele, a flag não liga nada — respostas fixas a cada fala seriam piores que o modo atual.
 */
/**
 * A IA abre a OS no IXC sozinha quando o pedido técnico fica pronto (modo autônomo). Também
 * exige `FEATURE_IXC_WRITE`. Nasce desligada: abre chamado real na fila da equipe técnica.
 */
const aiServiceOrderEnabled = () => process.env.FEATURE_AI_SERVICE_ORDER === "true";
/** A IA libera a internet em confiança pela regra da BBNET. Também exige `FEATURE_IXC_WRITE`. Nasce desligada. */
const aiTrustUnlockEnabled = () => process.env.FEATURE_AI_TRUST_UNLOCK === "true";
const aiAgentConfig = () => (process.env.FEATURE_AI_AGENT === "true" ? doubtBotConfigFromEnv() : undefined);

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
  const sendConfig = metaSendConfigFromEnv();

  const results: unknown[] = [];
  const batch = await processMetaBatch(messages, async (message) => {
    const correlationId = randomUUID();
    const turn = await new DbConversationFence(db).capture(CHANNEL_NAME,message.phone,message.messageId,message.sentAt);
    const tickets = new DbTicketRepository(db,turn);
    if (message.kind === "text" && message.text.length <= MAX_MESSAGE_LENGTH && requestsHuman(message.text,message.interactiveReplyId)) {
      results.push(await explicitHumanHandoff({channel,tickets,
        send:metaAutoReplySender({claims:new DbReplyRepository(db),delivery:new DbConversationDelivery(db),turn,config:sendConfig,channel:CHANNEL_NAME,customerMessageAt:message.sentAt})},
        {conversationId:message.phone,text:message.text,inboundMessageId:message.messageId,correlationId}));
      return;
    }
    const templates = message.kind === "text" ? await loadOverrides(new DbReplyTemplatesRepository(db)) : undefined;
    const lookupCustomer = async (phone: string) => {
      const runtime = getIxcRuntime();
      if (!runtime.provider) throw new Error("IXC indisponível");
      const customer = await runtime.provider.findCustomerByPhone(phone, correlationId);
      return customer ? { id: customer.id } : undefined;
    };
    // Atendimento, protocolo e cliente identificado — uma consulta ao IXC por
    // atendimento, que a captação de lead aproveita em vez de repetir.
    const { provider, config: ixcConfig } = getIxcRuntime();
    const offHours = !isBusinessHours(new Date());
    const agentConfig = aiAgentConfig();
    const botSpeaks = !!agentConfig || autoReplyEnabled() || (offHoursAutoReplyEnabled() && offHours);
    // Robô de dúvidas (n8n): no modo autônomo, sempre; senão, só no horário comercial e só quando a IA não fala por outro caminho.
    const doubtBotConfig = agentConfig ?? (!botSpeaks && !offHours ? doubtBotConfigFromEnv() : undefined);
    const triage = await startTriage(tickets, {
      offHours: offHours && botSpeaks,
      // Modo autônomo: o diagnóstico vira dado para a IA conduzir o suporte, antes da resposta.
      agent: !!agentConfig,
      // Pedido técnico pronto vira OS no IXC — com auditoria de cada tentativa, inclusive a bloqueada.
      serviceOrder: agentConfig && provider ? async (input) => {
        const result = await openAiServiceOrder({
          enabled: aiServiceOrderEnabled(), provider, ledger: new DbIxcWriteOperationsRepository(db), correlationId,
          open: (order, corr) => openServiceOrder({ baseUrl: ixcConfig.ixcBaseUrl!, token: ixcConfig.ixcToken! }, order, corr),
        }, input);
        if (result && result.status !== "skipped") {
          await logUnauthenticatedAction({
            action: "ixc.write.service_order_open", entity: `customer:${input.customerId}`, result: result.status, correlationId, actorNotApplicable: true,
            reason: `OS pela IA (modo autônomo${input.protocol ? `, protocolo ${input.protocol}` : ""}): ${result.detail}`,
          }).catch(() => undefined);
        }
        return result;
      } : undefined,
      trustUnlock: agentConfig && provider ? async (input) => {
        const outcome = await aiTrustUnlock({
          enabled: aiTrustUnlockEnabled(), provider, ledger: new DbIxcWriteOperationsRepository(db), correlationId,
          unlock: (contractId, corr) => trustUnlock({ baseUrl: ixcConfig.ixcBaseUrl!, token: ixcConfig.ixcToken! }, contractId, corr),
        }, input);
        if (outcome.status !== "needs_cpf" && outcome.status !== "skipped") {
          await logUnauthenticatedAction({
            action: "ixc.write.trust_unlock", entity: `customer:${input.customerId}`, result: outcome.status, correlationId, actorNotApplicable: true,
            reason: `Desbloqueio de confiança pela IA: ${outcome.status}${"reason" in outcome && outcome.reason ? ` (${outcome.reason})` : ""}`,
          }).catch(() => undefined);
        }
        return outcome;
      } : undefined,
      channel: CHANNEL_NAME, conversationId: message.phone, lookup: lookupCustomer,
      // Atendimento técnico de cliente identificado ganha diagnóstico (contrato, login, massiva, OS aberta).
      diagnose: provider ? ixcDiagnose(provider, new DbIncidentsRepository(db), correlationId) : undefined,
      // Segunda via: confere o titular pelo CPF. Os dados da fatura só saem pela IA com FEATURE_AI_INVOICE.
      invoice: provider ? {
        lookup: ixcInvoiceLookup(provider, correlationId, (invoiceId, corr) => fetchPixCode({ baseUrl: ixcConfig.ixcBaseUrl!, token: ixcConfig.ixcToken! }, invoiceId, corr)),
        sendData: aiInvoiceEnabled(),
      } : undefined,
    });
    // `wamid` é a chave de idempotência: a Meta reenvia o webhook quando não
    // recebe 200, e sem isso a reentrega viraria atendimento em dobro.
    if (message.kind === "text") {
      if (message.text.length > MAX_MESSAGE_LENGTH) { results.push({ ignored: true, reason: "mensagem-longa" }); return; }
      // SAIR / VOLTAR: descadastro dos avisos automáticos de fatura e rede. Não é atendimento — a IA
      // não entra, e o atendimento pelo WhatsApp continua. Reentrega do webhook não responde duas vezes.
      if (isOptOut(message.text) || isOptIn(message.text)) {
        const out = isOptOut(message.text);
        if (!(await channel.findIdempotent(message.messageId))) {
          await new DbOutboundRepository(db).setOptOut(canonicalPhone(message.phone), out, "whatsapp").catch(() => undefined);
          const reply = out ? OPT_OUT_REPLY : OPT_IN_REPLY;
          const sent = await metaAutoReplySender({claims:new DbReplyRepository(db),delivery:new DbConversationDelivery(db),turn,
            config:sendConfig,channel:CHANNEL_NAME,customerMessageAt:message.sentAt})({conversationId:message.phone,text:reply,inboundMessageId:message.messageId});
          await channel.saveMessages(CHANNEL_NAME, message.phone, [
            { role: "customer", content: message.text, correlationId, externalMessageId: message.messageId },
            { role: sent.sent ? "agent" : "suggestion", content: reply, correlationId, ...(sent.sent ? { externalMessageId: sent.messageId, sentBy: "ia" } : {}) },
          ]);
          await channel.saveIdempotency(message.messageId, CHANNEL_NAME, message.phone, { response: sent.sent ? reply : null, autoReply: !!sent.sent, status: out ? "opted_out" : "opted_in", handoff: false, correlationId });
        }
        results.push({ status: out ? "opted_out" : "opted_in" });
        return;
      }
      // Com um humano à frente da conversa a IA só sugere: não responde por cima dele.
      // Quando responde, é pela Cloud API, e só fica gravado como enviado o que a Meta aceitou.
      // O robô de dúvidas usa as mesmas travas (humano, uma por espera, janela de 24 horas, idempotência).
      const auto = await metaAutoReplyOptions({
        enabled: botSpeaks || !!doubtBotConfig, states: new DbConversationStateRepository(db), messages: channel, claims: new DbReplyRepository(db),
        delivery: new DbConversationDelivery(db), turn, config: sendConfig, channel: CHANNEL_NAME, customerMessageAt: message.sentAt,
        awaitingAnswer: triage?.awaitingAnswer,
        // Modo autônomo: conversa inteira, até um humano assumir.
        conversational: !!agentConfig,
      }, message.phone);
      results.push(await processChannelMessage(
        channel,
        { externalConversationId: message.phone, text: message.text, idempotencyKey: message.messageId, correlationId },
        new DbSupportMetricsRepository(db),
        {
          // Com o robô de dúvidas ligado e a IA sem falar por outro caminho, `send` é só do robô: o resto segue como sugestão.
          ...(botSpeaks ? auto : { autoReply: false }),
          doubtBot: doubtBotConfig && auto.autoReply && auto.send
            ? { send: auto.send, answer: doubtBotAnswerer(doubtBotConfig, () => new DbKnowledgeRepository(db).list(200)), agent: !!agentConfig, handedOff: triage?.handedOff }
            : undefined,
          templates,
          handoffRecorded: triage?.handedOff,
          triage: triage?.hooks,
        },
        (input) => captureLeadFromContact(new DbCrmRepository(db), input, triage?.knownCustomer ?? lookupCustomer),
      ));
    } else {
      results.push(await recordUnsupportedMessage(channel, {
        externalConversationId: message.phone, idempotencyKey: message.messageId, correlationId, kind: message.kind, caption: message.caption,
      }));
    }
    await rememberContactName(new DbContactsRepository(db), CHANNEL_NAME, message.phone, message.profileName);
  });

  return NextResponse.json({ results, statuses: updated, retryRequired: batch.failed > 0, failed: batch.failed }, { status: batch.failed ? 503 : 200 });
}
