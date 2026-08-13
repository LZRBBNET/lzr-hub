import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { auditEvents, channelIdempotencyKeys, channelMessages } from "../../db/schema.ts";
import { runAgentPipeline } from "../agent/pipeline.ts";
import { classifyIntent, llmConfigFromEnv } from "../agent/llm-classifier.ts";
import type { ChatMessage } from "../agent/types.ts";
import { traceAgentResult } from "../observability/trace-agent-result.ts";
import {
  CSAT_QUESTION,
  CSAT_THANKS,
  isAwaitingCsat,
  parseCsatScore,
  shouldAskCsat,
  type SupportMetricsRepository,
} from "./support-metrics.ts";

export const CHANNEL_NAME = "n8n-whatsapp";
export const MAX_MESSAGE_LENGTH = 5000;
export const MAX_HISTORY = 40;

/**
 * Resposta que a IA produziu mas que ninguém enviou ao cliente. Fica gravada
 * com papel próprio para que a tela não a mostre como mensagem entregue e para
 * que o histórico do pipeline não a trate como turno da conversa.
 */
export const SUGGESTION_ROLE = "suggestion";
/** Desfecho de quem só sugeriu: nunca conta como atendimento resolvido. */
export const SUGGESTED_STATUS = "suggested";

export type ChannelRole = "customer" | "agent" | "suggestion";
export interface ChannelMessageRow { role: ChannelRole; content: string }
/**
 * `response` vem `null` quando a resposta automática está desligada — o fluxo do
 * n8n precisa checar `autoReply` antes de enviar qualquer coisa ao cliente.
 */
export interface ChannelResponse { response: string | null; autoReply: boolean; suggestion?: string; status: string; handoff: boolean; correlationId: string }
export interface ChannelOptions { autoReply: boolean }

export interface ChannelRepository {
  findIdempotent(idempotencyKey: string): Promise<ChannelResponse | undefined>;
  getHistory(channel: string, externalConversationId: string): Promise<ChannelMessageRow[]>;
  saveMessages(channel: string, externalConversationId: string, messages: ChannelMessageRow[]): Promise<void>;
  saveIdempotency(idempotencyKey: string, channel: string, externalConversationId: string, response: ChannelResponse): Promise<void>;
  audit(entry: { correlationId: string; entity: string; result: string; reason: string }): Promise<void>;
}

export interface ChannelMessageInput { externalConversationId: string; text: string; idempotencyKey: string; correlationId: string }

/**
 * Captação de lead (issue #17): chamada quando chega mensagem de quem **não é
 * cliente**. Injetada porque o canal não deve conhecer o CRM nem o IXC — e
 * porque os testes do canal precisam rodar sem nenhum dos dois.
 *
 * Nunca derruba o atendimento: registrar oportunidade comercial é secundário
 * diante de responder a quem escreveu.
 */
export type LeadCapture = (input: { contactKey: string; text: string }) => Promise<unknown>;

export async function processChannelMessage(
  repository: ChannelRepository,
  input: ChannelMessageInput,
  metrics?: SupportMetricsRepository,
  options: ChannelOptions = { autoReply: false },
  captureLead?: LeadCapture,
): Promise<ChannelResponse> {
  const existing = await repository.findIdempotent(input.idempotencyKey);
  if (existing) return existing;

  // Antes de qualquer coisa, e sem esperar: se for gente nova, o funil registra.
  // O `catch` é a regra — um CRM fora do ar não pode impedir o atendimento.
  if (captureLead) {
    await captureLead({ contactKey: input.externalConversationId, text: input.text }).catch(() => undefined);
  }

  const historyRows = await repository.getHistory(CHANNEL_NAME, input.externalConversationId);
  // Sugestão não é turno de conversa: o cliente nunca a viu, então ela não entra
  // no histórico que a IA usa para decidir o próximo passo.
  const history: ChatMessage[] = historyRows.filter((row) => row.role !== SUGGESTION_ROLE).slice(-MAX_HISTORY) as ChatMessage[];

  const lastAgentMessage = [...historyRows].reverse().find((row) => row.role === "agent")?.content;
  const csatScore = isAwaitingCsat(lastAgentMessage) ? parseCsatScore(input.text) : null;

  // Resposta à pergunta de avaliação: registra a nota e encerra, sem acionar o pipeline.
  if (csatScore !== null) {
    await metrics?.saveRating({
      channel: CHANNEL_NAME,
      externalConversationId: input.externalConversationId,
      score: csatScore,
    });
    // Mesmo o agradecimento é mensagem enviada ao cliente: com resposta
    // automática desligada, a nota é registrada e nada sai daqui.
    await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
      { role: "customer", content: input.text },
      { role: options.autoReply ? "agent" : SUGGESTION_ROLE, content: CSAT_THANKS },
    ]);
    const rated: ChannelResponse = {
      response: options.autoReply ? CSAT_THANKS : null,
      autoReply: options.autoReply,
      suggestion: options.autoReply ? undefined : CSAT_THANKS,
      status: "rated",
      handoff: false,
      correlationId: input.correlationId,
    };
    await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, rated);
    await repository.audit({
      correlationId: input.correlationId,
      entity: `conversation:${input.externalConversationId}`,
      result: `csat:${csatScore}`,
      reason: "Avaliação de atendimento recebida via canal n8n/WhatsApp",
    });
    return rated;
  }

  // Classifica antes de rodar o pipeline: sem chave configurada isto cai na
  // regex e o comportamento é idêntico ao de antes.
  const classified = await classifyIntent(input.text, llmConfigFromEnv());
  const result = runAgentPipeline(input.text, history, {
    channel: "whatsapp",
    intentOverride: { intent: classified.intent, confidence: classified.confidence },
  });
  await traceAgentResult(result, { channel: CHANNEL_NAME, correlationId: input.correlationId });

  // Só pede nota quando a resposta é de fato entregue — não dá para avaliar
  // um atendimento que o cliente não recebeu.
  const askCsat = options.autoReply && shouldAskCsat(result.finalStatus, result.handoff.required);
  const reply = askCsat ? `${result.response}\n\n${CSAT_QUESTION}` : result.response;

  await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
    { role: "customer", content: input.text },
    { role: options.autoReply ? "agent" : SUGGESTION_ROLE, content: reply },
  ]);

  const response: ChannelResponse = {
    response: options.autoReply ? reply : null,
    autoReply: options.autoReply,
    suggestion: options.autoReply ? undefined : reply,
    status: options.autoReply ? result.finalStatus : SUGGESTED_STATUS,
    handoff: result.handoff.required,
    correlationId: input.correlationId,
  };

  await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, response);
  await repository.audit({
    correlationId: input.correlationId,
    entity: `conversation:${input.externalConversationId}`,
    result: response.status,
    reason: options.autoReply
      ? "Mensagem recebida via canal n8n/WhatsApp"
      : "Mensagem recebida via canal n8n/WhatsApp; resposta apenas sugerida, não enviada",
  });
  await metrics?.saveOutcome({
    channel: CHANNEL_NAME,
    externalConversationId: input.externalConversationId,
    intent: result.intent,
    // Sem envio, o desfecho é "sugerido": não pode entrar na conta de resolvidos.
    finalStatus: response.status,
    handoff: result.handoff.required,
    handoffReason: result.handoff.reason,
    correlationId: input.correlationId,
  });

  return response;
}

export class D1ChannelRepository implements ChannelRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async findIdempotent(idempotencyKey: string): Promise<ChannelResponse | undefined> {
    const rows = await this.db.select().from(channelIdempotencyKeys).where(eq(channelIdempotencyKeys.idempotencyKey, idempotencyKey)).limit(1);
    return rows[0]?.responseJson as ChannelResponse | undefined;
  }
  async getHistory(channel: string, externalConversationId: string): Promise<ChannelMessageRow[]> {
    const rows = await this.db.select().from(channelMessages)
      .where(and(eq(channelMessages.channel, channel), eq(channelMessages.externalConversationId, externalConversationId)))
      .orderBy(asc(channelMessages.createdAt));
    return rows.map((row: { role: string; content: string }) => ({
      role: row.role === "agent" ? "agent" : row.role === SUGGESTION_ROLE ? SUGGESTION_ROLE : "customer",
      content: row.content,
    }));
  }
  async saveMessages(channel: string, externalConversationId: string, messages: ChannelMessageRow[]): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(channelMessages).values(messages.map((message) => ({
      id: randomUUID(), channel, externalConversationId, role: message.role, content: message.content, createdAt: now,
    })));
  }
  async saveIdempotency(idempotencyKey: string, channel: string, externalConversationId: string, response: ChannelResponse): Promise<void> {
    await this.db.insert(channelIdempotencyKeys).values({
      idempotencyKey, channel, externalConversationId, responseJson: response, createdAt: new Date().toISOString(),
    });
  }
  async audit(entry: { correlationId: string; entity: string; result: string; reason: string }): Promise<void> {
    await this.db.insert(auditEvents).values({
      id: randomUUID(), actorId: "n8n-channel", role: "system", action: "channel.message.processed",
      entity: entry.entity, beforeMasked: null, afterMasked: null, reason: entry.reason,
      correlationId: entry.correlationId, result: entry.result, origin: "ia", createdAt: new Date().toISOString(),
    });
  }
}

export class MemoryChannelRepository implements ChannelRepository {
  private readonly idempotencyStore = new Map<string, ChannelResponse>();
  private readonly messageStore: Array<ChannelMessageRow & { channel: string; externalConversationId: string }> = [];
  readonly audits: Array<{ correlationId: string; entity: string; result: string; reason: string }> = [];
  async findIdempotent(idempotencyKey: string) { return this.idempotencyStore.get(idempotencyKey); }
  async getHistory(channel: string, externalConversationId: string) {
    return this.messageStore.filter((m) => m.channel === channel && m.externalConversationId === externalConversationId).map(({ role, content }) => ({ role, content }));
  }
  async saveMessages(channel: string, externalConversationId: string, messages: ChannelMessageRow[]) {
    for (const message of messages) this.messageStore.push({ ...message, channel, externalConversationId });
  }
  async saveIdempotency(idempotencyKey: string, _channel: string, _externalConversationId: string, response: ChannelResponse) {
    this.idempotencyStore.set(idempotencyKey, response);
  }
  async audit(entry: { correlationId: string; entity: string; result: string; reason: string }) { this.audits.push(entry); }
}
