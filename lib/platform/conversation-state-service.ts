import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditEvents, channelMessages, conversationStates } from "../../db/schema.ts";
import { isNonCustomerConversation } from "./conversation-scope.ts";
import { STATE_ACTIONS, botMayReply, effectiveState, type ConversationStateRow, type EffectiveState, type StateAction } from "./conversation-state-shared.ts";

/**
 * Assumir, devolver para a IA, resolver e reabrir uma conversa.
 *
 * Toda troca vai para a auditoria com quem fez e de quem era antes: "quem
 * estava com esse cliente?" é a primeira pergunta quando um atendimento dá
 * errado. Ação que não muda nada (assumir o que já é seu, resolver o já
 * resolvido) responde sucesso sem gravar — duplo clique não vira duas linhas.
 */

export interface StateActor { id: string; name: string; email: string; role: string }

export interface ConversationStateRepository {
  get(channel: string, conversationId: string): Promise<ConversationStateRow | undefined>;
  getMany(conversationIds: string[]): Promise<Map<string, ConversationStateRow>>;
  save(channel: string, conversationId: string, row: ConversationStateRow): Promise<void>;
  /** `undefined` = a conversa não existe; `null` = existe, mas o cliente nunca escreveu. */
  lastCustomerAt(channel: string, conversationId: string): Promise<string | null | undefined>;
  audit(entry: { action: string; entity: string; reason: string; actor: StateActor }): Promise<void>;
}

export type StateResult = { ok: true; state: EffectiveState; changed: boolean } | { ok: false; status: number; reason: string; state?: EffectiveState };

export const stateKey = (channel: string, conversationId: string) => `${channel}:${conversationId}`;

export async function changeConversationState(
  repository: ConversationStateRepository,
  input: { channel: string; conversationId: string; action: string; actor?: StateActor; takeOver?: boolean; now?: () => number },
): Promise<StateResult> {
  const action = input.action as StateAction;
  if (!STATE_ACTIONS.includes(action)) return { ok: false, status: 400, reason: "Ação inválida." };
  const conversationId = input.conversationId.trim();
  if (!conversationId || conversationId.length > 80 || isNonCustomerConversation(conversationId)) return { ok: false, status: 400, reason: "Conversa inválida." };
  // Responsável anônimo não responde por nada: sem login não há de quem cobrar.
  if (!input.actor) return { ok: false, status: 401, reason: "Assumir ou resolver conversa exige login (FEATURE_AUTH)." };
  const actor = input.actor;

  const lastCustomerAt = await repository.lastCustomerAt(input.channel, conversationId);
  if (lastCustomerAt === undefined) return { ok: false, status: 404, reason: "Conversa não encontrada." };
  const row = await repository.get(input.channel, conversationId);
  const current = effectiveState(row, lastCustomerAt);
  const at = new Date((input.now ?? Date.now)()).toISOString();
  const entity = `conversation:${conversationId}`;
  const was = current.assigneeName ? ` (estava com ${current.assigneeName})` : "";

  let next: ConversationStateRow | null = null;
  let reason = "";
  if (action === "claim") {
    if (current.status === "open" && current.assigneeId === actor.id) return { ok: true, state: current, changed: false };
    // Tomar a conversa de um colega é possível, mas precisa ser decidido: sem
    // isso, dois atendentes respondem o mesmo cliente sem saber um do outro.
    if (current.status === "open" && current.assigneeId && !input.takeOver) {
      return { ok: false, status: 409, reason: `${current.assigneeName ?? "Outra pessoa"} já está com esta conversa.`, state: current };
    }
    next = { status: "open", assigneeId: actor.id, assigneeName: actor.name, assignedAt: at, resolvedAt: null, resolvedBy: null };
    reason = `Assumiu a conversa${current.status === "resolved" ? " resolvida" : ""}${was}`;
  } else if (action === "release") {
    if (current.status === "open" && !current.assigneeId) return { ok: true, state: current, changed: false };
    next = { status: "open", assigneeId: null, assigneeName: null, assignedAt: null, resolvedAt: null, resolvedBy: null };
    reason = `Devolveu a conversa para a IA${was}`;
  } else if (action === "resolve") {
    if (current.status === "resolved") return { ok: true, state: current, changed: false };
    next = { status: "resolved", assigneeId: current.assigneeId, assigneeName: current.assigneeName, assignedAt: current.assignedAt, resolvedAt: at, resolvedBy: actor.name };
    reason = `Resolveu a conversa${was}`;
  } else {
    if (current.status === "open") return { ok: true, state: current, changed: false };
    next = { status: "open", assigneeId: null, assigneeName: null, assignedAt: null, resolvedAt: null, resolvedBy: null };
    reason = `Reabriu a conversa${current.resolvedBy ? ` (resolvida por ${current.resolvedBy})` : ""}`;
  }

  await repository.save(input.channel, conversationId, next);
  // A auditoria não derruba a ação: o estado já mudou e a tela precisa saber.
  await repository.audit({ action: `conversation.${action}`, entity, reason, actor }).catch(() => undefined);
  return { ok: true, state: effectiveState(next, lastCustomerAt), changed: true };
}

/**
 * Quem responde pela tela passa a ser o responsável, se ninguém era. É o que as
 * caixas de entrada fazem — e é o que impede a IA de responder por cima depois
 * que um humano entrou na conversa. Melhor esforço: o envio já aconteceu.
 */
export async function claimIfUnassigned(repository: ConversationStateRepository, channel: string, conversationId: string, actor: StateActor | undefined): Promise<void> {
  if (!actor) return;
  try {
    const lastCustomerAt = await repository.lastCustomerAt(channel, conversationId);
    const current = effectiveState(await repository.get(channel, conversationId), lastCustomerAt);
    if (current.status === "open" && current.assigneeId) return;
    await changeConversationState(repository, { channel, conversationId, action: "claim", actor });
  } catch { /* sem estado gravado a conversa só continua sem responsável */ }
}

/**
 * A trava do canal de entrada: com a resposta automática ligada, a IA só fala
 * se nenhum humano estiver com a conversa. Se o estado não puder ser lido, a IA
 * **não** responde — na dúvida, sugere ao atendente em vez de falar por cima.
 */
export async function botMayReplyNow(repository: ConversationStateRepository, channel: string, conversationId: string): Promise<boolean> {
  try { return botMayReply(await repository.get(channel, conversationId)); }
  catch { return false; }
}

type Row = { channel: string; externalConversationId: string; status: string; assigneeId: string | null; assigneeName: string | null; assignedAt: string | null; resolvedAt: string | null; resolvedBy: string | null };
const toState = (row: Row): ConversationStateRow => ({
  status: row.status === "resolved" ? "resolved" : "open",
  assigneeId: row.assigneeId, assigneeName: row.assigneeName, assignedAt: row.assignedAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy,
});

export class DbConversationStateRepository implements ConversationStateRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async get(channel: string, conversationId: string) {
    const rows: Row[] = await this.db.select().from(conversationStates)
      .where(and(eq(conversationStates.channel, channel), eq(conversationStates.externalConversationId, conversationId))).limit(1);
    return rows[0] ? toState(rows[0]) : undefined;
  }

  async getMany(conversationIds: string[]) {
    if (conversationIds.length === 0) return new Map<string, ConversationStateRow>();
    const rows: Row[] = await this.db.select().from(conversationStates).where(inArray(conversationStates.externalConversationId, conversationIds));
    return new Map(rows.map((row) => [stateKey(row.channel, row.externalConversationId), toState(row)]));
  }

  async save(channel: string, conversationId: string, row: ConversationStateRow) {
    const values = { ...row, updatedAt: new Date().toISOString() };
    await this.db.insert(conversationStates).values({ channel, externalConversationId: conversationId, ...values })
      .onConflictDoUpdate({ target: [conversationStates.channel, conversationStates.externalConversationId], set: values });
  }

  async lastCustomerAt(channel: string, conversationId: string) {
    const rows = await this.db.select({
      total: sql<number>`count(*)`,
      last: sql<string | null>`max(case when ${channelMessages.role} = 'customer' then ${channelMessages.createdAt} end)`,
    }).from(channelMessages)
      .where(and(eq(channelMessages.channel, channel), eq(channelMessages.externalConversationId, conversationId)));
    if (!rows[0] || Number(rows[0].total) === 0) return undefined;
    return rows[0].last ?? null;
  }

  async audit(entry: { action: string; entity: string; reason: string; actor: StateActor }) {
    await this.db.insert(auditEvents).values({
      id: randomUUID(), actorId: entry.actor.email, role: entry.actor.role, action: entry.action, entity: entry.entity,
      beforeMasked: null, afterMasked: null, reason: entry.reason, correlationId: randomUUID(), result: "success", origin: "humano",
      createdAt: new Date().toISOString(),
    });
  }
}

export class MemoryConversationStateRepository implements ConversationStateRepository {
  readonly states = new Map<string, ConversationStateRow>();
  /** `canal:conversa` → última fala do cliente (`null` = conversa sem fala do cliente). */
  readonly conversations = new Map<string, string | null>();
  readonly audits: Array<{ action: string; entity: string; reason: string; actor: StateActor }> = [];
  failReads = false;
  async get(channel: string, conversationId: string) {
    if (this.failReads) throw new Error("banco fora");
    return this.states.get(stateKey(channel, conversationId));
  }
  async getMany(conversationIds: string[]) {
    return new Map([...this.states].filter(([key]) => conversationIds.some((id) => key.endsWith(`:${id}`))));
  }
  async save(channel: string, conversationId: string, row: ConversationStateRow) { this.states.set(stateKey(channel, conversationId), row); }
  async lastCustomerAt(channel: string, conversationId: string) {
    const key = stateKey(channel, conversationId);
    return this.conversations.has(key) ? this.conversations.get(key) ?? null : undefined;
  }
  async audit(entry: { action: string; entity: string; reason: string; actor: StateActor }) { this.audits.push(entry); }
}
