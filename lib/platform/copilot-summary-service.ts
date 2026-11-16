import type { ConversationsRepository } from "./conversations-service.ts";
import type { ConversationStateRepository } from "./conversation-state-service.ts";
import { effectiveState } from "./conversation-state-shared.ts";
import { summarizeConversation } from "./copilot-service.ts";

export const SUMMARY_MESSAGE_LIMIT = 200;

/** Leitura somente no servidor: motivo, contexto e responsável nunca vêm do navegador. */
export async function loadConversationSummary(
  conversations: Pick<ConversationsRepository, "getMessages" | "getAudit">,
  states: Pick<ConversationStateRepository, "get" | "lastCustomerAt">,
  channel: string,
  conversationId: string,
): Promise<string> {
  const [messages, outcome, state, lastCustomerAt] = await Promise.all([
    conversations.getMessages(channel, conversationId, SUMMARY_MESSAGE_LIMIT + 1),
    conversations.getAudit(channel, conversationId),
    states.get(channel, conversationId),
    states.lastCustomerAt(channel, conversationId),
  ]);
  return summarizeConversation({
    externalConversationId: conversationId,
    messages: messages.slice(-SUMMARY_MESSAGE_LIMIT),
    outcome,
    state: effectiveState(state, lastCustomerAt),
    historyTruncated: messages.length > SUMMARY_MESSAGE_LIMIT,
  });
}
