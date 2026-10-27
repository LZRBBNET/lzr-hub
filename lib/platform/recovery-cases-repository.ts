import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { paymentPromises, recoveryCaseEvents, recoveryCases, supportTickets, users } from "../../db/schema.ts";
import type { RecoveryCaseEvent, RecoveryCaseStatus, SupervisedRecoveryCase } from "./recovery-cases-shared.ts";

export type RecoveryCaseRecord = Omit<SupervisedRecoveryCase, "ownerName" | "attendance"> & { scopeId: string };
export type RecoveryCaseEventRecord = RecoveryCaseEvent & { scopeId: string; idempotencyKey: string; requestHash: string; correlationId: string };
export interface RecoveryCaseListQuery { page: number; pageSize: number; customerId?: string; status: RecoveryCaseStatus | "active" | "all" }
export interface LegacyPromiseReference { id: string; customerId: string; invoiceId: string; status: string }
export interface LegacyAttendanceReference { id: string; seq: number; protocol: string | null; identification: string; ixcCustomerId: string | null; channel: string; externalConversationId: string }

export interface RecoveryCasesRepository {
  list(scopeId: string, query: RecoveryCaseListQuery): Promise<{ items: RecoveryCaseRecord[]; total: number }>;
  get(scopeId: string, id: string): Promise<RecoveryCaseRecord | undefined>;
  history(scopeId: string, caseId: string, limit: number): Promise<RecoveryCaseEventRecord[]>;
  eventByKey(scopeId: string, key: string): Promise<RecoveryCaseEventRecord | undefined>;
  create(record: RecoveryCaseRecord): Promise<RecoveryCaseRecord>;
  update(scopeId: string, id: string, version: number, changes: Partial<RecoveryCaseRecord>): Promise<RecoveryCaseRecord | undefined>;
  append(event: RecoveryCaseEventRecord): Promise<void>;
  transaction<T>(fn: (repository: RecoveryCasesRepository) => Promise<T>): Promise<T>;
  promise(id: string): Promise<LegacyPromiseReference | undefined>;
  attendance(id: string): Promise<LegacyAttendanceReference | undefined>;
  attendanceByProtocolForCustomer(protocol: string, customerId: string): Promise<LegacyAttendanceReference | undefined>;
  latestAttendance(channel: string, conversationId: string): Promise<LegacyAttendanceReference | undefined>;
  ownerName(id: string): Promise<string | null>;
}

/** All new-table reads/writes are installation-scoped. Legacy sources are single-installation tables. */
export class DbRecoveryCasesRepository implements RecoveryCasesRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async list(scopeId: string, query: RecoveryCaseListQuery) {
    const where = and(eq(recoveryCases.scopeId, scopeId), query.customerId ? eq(recoveryCases.customerId, query.customerId) : undefined,
      query.status === "all" ? undefined : query.status === "active" ? ne(recoveryCases.status, "closed") : eq(recoveryCases.status, query.status));
    const items: RecoveryCaseRecord[] = await this.db.select().from(recoveryCases).where(where)
      .orderBy(sql`case when ${recoveryCases.nextActionOn} is null then 1 else 0 end`, asc(recoveryCases.nextActionOn), asc(recoveryCases.openedAt), asc(recoveryCases.id))
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize);
    const totals = await this.db.select({ count: sql<number>`count(*)::integer` }).from(recoveryCases).where(where);
    return { items, total: Number(totals[0]?.count ?? 0) };
  }
  async get(scopeId: string, id: string) {
    const rows: RecoveryCaseRecord[] = await this.db.select().from(recoveryCases).where(and(eq(recoveryCases.scopeId, scopeId), eq(recoveryCases.id, id))).limit(1);
    return rows[0];
  }
  async history(scopeId: string, caseId: string, limit: number) {
    return this.db.select().from(recoveryCaseEvents).where(and(eq(recoveryCaseEvents.scopeId, scopeId), eq(recoveryCaseEvents.caseId, caseId)))
      .orderBy(desc(recoveryCaseEvents.createdAt), desc(recoveryCaseEvents.id)).limit(Math.min(limit, 101)) as Promise<RecoveryCaseEventRecord[]>;
  }
  async eventByKey(scopeId: string, key: string) {
    const rows: RecoveryCaseEventRecord[] = await this.db.select().from(recoveryCaseEvents)
      .where(and(eq(recoveryCaseEvents.scopeId, scopeId), eq(recoveryCaseEvents.idempotencyKey, key))).limit(1);
    return rows[0];
  }
  async create(record: RecoveryCaseRecord) {
    const rows: RecoveryCaseRecord[] = await this.db.insert(recoveryCases).values(record).returning(); return rows[0];
  }
  async update(scopeId: string, id: string, version: number, changes: Partial<RecoveryCaseRecord>) {
    const rows: RecoveryCaseRecord[] = await this.db.update(recoveryCases).set({ ...changes, version: sql`${recoveryCases.version} + 1` })
      .where(and(eq(recoveryCases.scopeId, scopeId), eq(recoveryCases.id, id), eq(recoveryCases.version, version))).returning();
    return rows[0];
  }
  async append(event: RecoveryCaseEventRecord) { await this.db.insert(recoveryCaseEvents).values(event); }
  async transaction<T>(fn: (repository: RecoveryCasesRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx: unknown) => fn(new DbRecoveryCasesRepository(tx)));
  }
  async promise(id: string) {
    const rows = await this.db.select({ id: paymentPromises.id, customerId: paymentPromises.customerId, invoiceId: paymentPromises.invoiceId, status: paymentPromises.status })
      .from(paymentPromises).where(eq(paymentPromises.id, id)).limit(1);
    return rows[0] as LegacyPromiseReference | undefined;
  }
  async attendance(id: string) {
    const rows = await this.db.select({ id: supportTickets.id, seq: supportTickets.seq, protocol: supportTickets.protocol, identification: supportTickets.identification, ixcCustomerId: supportTickets.ixcCustomerId,
      channel: supportTickets.channel, externalConversationId: supportTickets.externalConversationId }).from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
    return rows[0] as LegacyAttendanceReference | undefined;
  }
  async attendanceByProtocolForCustomer(protocol: string, customerId: string) {
    const rows = await this.db.select({ id: supportTickets.id, seq: supportTickets.seq, protocol: supportTickets.protocol, identification: supportTickets.identification, ixcCustomerId: supportTickets.ixcCustomerId,
      channel: supportTickets.channel, externalConversationId: supportTickets.externalConversationId }).from(supportTickets)
      .where(and(eq(supportTickets.protocol, protocol), eq(supportTickets.ixcCustomerId, customerId), eq(supportTickets.identification, "identified"))).limit(2);
    return rows.length === 1 ? rows[0] as LegacyAttendanceReference : undefined;
  }
  async latestAttendance(channel: string, conversationId: string) {
    const rows = await this.db.select({ id: supportTickets.id, seq: supportTickets.seq, protocol: supportTickets.protocol, identification: supportTickets.identification, ixcCustomerId: supportTickets.ixcCustomerId,
      channel: supportTickets.channel, externalConversationId: supportTickets.externalConversationId }).from(supportTickets)
      .where(and(eq(supportTickets.channel, channel), eq(supportTickets.externalConversationId, conversationId))).orderBy(desc(supportTickets.seq)).limit(1);
    return rows[0] as LegacyAttendanceReference | undefined;
  }
  async ownerName(id: string): Promise<string | null> {
    const rows = await this.db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1); return rows[0]?.name ?? null;
  }
}

/** Deterministic test double: serialized transactions with rollback; not a substitute for PostgreSQL concurrency tests. */
export class MemoryRecoveryCasesRepository implements RecoveryCasesRepository {
  readonly cases = new Map<string, RecoveryCaseRecord>();
  readonly events: RecoveryCaseEventRecord[] = [];
  readonly promises = new Map<string, LegacyPromiseReference>();
  readonly tickets = new Map<string, LegacyAttendanceReference>();
  readonly owners = new Map<string, string>();
  failAppend = false;
  private pending: Promise<unknown> = Promise.resolve();
  private key(scope: string, id: string) { return JSON.stringify([scope, id]); }
  async list(scopeId: string, query: RecoveryCaseListQuery) {
    const items = [...this.cases.values()].filter(row => row.scopeId === scopeId && (!query.customerId || row.customerId === query.customerId)
      && (query.status === "all" || (query.status === "active" ? row.status !== "closed" : row.status === query.status)))
      .sort((a, b) => (a.nextActionOn ?? "9999").localeCompare(b.nextActionOn ?? "9999") || a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id));
    return { items: structuredClone(items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)), total: items.length };
  }
  async get(scope: string, id: string) { const item = this.cases.get(this.key(scope, id)); return item ? structuredClone(item) : undefined; }
  async history(scope: string, id: string, limit: number) { return structuredClone(this.events.filter(e => e.scopeId === scope && e.caseId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, Math.min(limit, 101))); }
  async eventByKey(scope: string, key: string) { return this.events.find(e => e.scopeId === scope && e.idempotencyKey === key); }
  private unique(record: RecoveryCaseRecord) {
    if (record.status !== "closed" && [...this.cases.values()].some(r => r.scopeId === record.scopeId && r.customerId === record.customerId && r.id !== record.id && r.status !== "closed")) throw Object.assign(new Error("active case exists"), { code: "23505" });
  }
  async create(record: RecoveryCaseRecord) { this.unique(record); this.cases.set(this.key(record.scopeId, record.id), structuredClone(record)); return structuredClone(record); }
  async update(scope: string, id: string, version: number, changes: Partial<RecoveryCaseRecord>) {
    const current = await this.get(scope, id); if (!current || current.version !== version) return undefined;
    const next = { ...current, ...changes, scopeId: scope, id, version: current.version + 1 }; this.unique(next); this.cases.set(this.key(scope, id), structuredClone(next)); return structuredClone(next);
  }
  async append(event: RecoveryCaseEventRecord) {
    if (this.failAppend) throw new Error("synthetic event write failure");
    if (await this.eventByKey(event.scopeId, event.idempotencyKey)) throw Object.assign(new Error("duplicate key"), { code: "23505" });
    if (!await this.get(event.scopeId, event.caseId)) throw new Error("scoped case missing"); this.events.push(structuredClone(event));
  }
  async transaction<T>(fn: (repository: RecoveryCasesRepository) => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      const cases = structuredClone([...this.cases]), events = structuredClone(this.events);
      try { return await fn(this); } catch (error) { this.cases.clear(); for (const [key, row] of cases) this.cases.set(key, row); this.events.splice(0, this.events.length, ...events); throw error; }
    });
    this.pending = run.catch(() => undefined); return run;
  }
  async promise(id: string) { return this.promises.get(id); }
  async attendance(id: string) { return this.tickets.get(id); }
  async attendanceByProtocolForCustomer(protocol: string, customerId: string) {
    const rows = [...this.tickets.values()].filter(ticket => ticket.protocol === protocol && ticket.ixcCustomerId === customerId && ticket.identification === "identified");
    return rows.length === 1 ? rows[0] : undefined;
  }
  async latestAttendance(channel: string, conversationId: string) {
    return [...this.tickets.values()].filter(ticket => ticket.channel === channel && ticket.externalConversationId === conversationId).sort((a, b) => b.seq - a.seq)[0];
  }
  async ownerName(id: string) { return this.owners.get(id) ?? null; }
}
