import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { internalMessages, internalParticipants, internalThreads, users } from "../../db/schema.ts";

/**
 * Chat interno entre a equipe (issue #10).
 *
 * A propriedade de segurança central: **a consulta parte da participação**,
 * nunca da lista de conversas com filtro aplicado depois. Listar tudo e
 * filtrar na aplicação é o tipo de código que vaza no dia em que alguém
 * esquece o filtro num caminho novo. Aqui, quem não tem linha em
 * `internal_participants` simplesmente não tem como alcançar a conversa.
 *
 * ⚠️ O conteúdo da mensagem **não** vai para a auditoria. Conversa interna
 * sobre um cliente contém dado pessoal por natureza — é para isso que serve.
 * A auditoria registra que houve mensagem, de quem, em qual conversa; o texto
 * fica só na tabela de mensagens, acessível a quem participa.
 */

export const MAX_SUBJECT = 120;
export const MAX_MESSAGE = 4000;

export interface ThreadSummary {
  id: string;
  subject: string;
  linkedConversationId: string | null;
  lastMessageAt: string;
  participants: Array<{ userId: string; name: string; role: string }>;
  /** Mensagens depois da última leitura deste usuário. */
  unread: number;
}

export interface ThreadMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export class InternalChatValidationError extends Error {
  constructor(message: string) { super(message); this.name = "InternalChatValidationError"; }
}

export function parseSubject(value: unknown): string {
  const subject = typeof value === "string" ? value.trim() : "";
  if (subject.length < 3) throw new InternalChatValidationError("Descreva o assunto em pelo menos 3 caracteres");
  if (subject.length > MAX_SUBJECT) throw new InternalChatValidationError(`Assunto acima de ${MAX_SUBJECT} caracteres`);
  return subject;
}

export function parseMessageBody(value: unknown): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) throw new InternalChatValidationError("Mensagem vazia");
  if (body.length > MAX_MESSAGE) throw new InternalChatValidationError(`Mensagem acima de ${MAX_MESSAGE} caracteres`);
  return body;
}

/** Quem abre a conversa participa dela sempre — sem isso daria para criar conversa que o próprio autor não lê. */
export function normalizeParticipants(authorId: string, invited: unknown): string[] {
  const list = Array.isArray(invited) ? invited.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
  const unique = [...new Set([authorId, ...list.map((id) => id.trim())])];
  if (unique.length < 2) throw new InternalChatValidationError("Escolha pelo menos uma pessoa para conversar");
  if (unique.length > 20) throw new InternalChatValidationError("Máximo de 20 participantes por conversa");
  return unique;
}

export function countUnread(messages: Array<{ authorId: string; createdAt: string }>, userId: string, lastReadAt: string | null): number {
  // Mensagem própria nunca é "não lida": quem escreveu já sabe o que escreveu.
  return messages.filter((message) => message.authorId !== userId && (!lastReadAt || message.createdAt > lastReadAt)).length;
}

export interface InternalChatRepository {
  listThreadsFor(userId: string): Promise<ThreadSummary[]>;
  /** Devolve `undefined` quando o usuário não participa — não distingue de "não existe", de propósito. */
  getThread(threadId: string, userId: string): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] } | undefined>;
  createThread(input: { subject: string; linkedConversationId?: string; authorId: string; participantIds: string[] }): Promise<string>;
  addMessage(threadId: string, authorId: string, body: string): Promise<ThreadMessage | undefined>;
  markRead(threadId: string, userId: string): Promise<void>;
  listPeople(): Promise<Array<{ id: string; name: string; role: string }>>;
}

export class DbInternalChatRepository implements InternalChatRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  private async participates(threadId: string, userId: string): Promise<{ lastReadAt: string | null } | undefined> {
    const rows = await this.db.select().from(internalParticipants)
      .where(and(eq(internalParticipants.threadId, threadId), eq(internalParticipants.userId, userId))).limit(1);
    return rows[0] ? { lastReadAt: rows[0].lastReadAt ?? null } : undefined;
  }

  async listThreadsFor(userId: string): Promise<ThreadSummary[]> {
    // Parte da participação: sem linha aqui, a conversa nem é buscada.
    const mine = await this.db.select().from(internalParticipants).where(eq(internalParticipants.userId, userId));
    if (mine.length === 0) return [];
    const threadIds = mine.map((row: { threadId: string }) => row.threadId);

    const [threads, everyone, messages] = await Promise.all([
      this.db.select().from(internalThreads).where(inArray(internalThreads.id, threadIds)).orderBy(desc(internalThreads.lastMessageAt)),
      this.db.select({ threadId: internalParticipants.threadId, userId: internalParticipants.userId, name: users.name, role: users.role })
        .from(internalParticipants).innerJoin(users, eq(users.id, internalParticipants.userId))
        .where(inArray(internalParticipants.threadId, threadIds)),
      this.db.select({ threadId: internalMessages.threadId, authorId: internalMessages.authorId, createdAt: internalMessages.createdAt })
        .from(internalMessages).where(inArray(internalMessages.threadId, threadIds)),
    ]);

    const readBy = new Map(mine.map((row: { threadId: string; lastReadAt: string | null }) => [row.threadId, row.lastReadAt ?? null]));
    return threads.map((thread: { id: string; subject: string; linkedConversationId: string | null; lastMessageAt: string }) => ({
      id: thread.id,
      subject: thread.subject,
      linkedConversationId: thread.linkedConversationId ?? null,
      lastMessageAt: thread.lastMessageAt,
      participants: everyone.filter((p: { threadId: string }) => p.threadId === thread.id)
        .map((p: { userId: string; name: string; role: string }) => ({ userId: p.userId, name: p.name, role: p.role })),
      unread: countUnread(
        messages.filter((m: { threadId: string }) => m.threadId === thread.id),
        userId,
        (readBy.get(thread.id) ?? null) as string | null,
      ),
    }));
  }

  async getThread(threadId: string, userId: string) {
    const membership = await this.participates(threadId, userId);
    if (!membership) return undefined;

    const [threads, people, rows] = await Promise.all([
      this.db.select().from(internalThreads).where(eq(internalThreads.id, threadId)).limit(1),
      this.db.select({ userId: internalParticipants.userId, name: users.name, role: users.role })
        .from(internalParticipants).innerJoin(users, eq(users.id, internalParticipants.userId))
        .where(eq(internalParticipants.threadId, threadId)),
      this.db.select({ id: internalMessages.id, authorId: internalMessages.authorId, body: internalMessages.body, createdAt: internalMessages.createdAt, authorName: users.name })
        .from(internalMessages).innerJoin(users, eq(users.id, internalMessages.authorId))
        .where(eq(internalMessages.threadId, threadId)).orderBy(asc(internalMessages.createdAt)),
    ]);
    const thread = threads[0];
    if (!thread) return undefined;

    return {
      thread: {
        id: thread.id, subject: thread.subject,
        linkedConversationId: thread.linkedConversationId ?? null,
        lastMessageAt: thread.lastMessageAt,
        participants: people,
        unread: countUnread(rows, userId, membership.lastReadAt),
      },
      messages: rows as ThreadMessage[],
    };
  }

  async createThread(input: { subject: string; linkedConversationId?: string; authorId: string; participantIds: string[] }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.insert(internalThreads).values({
      id, subject: input.subject, linkedConversationId: input.linkedConversationId ?? null,
      createdBy: input.authorId, lastMessageAt: now, createdAt: now, updatedAt: now,
    });
    await this.db.insert(internalParticipants).values(input.participantIds.map((userId) => ({
      threadId: id, userId, lastReadAt: userId === input.authorId ? now : null, createdAt: now, updatedAt: now,
    })));
    return id;
  }

  async addMessage(threadId: string, authorId: string, body: string) {
    if (!await this.participates(threadId, authorId)) return undefined;
    const now = new Date().toISOString();
    const message = { id: randomUUID(), threadId, authorId, body, createdAt: now, updatedAt: now };
    await this.db.insert(internalMessages).values(message);
    await this.db.update(internalThreads).set({ lastMessageAt: now, updatedAt: now }).where(eq(internalThreads.id, threadId));
    await this.db.update(internalParticipants).set({ lastReadAt: now, updatedAt: now })
      .where(and(eq(internalParticipants.threadId, threadId), eq(internalParticipants.userId, authorId)));
    const author = await this.db.select({ name: users.name }).from(users).where(eq(users.id, authorId)).limit(1);
    return { id: message.id, authorId, authorName: author[0]?.name ?? "desconhecido", body, createdAt: now };
  }

  async markRead(threadId: string, userId: string) {
    await this.db.update(internalParticipants).set({ lastReadAt: new Date().toISOString() })
      .where(and(eq(internalParticipants.threadId, threadId), eq(internalParticipants.userId, userId)));
  }

  async listPeople() {
    return this.db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.active, true)).orderBy(asc(users.name));
  }
}

/**
 * Implementação em memória para os testes — mesma regra de participação.
 *
 * O relógio é próprio e sempre avança porque `Date.now()` tem resolução de
 * milissegundo: criar a conversa e mandar a primeira mensagem no mesmo
 * milissegundo fazia `createdAt > lastReadAt` dar falso, e o teste de não
 * lidas falhava de forma intermitente. Num teste, intermitente é pior que
 * quebrado — some quando você olha.
 */
export class MemoryInternalChatRepository implements InternalChatRepository {
  private tick = 0;
  private now() { return new Date(Date.now() + (this.tick += 1)).toISOString(); }

  readonly threads: Array<{ id: string; subject: string; linkedConversationId: string | null; createdBy: string; lastMessageAt: string }> = [];
  readonly participants: Array<{ threadId: string; userId: string; lastReadAt: string | null }> = [];
  readonly messages: Array<ThreadMessage & { threadId: string }> = [];
  readonly people: Array<{ id: string; name: string; role: string }> = [];

  private participates(threadId: string, userId: string) {
    return this.participants.find((p) => p.threadId === threadId && p.userId === userId);
  }

  async listThreadsFor(userId: string) {
    return this.participants.filter((p) => p.userId === userId).flatMap((membership) => {
      const thread = this.threads.find((t) => t.id === membership.threadId);
      if (!thread) return [];
      return [{
        id: thread.id, subject: thread.subject, linkedConversationId: thread.linkedConversationId,
        lastMessageAt: thread.lastMessageAt,
        participants: this.participants.filter((p) => p.threadId === thread.id)
          .map((p) => { const person = this.people.find((x) => x.id === p.userId); return { userId: p.userId, name: person?.name ?? "?", role: person?.role ?? "?" }; }),
        unread: countUnread(this.messages.filter((m) => m.threadId === thread.id), userId, membership.lastReadAt),
      }];
    }).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  async getThread(threadId: string, userId: string) {
    const membership = this.participates(threadId, userId);
    if (!membership) return undefined;
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) return undefined;
    const messages = this.messages.filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      thread: {
        id: thread.id, subject: thread.subject, linkedConversationId: thread.linkedConversationId,
        lastMessageAt: thread.lastMessageAt,
        participants: this.participants.filter((p) => p.threadId === threadId)
          .map((p) => { const person = this.people.find((x) => x.id === p.userId); return { userId: p.userId, name: person?.name ?? "?", role: person?.role ?? "?" }; }),
        unread: countUnread(messages, userId, membership.lastReadAt),
      },
      messages: messages.map((message) => ({ id: message.id, authorId: message.authorId, authorName: message.authorName, body: message.body, createdAt: message.createdAt })),
    };
  }

  async createThread(input: { subject: string; linkedConversationId?: string; authorId: string; participantIds: string[] }) {
    const now = this.now();
    const id = randomUUID();
    this.threads.push({ id, subject: input.subject, linkedConversationId: input.linkedConversationId ?? null, createdBy: input.authorId, lastMessageAt: now });
    for (const userId of input.participantIds) this.participants.push({ threadId: id, userId, lastReadAt: userId === input.authorId ? now : null });
    return id;
  }

  async addMessage(threadId: string, authorId: string, body: string) {
    const membership = this.participates(threadId, authorId);
    if (!membership) return undefined;
    const now = this.now();
    const message = { id: randomUUID(), authorId, authorName: this.people.find((p) => p.id === authorId)?.name ?? "?", body, createdAt: now };
    this.messages.push({ ...message, threadId });
    const thread = this.threads.find((t) => t.id === threadId);
    if (thread) thread.lastMessageAt = now;
    membership.lastReadAt = now;
    return message;
  }

  async markRead(threadId: string, userId: string) {
    const membership = this.participates(threadId, userId);
    if (membership) membership.lastReadAt = this.now();
  }

  async listPeople() { return this.people; }
}
