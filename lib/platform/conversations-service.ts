import { and, desc, eq, ilike, inArray, like, notLike, sql } from "drizzle-orm";
import { NON_CUSTOMER_LIKE, isNonCustomerConversation } from "./conversation-scope.ts";
import { channelContacts, channelMessages, conversationOutcomes, conversationStates, users } from "../../db/schema.ts";
import { AI_SENDER, AI_SENDER_NAME, awaitingSinceFrom, effectiveState, type ConversationStateRow, type EffectiveState } from "./conversation-state-shared.ts";

/**
 * Conversas reais recebidas pelos canais (hoje só o n8n/WhatsApp). Nada aqui é
 * sintético: se não houver conversa gravada, a lista volta vazia e a tela diz isso.
 *
 * `suggestion` é resposta que a IA produziu com a resposta automática desligada
 * e que ninguém enviou ao cliente — a tela precisa distinguir isso de mensagem
 * entregue, senão o histórico mente sobre o que o cliente recebeu.
 */
export type ConversationRole = "customer" | "agent" | "suggestion";

export interface ConversationSummary {
  channel: string;
  externalConversationId: string;
  lastMessage: string;
  lastRole: ConversationRole;
  lastAt: string;
  messages: number;
  /** Último desfecho registrado pelo pipeline, quando existe. */
  finalStatus?: string;
  intent?: string;
  handoff?: boolean;
  /** Nome do perfil de WhatsApp, o último visto. */
  displayName?: string;
  /**
   * Desde quando o cliente espera resposta: a primeira fala dele depois da
   * última resposta enviada. Ausente = não está esperando. Sugestão da IA não
   * conta como resposta — o cliente nunca a recebeu.
   */
  awaitingSince?: string;
  /** Autor da última mensagem, quando é resposta de atendente. */
  lastSentBy?: string;
  /** Nome de quem respondeu por último, quando a conta existe. O e-mail fica em `lastSentBy`. */
  lastSentByName?: string;
  /** A última fala do cliente: é ela que abre a janela de 24 horas da Meta. */
  lastCustomerAt?: string;
  /**
   * O texto da última fala do cliente. A lista mostrava a última linha, e a
   * última linha costuma ser a sugestão da IA — o atendente lia o que a IA
   * pensou em vez do que o cliente pediu.
   */
  lastCustomerMessage?: string;
  /** Aberta ou resolvida, e com quem. Ver `conversation-state-shared.ts`. */
  state: EffectiveState;
}

/**
 * `sentBy` é o e-mail do atendente que escreveu a resposta; ausente = não
 * registrado, não "a IA". `deliveryStatus` ausente = nenhum recibo chegou.
 */
export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  createdAt: string;
  sentBy?: string;
  /** Nome da conta que enviou. A bolha mostrava o e-mail, que é identificador, não nome. */
  sentByName?: string;
  deliveryStatus?: string;
  deliveryError?: string;
}

// Mora no módulo compartilhado: o canal e a fila usam a mesma noção de "resposta da IA".
export { awaitingSinceFrom };

/** O nome que aparece na bolha. A resposta automática não tem conta: é a IA, e a tela diz isso. */
const senderName = (sentBy: string | null | undefined, names: Map<string, string>) =>
  !sentBy ? undefined : sentBy === AI_SENDER ? AI_SENDER_NAME : names.get(sentBy);

/**
 * A janela em que a Meta aceita texto livre: 24 horas desde a última fala do
 * cliente. Calculada aqui para a tela avisar antes — o envio confere de novo.
 */
export function replyWindowFrom(messages: Array<{ role: string; createdAt: string }>, windowMs: number, now = Date.now()) {
  const last = [...messages].reverse().find((message) => message.role === "customer")?.createdAt;
  if (!last || !Number.isFinite(Date.parse(last))) return { lastCustomerAt: null, closesAt: null, open: false };
  const closesAt = Date.parse(last) + windowMs;
  return { lastCustomerAt: last, closesAt: new Date(closesAt).toISOString(), open: now <= closesAt };
}

/**
 * Busca por número (só dígitos, a partir de 3) ou por nome do perfil (a partir
 * de 2 letras). Abaixo disso não filtra: "9" casaria com quase tudo.
 */
export function searchTerm(raw?: string | null): { kind: "digits" | "name"; value: string } | undefined {
  const value = (raw ?? "").trim().slice(0, 60);
  if (!value) return undefined;
  if (/^[\d\s()+.-]+$/.test(value)) {
    const digits = value.replace(/\D/g, "");
    return digits.length >= 3 ? { kind: "digits", value: digits } : undefined;
  }
  return value.length >= 2 ? { kind: "name", value } : undefined;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Desempate de mensagens com o mesmo carimbo — o canal gravava a fala do cliente
 * e a sugestão no mesmo milissegundo. A fala vem antes da resposta a ela.
 */
const replyAfterCustomer = sql`case ${channelMessages.role} when 'customer' then 0 else 1 end`;

export interface ConversationOutcome { intent: string; finalStatus: string; handoff: boolean }

/**
 * A ficha de auditoria de uma conversa: o que dá para provar depois sobre o que
 * a IA fez ali.
 *
 * Campo nulo significa **não registrado**, não "zero" nem "regex" — conversa
 * anterior a estas colunas existirem não tem como ser preenchida, e preencher
 * com palpite seria pior que admitir a lacuna.
 */
export interface ConversationAudit {
  intent: string | null;
  finalStatus: string | null;
  handoff: boolean | null;
  handoffReason: string | null;
  /** `llm` ou `rules`. */
  intentSource: string | null;
  /** Pontos percentuais inteiros (0–100). */
  intentConfidence: number | null;
  intentModel: string | null;
  appVersion: string | null;
  correlationId: string | null;
  createdAt: string | null;
}

export interface ConversationsRepository {
  listConversations(limit: number, search?: string | null): Promise<ConversationSummary[]>;
  getMessages(channel: string, externalConversationId: string, limit: number): Promise<ConversationMessage[]>;
  /**
   * Último desfecho de uma conversa só. O copiloto precisa disto vindo do banco:
   * a tela já tem esses campos, mas resumo que repete o que o navegador mandou
   * pode ser resumo forjado — e ele é escrito para outra pessoa ler e confiar.
   */
  getOutcome(channel: string, externalConversationId: string): Promise<ConversationOutcome | undefined>;
  /** A ficha de auditoria do último atendimento desta conversa. */
  getAudit(channel: string, externalConversationId: string): Promise<ConversationAudit | undefined>;
}

const role = (value: string): ConversationRole =>
  value === "agent" ? "agent" : value === "suggestion" ? "suggestion" : "customer";

export class DbConversationsRepository implements ConversationsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async listConversations(limit: number, search?: string | null): Promise<ConversationSummary[]> {
    // Conversa de grupo não é atendimento e não aparece na fila.
    const filters = [notLike(channelMessages.externalConversationId, NON_CUSTOMER_LIKE)];
    const term = searchTerm(search);
    if (term?.kind === "digits") filters.push(like(channelMessages.externalConversationId, `%${term.value}%`));
    if (term?.kind === "name") {
      filters.push(inArray(
        channelMessages.externalConversationId,
        this.db.select({ id: channelContacts.externalConversationId }).from(channelContacts).where(ilike(channelContacts.displayName, `%${escapeLike(term.value)}%`)),
      ));
    }

    const grouped = await this.db.select({
      channel: channelMessages.channel,
      externalConversationId: channelMessages.externalConversationId,
      lastAt: sql<string>`max(${channelMessages.createdAt})`.as("last_at"),
      messages: sql<number>`count(*)`.as("messages"),
    }).from(channelMessages)
      .where(and(...filters))
      .groupBy(channelMessages.channel, channelMessages.externalConversationId)
      .orderBy(desc(sql`max(${channelMessages.createdAt})`))
      .limit(limit);
    if (grouped.length === 0) return [];

    const ids = grouped.map((row: { externalConversationId: string }) => row.externalConversationId);
    // Mensagens, desfechos e nomes de todas as conversas da página em três
    // consultas só — a redução por conversa acontece aqui, não dentro do laço.
    const [recent, outcomes, contacts, states] = await Promise.all([
      this.db.select({
        externalConversationId: channelMessages.externalConversationId,
        role: channelMessages.role,
        content: channelMessages.content,
        createdAt: channelMessages.createdAt,
        sentBy: channelMessages.sentBy,
      }).from(channelMessages)
        .where(inArray(channelMessages.externalConversationId, ids))
        .orderBy(desc(channelMessages.createdAt), desc(replyAfterCustomer)),
      this.db.select({
        externalConversationId: conversationOutcomes.externalConversationId,
        intent: conversationOutcomes.intent,
        finalStatus: conversationOutcomes.finalStatus,
        handoff: conversationOutcomes.handoff,
        createdAt: conversationOutcomes.createdAt,
      }).from(conversationOutcomes)
        .where(inArray(conversationOutcomes.externalConversationId, ids))
        .orderBy(desc(conversationOutcomes.createdAt)),
      this.db.select({
        channel: channelContacts.channel,
        externalConversationId: channelContacts.externalConversationId,
        displayName: channelContacts.displayName,
      }).from(channelContacts)
        .where(inArray(channelContacts.externalConversationId, ids)),
      this.db.select().from(conversationStates).where(inArray(conversationStates.externalConversationId, ids)),
    ]);

    const byConversation = new Map<string, Array<{ role: string; content: string; createdAt: string; sentBy: string | null }>>();
    for (const row of recent) {
      const rows = byConversation.get(row.externalConversationId) ?? [];
      rows.push(row);
      byConversation.set(row.externalConversationId, rows);
    }
    const lastOutcome = new Map<string, { intent: string; finalStatus: string; handoff: boolean }>();
    for (const row of outcomes) if (!lastOutcome.has(row.externalConversationId)) lastOutcome.set(row.externalConversationId, row);
    const names = new Map<string, string>(contacts.map((row: { channel: string; externalConversationId: string; displayName: string }) => [`${row.channel}:${row.externalConversationId}`, row.displayName]));
    const stateRows = new Map<string, ConversationStateRow>(states.map((row: ConversationStateRow & { channel: string; externalConversationId: string }) => [`${row.channel}:${row.externalConversationId}`, {
      status: row.status === "resolved" ? "resolved" : "open", assigneeId: row.assigneeId, assigneeName: row.assigneeName,
      assignedAt: row.assignedAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy,
    }]));
    const senders = await this.namesByEmail(grouped.map((row: { externalConversationId: string }) => {
      const last = byConversation.get(row.externalConversationId)?.[0];
      return last?.role === "agent" ? last.sentBy : null;
    }));

    return grouped.map((row: { channel: string; externalConversationId: string; lastAt: string; messages: number }) => {
      const rows = byConversation.get(row.externalConversationId) ?? [];
      const last = rows[0];
      const lastCustomer = rows.find((item) => item.role === "customer");
      const outcome = lastOutcome.get(row.externalConversationId);
      const sentBy = last?.role === "agent" ? last.sentBy ?? undefined : undefined;
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
        displayName: names.get(`${row.channel}:${row.externalConversationId}`),
        awaitingSince: awaitingSinceFrom(rows),
        lastSentBy: sentBy,
        lastSentByName: senderName(sentBy, senders),
        lastCustomerAt: lastCustomer?.createdAt,
        lastCustomerMessage: lastCustomer?.content,
        state: effectiveState(stateRows.get(`${row.channel}:${row.externalConversationId}`), lastCustomer?.createdAt),
      };
    });
  }

  /** E-mail de quem enviou → nome da conta. Conta apagada simplesmente não tem nome. */
  private async namesByEmail(emails: Array<string | null | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set(emails.filter((email): email is string => !!email))];
    if (unique.length === 0) return new Map();
    try {
      const rows: Array<{ email: string; name: string }> = await this.db.select({ email: users.email, name: users.name }).from(users).where(inArray(users.email, unique));
      return new Map(rows.map((row) => [row.email, row.name]));
    } catch { return new Map(); }
  }

  async getMessages(channel: string, externalConversationId: string, limit: number): Promise<ConversationMessage[]> {
    const rows = await this.db.select({
      role: channelMessages.role,
      content: channelMessages.content,
      createdAt: channelMessages.createdAt,
      sentBy: channelMessages.sentBy,
      deliveryStatus: channelMessages.deliveryStatus,
      deliveryError: channelMessages.deliveryError,
    }).from(channelMessages)
      .where(and(eq(channelMessages.channel, channel), eq(channelMessages.externalConversationId, externalConversationId)))
      .orderBy(desc(channelMessages.createdAt), desc(replyAfterCustomer))
      .limit(limit);
    const senders = await this.namesByEmail(rows.map((row: { sentBy: string | null }) => row.sentBy));
    return rows.map((row: { role: string; content: string; createdAt: string; sentBy: string | null; deliveryStatus: string | null; deliveryError: string | null }) => ({
      role: role(row.role), content: row.content, createdAt: row.createdAt, sentBy: row.sentBy ?? undefined, sentByName: senderName(row.sentBy, senders),
      deliveryStatus: row.deliveryStatus ?? undefined, deliveryError: row.deliveryError ?? undefined,
    })).reverse();
  }

  async getAudit(channel: string, externalConversationId: string): Promise<ConversationAudit | undefined> {
    const rows = await this.db.select({
      intent: conversationOutcomes.intent,
      finalStatus: conversationOutcomes.finalStatus,
      handoff: conversationOutcomes.handoff,
      handoffReason: conversationOutcomes.handoffReason,
      intentSource: conversationOutcomes.intentSource,
      intentConfidence: conversationOutcomes.intentConfidence,
      intentModel: conversationOutcomes.intentModel,
      appVersion: conversationOutcomes.appVersion,
      correlationId: conversationOutcomes.correlationId,
      createdAt: conversationOutcomes.createdAt,
    }).from(conversationOutcomes)
      .where(and(eq(conversationOutcomes.channel, channel), eq(conversationOutcomes.externalConversationId, externalConversationId)))
      .orderBy(desc(conversationOutcomes.createdAt))
      .limit(1);
    return rows[0];
  }

  async getOutcome(channel: string, externalConversationId: string): Promise<ConversationOutcome | undefined> {
    const rows = await this.db.select({
      intent: conversationOutcomes.intent,
      finalStatus: conversationOutcomes.finalStatus,
      handoff: conversationOutcomes.handoff,
    }).from(conversationOutcomes)
      .where(and(eq(conversationOutcomes.channel, channel), eq(conversationOutcomes.externalConversationId, externalConversationId)))
      .orderBy(desc(conversationOutcomes.createdAt))
      .limit(1);
    return rows[0];
  }
}

export class MemoryConversationsRepository implements ConversationsRepository {
  async getAudit() { return undefined; }
  readonly rows: Array<{ channel: string; externalConversationId: string; role: ConversationRole; content: string; createdAt: string; sentBy?: string; deliveryStatus?: string; deliveryError?: string }> = [];
  /** `canal:conversa` → nome do perfil. */
  readonly contacts = new Map<string, string>();
  /** `canal:conversa` → estado gravado. */
  readonly states = new Map<string, ConversationStateRow>();
  /** e-mail → nome da conta. */
  readonly userNames = new Map<string, string>();
  add(row: { channel: string; externalConversationId: string; role: ConversationRole; content: string; createdAt: string; sentBy?: string; deliveryStatus?: string; deliveryError?: string }) { this.rows.push(row); }
  async listConversations(limit: number, search?: string | null): Promise<ConversationSummary[]> {
    const term = searchTerm(search);
    const byId = new Map<string, typeof this.rows>();
    for (const row of [...this.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      // Mesma regra do repositório real: grupo não é atendimento.
      if (isNonCustomerConversation(row.externalConversationId)) continue;
      const key = `${row.channel}:${row.externalConversationId}`;
      byId.set(key, [...(byId.get(key) ?? []), row]);
    }
    const summaries: ConversationSummary[] = [...byId.entries()].map(([key, rows]) => {
      const last = rows[0];
      const lastCustomer = rows.find((row) => row.role === "customer");
      const sentBy = last.role === "agent" ? last.sentBy : undefined;
      return {
        channel: last.channel, externalConversationId: last.externalConversationId,
        lastMessage: last.content, lastRole: last.role, lastAt: last.createdAt, messages: rows.length,
        displayName: this.contacts.get(key),
        awaitingSince: awaitingSinceFrom(rows),
        lastSentBy: sentBy,
        lastSentByName: senderName(sentBy, this.userNames),
        lastCustomerAt: lastCustomer?.createdAt,
        lastCustomerMessage: lastCustomer?.content,
        state: effectiveState(this.states.get(key), lastCustomer?.createdAt),
      };
    });
    return summaries
      .filter((item) => !term || (term.kind === "digits"
        ? item.externalConversationId.includes(term.value)
        : (item.displayName ?? "").toLowerCase().includes(term.value.toLowerCase())))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .slice(0, limit);
  }
  async getMessages(channel: string, externalConversationId: string, limit: number): Promise<ConversationMessage[]> {
    return this.rows
      .filter((row) => row.channel === channel && row.externalConversationId === externalConversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map(({ role: value, content, createdAt, sentBy, deliveryStatus, deliveryError }) => ({ role: value, content, createdAt, sentBy, sentByName: senderName(sentBy, this.userNames), deliveryStatus, deliveryError }));
  }
  readonly outcomes = new Map<string, ConversationOutcome>();
  async getOutcome(channel: string, externalConversationId: string) { return this.outcomes.get(`${channel}:${externalConversationId}`); }
}
