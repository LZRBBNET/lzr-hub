import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { channelMessages, conversationOutcomes } from "../../db/schema.ts";

/**
 * Conversas reais recebidas pelos canais (hoje só o n8n/WhatsApp). Nada aqui é
 * sintético: se não houver conversa gravada, a lista volta vazia e a tela diz isso.
 */
export interface ConversationSummary {
  channel: string;
  externalConversationId: string;
  lastMessage: string;
  lastRole: "customer" | "agent";
  lastAt: string;
  messages: number;
  /** Último desfecho registrado pelo pipeline, quando existe. */
  finalStatus?: string;
  intent?: string;
  handoff?: boolean;
}

export interface ConversationMessage { role: "customer" | "agent"; content: string; createdAt: string }

export interface ConversationsRepository {
  listConversations(limit: number): Promise<ConversationSummary[]>;
  getMessages(channel: string, externalConversationId: string, limit: number): Promise<ConversationMessage[]>;
}

const role = (value: string): "customer" | "agent" => (value === "agent" ? "agent" : "customer");

export class DbConversationsRepository implements ConversationsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async listConversations(limit: number): Promise<ConversationSummary[]> {
    const grouped = await this.db.select({
      channel: channelMessages.channel,
      externalConversationId: channelMessages.externalConversationId,
      lastAt: sql<string>`max(${channelMessages.createdAt})`.as("last_at"),
      messages: sql<number>`count(*)`.as("messages"),
    }).from(channelMessages)
      .groupBy(channelMessages.channel, channelMessages.externalConversationId)
      .orderBy(desc(sql`max(${channelMessages.createdAt})`))
      .limit(limit);
    if (grouped.length === 0) return [];

    const ids = grouped.map((row: { externalConversationId: string }) => row.externalConversationId);
    // Última mensagem e último desfecho de cada conversa, em duas consultas só —
    // a redução por conversa acontece aqui e não por chamada dentro do laço.
    const [recent, outcomes] = await Promise.all([
      this.db.select({
        externalConversationId: channelMessages.externalConversationId,
        role: channelMessages.role,
        content: channelMessages.content,
        createdAt: channelMessages.createdAt,
      }).from(channelMessages)
        .where(inArray(channelMessages.externalConversationId, ids))
        .orderBy(desc(channelMessages.createdAt)),
      this.db.select({
        externalConversationId: conversationOutcomes.externalConversationId,
        intent: conversationOutcomes.intent,
        finalStatus: conversationOutcomes.finalStatus,
        handoff: conversationOutcomes.handoff,
        createdAt: conversationOutcomes.createdAt,
      }).from(conversationOutcomes)
        .where(inArray(conversationOutcomes.externalConversationId, ids))
        .orderBy(desc(conversationOutcomes.createdAt)),
    ]);

    const lastMessage = new Map<string, { role: string; content: string }>();
    for (const row of recent) if (!lastMessage.has(row.externalConversationId)) lastMessage.set(row.externalConversationId, row);
    const lastOutcome = new Map<string, { intent: string; finalStatus: string; handoff: boolean }>();
    for (const row of outcomes) if (!lastOutcome.has(row.externalConversationId)) lastOutcome.set(row.externalConversationId, row);

    return grouped.map((row: { channel: string; externalConversationId: string; lastAt: string; messages: number }) => {
      const last = lastMessage.get(row.externalConversationId);
      const outcome = lastOutcome.get(row.externalConversationId);
      return {
        channel: row.channel,
        externalConversationId: row.externalConversationId,
        lastMessage: last?.content ?? "",
        lastRole: role(last?.role ?? "customer"),
        lastAt: row.lastAt,
        messages: Number(row.messages),
        finalStatus: outcome?.finalStatus,
        intent: outcome?.intent,
        handoff: outcome?.handoff,
      };
    });
  }

  async getMessages(channel: string, externalConversationId: string, limit: number): Promise<ConversationMessage[]> {
    const rows = await this.db.select({
      role: channelMessages.role,
      content: channelMessages.content,
      createdAt: channelMessages.createdAt,
    }).from(channelMessages)
      .where(and(eq(channelMessages.channel, channel), eq(channelMessages.externalConversationId, externalConversationId)))
      .orderBy(desc(channelMessages.createdAt))
      .limit(limit);
    return rows.map((row: { role: string; content: string; createdAt: string }) => ({
      role: role(row.role), content: row.content, createdAt: row.createdAt,
    })).reverse();
  }
}

export class MemoryConversationsRepository implements ConversationsRepository {
  readonly rows: Array<{ channel: string; externalConversationId: string; role: "customer" | "agent"; content: string; createdAt: string }> = [];
  add(row: { channel: string; externalConversationId: string; role: "customer" | "agent"; content: string; createdAt: string }) { this.rows.push(row); }
  async listConversations(limit: number): Promise<ConversationSummary[]> {
    const byId = new Map<string, ConversationSummary>();
    for (const row of [...this.rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const key = `${row.channel}:${row.externalConversationId}`;
      const current = byId.get(key);
      byId.set(key, {
        channel: row.channel, externalConversationId: row.externalConversationId,
        lastMessage: row.content, lastRole: row.role, lastAt: row.createdAt,
        messages: (current?.messages ?? 0) + 1,
      });
    }
    return [...byId.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
  }
  async getMessages(channel: string, externalConversationId: string, limit: number): Promise<ConversationMessage[]> {
    return this.rows
      .filter((row) => row.channel === channel && row.externalConversationId === externalConversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map(({ role: value, content, createdAt }) => ({ role: value, content, createdAt }));
  }
}
