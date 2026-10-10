import { MAX_TEXT_LENGTH, sendTextMessage, type MetaSendConfig } from "../integrations/meta/cloud-client.ts";
import type { ReplyRepository } from "./attendant-reply-service.ts";
import { isNonCustomerConversation } from "./conversation-scope.ts";
import type { ConversationStateRepository } from "./conversation-state-service.ts";
import { autoReplyUsed, botMayReply, windowOpen } from "./conversation-state-shared.ts";
import type { AutoReplyDelivery, AutoReplySender, ChannelOptions, ChannelRepository } from "./n8n-channel-service.ts";
import { containsHomologationText } from "./reply-templates-shared.ts";

/**
 * A IA responde ao cliente pela **Cloud API da Meta**, sozinha.
 *
 * Antes, com `FEATURE_N8N_AUTOREPLY` ligada, a rota da Meta gravava a resposta
 * como enviada e nenhuma chamada à Meta acontecia: o cliente não recebia e a
 * tela afirmava que ele tinha recebido. Agora a gravação segue o envio — o que
 * a Meta não aceitou fica como sugestão, e a falha vai para a auditoria.
 *
 * Mesma régua da resposta do atendente (`attendant-reply-service.ts`), na mesma
 * ordem: política → idempotência → chamada. A diferença é a chave: lá é o
 * clique, aqui é o `wamid` da fala do cliente — a Meta reentrega o webhook por
 * dias quando não recebe 200, e cada reentrega não pode virar outra mensagem.
 */

/** Separada da chave da fala (`wamid` cru) e da do atendente (`reply:`): mesma tabela, três coisas diferentes. */
export const AUTO_REPLY_CLAIM_PREFIX = "autoreply:";

/** A reserva é a mesma da resposta do atendente: `DbReplyRepository` serve aos dois. */
export type AutoReplyClaims = Pick<ReplyRepository, "claim" | "claimState" | "setClaimState" | "release">;

export interface MetaAutoReplyDeps {
  claims: AutoReplyClaims;
  /** `undefined` quando falta token ou id do número. */
  config: MetaSendConfig | undefined;
  channel: string;
  /** Quando o cliente escreveu, pelo relógio da Meta. Sem isso a janela de 24 horas não pode ser provada. */
  customerMessageAt: string | undefined;
  now?: () => number;
}

const blocked = (reason: string): AutoReplyDelivery => ({ sent: false, outcome: "blocked", reason });

export function metaAutoReplySender(deps: MetaAutoReplyDeps): AutoReplySender {
  const now = deps.now ?? Date.now;
  return async ({ conversationId, text, inboundMessageId }) => {
    // 1. Política. Nada daqui chega ao banco ou à Meta.
    const config = deps.config;
    if (!config) return blocked("O envio pela Meta não está configurado (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).");
    if (isNonCustomerConversation(conversationId) || !/^\d{10,15}$/.test(conversationId)) return blocked("A conversa não é de um número de cliente.");
    if (!text.trim() || text.length > MAX_TEXT_LENGTH) return blocked(`O texto está vazio ou passa de ${MAX_TEXT_LENGTH} caracteres.`);
    // As respostas aprovadas já recusam isso na edição; aqui é a última porta antes do cliente.
    if (containsHomologationText(text)) return blocked("O texto menciona homologação, simulação ou dado fictício.");
    // Webhook reentregue dias depois ainda chega: a janela conta da fala do cliente, não da chegada.
    if (!windowOpen(deps.customerMessageAt, now())) {
      return blocked(deps.customerMessageAt
        ? "Passaram mais de 24 horas desde a mensagem do cliente; a Meta só aceita texto livre dentro dessa janela."
        : "A hora da mensagem do cliente não veio no webhook, então não dá para provar que a janela de 24 horas está aberta.");
    }

    // 2. Idempotência pelo `wamid`, reservada **antes** de chamar a Meta.
    const key = `${AUTO_REPLY_CLAIM_PREFIX}${inboundMessageId}`;
    try {
      const previous = await deps.claims.claimState(key);
      // Já saiu numa entrega anterior que não chegou a gravar: registra o que saiu, sem reenviar.
      if (previous?.status === "sent") return { sent: true, messageId: previous.messageId, text: previous.text };
      if (previous) return blocked("Uma tentativa anterior de responder a esta mensagem não foi confirmada pela Meta; não reenvio para não duplicar.");
      if (!(await deps.claims.claim(key, deps.channel, conversationId))) return blocked("Outra entrega deste webhook já está respondendo a esta mensagem.");
    } catch {
      return { sent: false, outcome: "failed", reason: "Não consegui reservar o envio no banco; nada foi enviado." };
    }

    // 3. Chamada.
    const sent = await sendTextMessage(config, { to: conversationId, text });
    if (!sent.ok) {
      // Em timeout a mensagem pode ter saído: a reserva fica e barra a reentrega.
      // Nos demais casos a Meta recusou, e soltar é seguro.
      if (sent.kind === "timeout") await deps.claims.setClaimState(key, { status: "unknown" }).catch(() => undefined);
      else await deps.claims.release(key).catch(() => undefined);
      const detail = `${sent.reason} (${sent.kind}${sent.metaCode ? ` ${sent.metaCode}` : ""})`;
      return { sent: false, outcome: sent.kind === "timeout" ? "unknown" : "failed", reason: detail };
    }
    // A Meta já aceitou: falhar ao marcar a reserva não desfaz o envio.
    await deps.claims.setClaimState(key, { status: "sent", messageId: sent.messageId, text }).catch(() => undefined);
    return { sent: true, messageId: sent.messageId };
  };
}

/**
 * Se a IA responde sozinha a esta fala, e por onde. Ela só fala com a flag
 * ligada, sem humano à frente da conversa (`botMayReply`) e se ainda não
 * respondeu nesta espera (`autoReplyUsed`): é primeira resposta, não conversa.
 * Estado ou histórico ilegível contam como "não pode": na dúvida, sugere.
 */
export async function metaAutoReplyOptions(
  deps: MetaAutoReplyDeps & { enabled: boolean; states: ConversationStateRepository; messages: Pick<ChannelRepository, "getHistory"> },
  conversationId: string,
): Promise<Pick<ChannelOptions, "autoReply" | "send">> {
  if (!deps.enabled) return { autoReply: false };
  try {
    const row = await deps.states.get(deps.channel, conversationId);
    if (!botMayReply(row)) return { autoReply: false };
    const history = await deps.messages.getHistory(deps.channel, conversationId);
    if (autoReplyUsed(history, row?.status === "resolved" ? row.resolvedAt : null)) return { autoReply: false };
  } catch {
    return { autoReply: false };
  }
  return { autoReply: true, send: metaAutoReplySender(deps) };
}
