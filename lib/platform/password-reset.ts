import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { passwordResetRequests } from "../../db/schema.ts";

/**
 * Recuperação de senha **sem e-mail**.
 *
 * O LZR HUB não tem envio de e-mail — não há SMTP nem provedor configurado —
 * então o fluxo clássico de link de redefinição não existe. Fingir que existe
 * seria pior: a pessoa clicaria, nada chegaria, e ela concluiria que o sistema
 * está quebrado em vez de procurar alguém.
 *
 * O que existe é o que a tela de login já dizia: a pessoa registra o pedido e
 * quem administra resolve gerando uma senha nova. As contas são criadas
 * internamente, então já há um humano nesse caminho.
 *
 * O pedido é aceito **exista a conta ou não**, com a mesma resposta: recusar
 * e-mail desconhecido transformaria esta tela num verificador de quais
 * endereços têm conta na BBNET.
 */
export interface ResetRequest { id: string; email: string; status: string; note: string | null; resolvedBy: string | null; resolvedAt: string | null; createdAt: string }

export interface PasswordResetRepository {
  create(email: string, note: string | null): Promise<void>;
  listPending(limit: number): Promise<ResetRequest[]>;
  resolve(id: string, resolvedBy: string, status: "resolved" | "dismissed"): Promise<ResetRequest | undefined>;
  hasPendingFor(email: string): Promise<boolean>;
}

export const MAX_NOTE_LENGTH = 300;

export function parseResetRequest(body: Record<string, unknown>) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE_LENGTH) : "";
  // Formato mínimo só para não encher a tabela de lixo; não diz nada sobre existir.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return undefined;
  return { email, note: note || null };
}

const toRequest = (row: Record<string, unknown>): ResetRequest => ({
  id: String(row.id), email: String(row.email), status: String(row.status),
  note: row.note ? String(row.note) : null,
  resolvedBy: row.resolvedBy ? String(row.resolvedBy) : null,
  resolvedAt: row.resolvedAt ? String(row.resolvedAt) : null,
  createdAt: String(row.createdAt),
});

export class DbPasswordResetRepository implements PasswordResetRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async create(email: string, note: string | null) {
    // Um pedido pendente por e-mail basta: repetir o clique não deve gerar fila.
    if (await this.hasPendingFor(email)) return;
    await this.db.insert(passwordResetRequests).values({
      id: randomUUID(), email, status: "pending", note, resolvedBy: null, resolvedAt: null, createdAt: new Date().toISOString(),
    });
  }
  async hasPendingFor(email: string) {
    const rows = await this.db.select().from(passwordResetRequests)
      .where(and(eq(passwordResetRequests.email, email), eq(passwordResetRequests.status, "pending"))).limit(1);
    return rows.length > 0;
  }
  async listPending(limit: number) {
    const rows = await this.db.select().from(passwordResetRequests)
      .where(eq(passwordResetRequests.status, "pending"))
      .orderBy(desc(passwordResetRequests.createdAt)).limit(limit);
    return rows.map(toRequest);
  }
  async resolve(id: string, resolvedBy: string, status: "resolved" | "dismissed") {
    const updated = await this.db.update(passwordResetRequests)
      .set({ status, resolvedBy, resolvedAt: new Date().toISOString() })
      .where(eq(passwordResetRequests.id, id)).returning();
    return updated[0] ? toRequest(updated[0]) : undefined;
  }
}

export class MemoryPasswordResetRepository implements PasswordResetRepository {
  readonly requests: ResetRequest[] = [];
  async create(email: string, note: string | null) {
    if (await this.hasPendingFor(email)) return;
    this.requests.push({ id: randomUUID(), email, status: "pending", note, resolvedBy: null, resolvedAt: null, createdAt: new Date().toISOString() });
  }
  async hasPendingFor(email: string) { return this.requests.some((item) => item.email === email && item.status === "pending"); }
  async listPending(limit: number) { return this.requests.filter((item) => item.status === "pending").slice(0, limit); }
  async resolve(id: string, resolvedBy: string, status: "resolved" | "dismissed") {
    const request = this.requests.find((item) => item.id === id);
    if (!request) return undefined;
    request.status = status; request.resolvedBy = resolvedBy; request.resolvedAt = new Date().toISOString();
    return request;
  }
}
