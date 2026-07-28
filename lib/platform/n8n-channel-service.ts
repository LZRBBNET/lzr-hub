import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { auditEvents, channelIdempotencyKeys, channelMessages } from "../../db/schema.ts";
import { runAgentPipeline } from "../agent/pipeline.ts";
import type { ChatMessage } from "../agent/types.ts";
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

export interface ChannelMessageRow { role: "customer" | "agent"; content: string }
export interface ChannelResponse { response: string; status: string; handoff: boolean; correlationId: string }

export interface ChannelRepository {
  findIdempotent(idempotencyKey: string): Promise<ChannelResponse | undefined>;
  getHistory(channel: string, externalConversationId: string): Promise<ChannelMessageRow[]>;
  saveMessages(channel: string, externalConversationId: string, messages: ChannelMessageRow[]): Promise<void>;
  saveIdempotency(idempotencyKey: string, channel: string, externalConversationId: string, response: ChannelResponse): Promise<void>;
  audit(entry: { correlationId: string; entity: string; result: string; reason: string }): Promise<void>;
}

export interface ChannelMessageInput { externalConversationId: string; text: string; idempotencyKey: string; correlationId: string }

export async function processChannelMessage(
  repository: ChannelRepository,
  input: ChannelMessageInput,
  metrics?: SupportMetricsRepository,
): Promise<ChannelResponse> {
  const existing = await repository.findIdempotent(input.idempotencyKey);
  if (existing) return existing;

  const historyRows = await repository.getHistory(CHANNEL_NAME, input.externalConversationId);
  const history: ChatMessage[] = historyRows.slice(-MAX_HISTORY);

  const lastAgentMessage = [...historyRows].reverse().find((row) => row.role === "agent")?.content;
  const csatScore = isAwaitingCsat(lastAgentMessage) ? parseCsatScore(input.text) : null;

  // Resposta à pergunta de avaliação: registra a nota e encerra, sem acionar o pipeline.
  if (csatScore !== null) {
    await metrics?.saveRating({
      channel: CHANNEL_NAME,
      externalConversationId: input.externalConversationId,
      score: csatScore,
    });
    await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
      { role: "customer", content: input.text },
      { role: "agent", content: CSAT_THANKS },
    ]);
    const rated: ChannelResponse = {
      response: CSAT_THANKS,
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

  const result = runAgentPipeline(input.text, history, { channel: "whatsapp" });

  const askCsat = shouldAskCsat(result.finalStatus, result.handoff.required);
  const reply = askCsat ? `${result.response}\n\n${CSAT_QUESTION}` : result.response;

  await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
    { role: "customer", content: input.text },
    { role: "agent", content: reply },
  ]);

  const response: ChannelResponse = {
    response: reply,
    status: result.finalStatus,
    handoff: result.handoff.required,
    correlationId: input.correlationId,
  };

  await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, response);
  await repository.audit({
    correlationId: input.correlationId,
    entity: `conversation:${input.externalConversationId}`,
    result: result.finalStatus,
    reason: "Mensagem recebida via canal n8n/WhatsApp",
  });
  await metrics?.saveOutcome({
    channel: CHANNEL_NAME,
    externalConversationId: input.externalConversationId,
    intent: result.intent,
    finalStatus: result.finalStatus,
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
    return rows.map((row: { role: string; content: string }) => ({ role: row.role === "agent" ? "agent" : "customer", content: row.content }));
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
