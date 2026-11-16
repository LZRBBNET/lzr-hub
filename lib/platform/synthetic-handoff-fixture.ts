import { assertSyntheticDemo } from '../integrations/ixc/synthetic-demo.ts';
import { CHANNEL_NAME } from './n8n-channel-service.ts';

export const SYNTHETIC_HANDOFF_ID = 'synthetic-demo-customer-10';
const CORRELATION = 'synthetic-handoff-fixture-v1';

/** Pure preparation. No DB/client, executor, network, actor, phone or delivery. */
export function prepareSyntheticHandoffFixture(source: Record<string, string | undefined>, now: Date) {
  assertSyntheticDemo(source);
  if (source.SYNTHETIC_DATABASE_CONFIRMATION !== 'isolated-synthetic-postgres-v1' || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('SYNTHETIC_HANDOFF_PREPARATION_BLOCKED');
  const at = now.toISOString();
  const message = { id: 'synthetic-handoff-message-v1', channel: CHANNEL_NAME,
    externalConversationId: SYNTHETIC_HANDOFF_ID, role: 'customer' as const,
    content: 'DEMO: sou o cliente fictício 10. Quero falar com um atendente humano sobre a fatura fictícia 901.',
    correlationId: CORRELATION, createdAt: at };
  const contact = { channel: CHANNEL_NAME, externalConversationId: SYNTHETIC_HANDOFF_ID,
    displayName: 'DEMO Cliente fictício 10', updatedAt: at };
  const outcome = { id: 'synthetic-handoff-outcome-v1', channel: CHANNEL_NAME,
    externalConversationId: SYNTHETIC_HANDOFF_ID, intent: 'human_handoff', finalStatus: 'handoff',
    handoff: true, handoffReason: 'customer_requested_human', intentSource: 'synthetic-fixture',
    correlationId: CORRELATION, createdAt: at };
  return {
    synthetic: true, executionAuthorized: false, externalDelivery: false, databaseReset: false,
    message, contact, outcome,
    statements: [
      { sql: `INSERT INTO channel_contacts (channel,external_conversation_id,display_name,updated_at)
        VALUES ($1,$2,$3,$4) ON CONFLICT (channel,external_conversation_id) DO NOTHING`,
        values: [contact.channel, contact.externalConversationId, contact.displayName, at] },
      { sql: `INSERT INTO channel_messages (id,channel,external_conversation_id,role,content,correlation_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        values: [message.id, message.channel, message.externalConversationId, message.role, message.content, CORRELATION, at] },
      { sql: `INSERT INTO conversation_outcomes (id,channel,external_conversation_id,intent,final_status,handoff,handoff_reason,intent_source,correlation_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        values: [outcome.id, outcome.channel, outcome.externalConversationId, outcome.intent, outcome.finalStatus,
          true, outcome.handoffReason, outcome.intentSource, CORRELATION, at] },
    ],
    warning: 'Plano aditivo não executado. Preserva estado/responsável/histórico existentes. Conferir colisões e alvo antes de transação dedicada; conflito não prova fixture correta.',
  };
}
