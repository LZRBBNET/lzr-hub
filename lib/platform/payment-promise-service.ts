import { randomUUID } from "node:crypto";
import { asc, desc, eq, and, gt } from "drizzle-orm";
import { paymentPromises } from "../../db/schema.ts";
import { businessToday } from "./billing-service.ts";

/**
 * Promessa de pagamento (issue #16, item 2). Registrada e avaliada só contra
 * dado real: a data vem de quem registrou (hoje, sempre um humano — a IA não
 * tem como chegar até aqui sem identidade de cliente resolvida, ver nota em
 * mass-notice-service.ts sobre o mesmo limite), e "cumprida"/"quebrada" nunca
 * é chutado — vem de perguntar ao IXC se a fatura ainda está aberta.
 */

export type PromiseStatus = "pending" | "fulfilled" | "broken";

export interface PaymentPromiseRow {
  id: string;
  invoiceId: string;
  customerId: string;
  promisedFor: string;
  status: PromiseStatus;
  registeredBy: string;
  correlationId: string;
  createdAt: string;
}

export class PaymentPromiseValidationError extends Error {
  constructor(message: string) { super(message); this.name = "PaymentPromiseValidationError"; }
}

export class PaymentPromiseVerificationError extends Error {
  readonly status: 404 | 409 | 503;
  constructor(message: string, status: 404 | 409 | 503) {
    super(message); this.name = "PaymentPromiseVerificationError"; this.status = status;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Data prometida não pode ser passado (promessa por definição é futura) nem longe demais — mais de 60 dias não é "promessa", é ficção. */
export function parsePromisedFor(value: string, now: Date): string {
  if (!DATE_RE.test(value)) throw new PaymentPromiseValidationError("Data prometida deve estar no formato AAAA-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new PaymentPromiseValidationError("Data prometida inválida");
  }
  const today = businessToday(now);
  if (value < today) throw new PaymentPromiseValidationError("A data prometida não pode estar no passado");
  const maxDays = 60;
  const max = new Date(`${today}T00:00:00Z`); max.setUTCDate(max.getUTCDate() + maxDays);
  if (new Date(`${value}T00:00:00Z`) > max) throw new PaymentPromiseValidationError(`A data prometida não pode passar de ${maxDays} dias`);
  return value;
}

export interface PaymentPromiseRepository {
  create(entry: Omit<PaymentPromiseRow, "id" | "status" | "createdAt">): Promise<PaymentPromiseRow>;
  listByCustomer(customerId: string): Promise<PaymentPromiseRow[]>;
  listPending(): Promise<PaymentPromiseRow[]>;
  listPendingForReview(afterId: string | null, limit: number): Promise<PaymentPromiseRow[]>;
  updateStatus(id: string, status: PromiseStatus): Promise<boolean>;
}

export class DbPaymentPromiseRepository implements PaymentPromiseRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async create(entry: Omit<PaymentPromiseRow, "id" | "status" | "createdAt">): Promise<PaymentPromiseRow> {
    const now = new Date().toISOString();
    const row: PaymentPromiseRow = { id: randomUUID(), status: "pending", createdAt: now, ...entry };
    await this.db.insert(paymentPromises).values({ ...row, updatedAt: now });
    return row;
  }

  async listByCustomer(customerId: string): Promise<PaymentPromiseRow[]> {
    return this.db.select().from(paymentPromises).where(eq(paymentPromises.customerId, customerId)).orderBy(desc(paymentPromises.createdAt));
  }

  async listPending(): Promise<PaymentPromiseRow[]> {
    return this.db.select().from(paymentPromises).where(eq(paymentPromises.status, "pending")).orderBy(desc(paymentPromises.createdAt));
  }

  async listPendingForReview(afterId: string | null, limit: number): Promise<PaymentPromiseRow[]> {
    return this.db.select().from(paymentPromises)
      .where(and(eq(paymentPromises.status, "pending"), afterId ? gt(paymentPromises.id, afterId) : undefined))
      .orderBy(asc(paymentPromises.id)).limit(Math.min(Math.max(limit, 1), PROMISE_REVIEW_BATCH_SIZE + 1));
  }

  async updateStatus(id: string, status: PromiseStatus): Promise<boolean> {
    const changed = await this.db.update(paymentPromises).set({ status, updatedAt: new Date().toISOString() })
      .where(and(eq(paymentPromises.id, id), eq(paymentPromises.status, "pending"))).returning({ id: paymentPromises.id });
    return changed.length === 1;
  }
}

export class MemoryPaymentPromiseRepository implements PaymentPromiseRepository {
  readonly rows: PaymentPromiseRow[] = [];
  async create(entry: Omit<PaymentPromiseRow, "id" | "status" | "createdAt">) {
    const row: PaymentPromiseRow = { id: randomUUID(), status: "pending", createdAt: new Date().toISOString(), ...entry };
    this.rows.push(row);
    return row;
  }
  async listByCustomer(customerId: string) { return this.rows.filter((row) => row.customerId === customerId); }
  async listPending() { return this.rows.filter((row) => row.status === "pending"); }
  async listPendingForReview(afterId: string | null, limit: number) {
    return this.rows.filter((row) => row.status === "pending" && (!afterId || row.id > afterId))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, Math.min(Math.max(limit, 1), PROMISE_REVIEW_BATCH_SIZE + 1));
  }
  async updateStatus(id: string, status: PromiseStatus) {
    const row = this.rows.find((item) => item.id === id && item.status === "pending");
    if (!row) return false;
    row.status = status;
    return true;
  }
}

/**
 * Decide o novo status de uma promessa pendente contra a fatura de verdade —
 * nunca marca "cumprida" ou "quebrada" sem checar o IXC. Promessa que já não
 * está pendente não é reavaliada aqui: uma vez cumprida ou quebrada, o
 * histórico não muda de novo. Não encontrar a fatura não prova pagamento:
 * o snapshot é paginado, e o IXC pode estar indisponível. Cancelamento e
 * código desconhecido também não provam que o cliente cumpriu a promessa.
 */
export function evaluatePendingPromise(promise: { promisedFor: string }, invoiceStatus: string | undefined, today: string): PromiseStatus | "unverified" {
  const status = invoiceStatus?.trim().toUpperCase();
  // R=recebida é o código confirmado no IXC; outro código exige conferência.
  if (status === "R") return "fulfilled";
  if (status !== "A") return "unverified";
  if (promise.promisedFor < today) return "broken";
  return "pending";
}

export interface PromiseReviewResult {
  fulfilled: string[];
  broken: string[];
  stillPending: string[];
  /** Permanecem pendentes no banco: faltou evidência para mudar o estado. */
  unverified: string[];
}

/**
 * Varre as promessas pendentes contra o mapa de status de fatura atual
 * (invoiceId → status, vindo de uma consulta fresca ao IXC) e devolve quem
 * mudou de estado. Não escreve nada — quem chama decide o que fazer com o
 * resultado (ex.: repository.updateStatus para cada id).
 */
export function reviewPendingPromises(promises: PaymentPromiseRow[], invoiceStatusById: Map<string, string>, today: string): PromiseReviewResult {
  const result: PromiseReviewResult = { fulfilled: [], broken: [], stillPending: [], unverified: [] };
  for (const promise of promises) {
    if (promise.status !== "pending") continue;
    const status = evaluatePendingPromise(promise, invoiceStatusById.get(promise.invoiceId), today);
    if (status === "fulfilled") result.fulfilled.push(promise.id);
    else if (status === "broken") result.broken.push(promise.id);
    else if (status === "pending") result.stillPending.push(promise.id);
    else result.unverified.push(promise.id);
  }
  return result;
}

/** Cada clique lê até 20 promessas; nunca varre toda a base ou todas as faturas. */
export const PROMISE_REVIEW_BATCH_SIZE = 20;
const IXC_ID = /^[1-9]\d{0,31}$/;

export function parsePromiseReviewCursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new PaymentPromiseValidationError("Cursor de conferência inválido. Reinicie a conferência.");
  }
  return value;
}

export interface PromiseInvoiceSource {
  getInvoiceForCustomer(customerId: string, invoiceId: string, correlationId: string): Promise<{ id: string; customerId: string; status: string } | undefined>;
}

/**
 * Cria somente após leitura exata e fresca: a página/cache do Customer 360
 * não prova a existência ou a situação atual da fatura. A conexão ao banco
 * e a escrita ficam depois de toda a validação; erro/ausência não vira dívida.
 */
export async function createVerifiedPaymentPromise(
  getRepository: () => Promise<Pick<PaymentPromiseRepository, "create">>,
  source: PromiseInvoiceSource | undefined,
  entry: Omit<PaymentPromiseRow, "id" | "status" | "createdAt">,
  now: Date = new Date(),
): Promise<PaymentPromiseRow> {
  if (!IXC_ID.test(entry.customerId) || !IXC_ID.test(entry.invoiceId)) {
    throw new PaymentPromiseValidationError("Cliente e fatura devem ser códigos válidos do IXC");
  }
  const promisedFor = parsePromisedFor(entry.promisedFor, now);
  if (!source) throw new PaymentPromiseVerificationError("IXC indisponível. Nenhuma promessa foi registrada.", 503);
  let invoice;
  try { invoice = await source.getInvoiceForCustomer(entry.customerId, entry.invoiceId, entry.correlationId); }
  catch { throw new PaymentPromiseVerificationError("Não foi possível confirmar a fatura no IXC. Nenhuma promessa foi registrada.", 503); }
  if (!invoice) throw new PaymentPromiseVerificationError("Fatura não encontrada para o cliente informado. Nenhuma promessa foi registrada.", 404);
  if (invoice.id !== entry.invoiceId || invoice.customerId !== entry.customerId || typeof invoice.status !== "string") {
    throw new PaymentPromiseVerificationError("A identidade ou a situação da fatura não foi confirmada. Nenhuma promessa foi registrada.", 503);
  }
  const status = invoice.status.trim().toUpperCase();
  if (status === "R" || status === "C") {
    throw new PaymentPromiseVerificationError("A fatura não está aberta. Nenhuma promessa foi registrada.", 409);
  }
  if (status !== "A") throw new PaymentPromiseVerificationError("O IXC não confirmou que a fatura está aberta. Nenhuma promessa foi registrada.", 503);
  return (await getRepository()).create({ ...entry, promisedFor });
}

export interface PromiseReviewBatchResult extends PromiseReviewResult {
  examined: number;
  lookupCount: number;
  batchLimit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Uma consulta exata, fresca e escopada por par cliente/fatura distinto do lote.
 * Não depende das primeiras 20 faturas do Customer 360. Cada clique tem teto
 * de 20 leituras lógicas (cada leitura mantém no máximo um retry do adaptador).
 * Cursor por ID da promessa evita que pendentes não verificáveis prendam os
 * lotes seguintes; reiniciar a conferência inclui novamente os IDs anteriores.
 * Ausência, falha, resposta parcial ou divergente nunca provam pagamento.
 */
export async function reconcilePaymentPromises(
  repository: PaymentPromiseRepository,
  source: PromiseInvoiceSource | undefined,
  correlationId: string,
  now: Date = new Date(),
  afterId: string | null = null,
): Promise<PromiseReviewBatchResult> {
  const cursor = parsePromiseReviewCursor(afterId);
  const candidates = await repository.listPendingForReview(cursor, PROMISE_REVIEW_BATCH_SIZE + 1);
  const pending = candidates.slice(0, PROMISE_REVIEW_BATCH_SIZE);
  const hasMore = candidates.length > PROMISE_REVIEW_BATCH_SIZE;
  const result: PromiseReviewBatchResult = {
    fulfilled: [], broken: [], stillPending: [], unverified: [], examined: pending.length,
    lookupCount: 0, batchLimit: PROMISE_REVIEW_BATCH_SIZE, hasMore,
    nextCursor: hasMore ? pending[pending.length - 1].id : null,
  };
  const today = businessToday(now);
  const evidence = new Map<string, string | undefined>();
  for (const promise of pending) {
    if (promise.status !== "pending") continue;
    const key = JSON.stringify([promise.customerId, promise.invoiceId]);
    if (!evidence.has(key)) {
      let status: string | undefined;
      if (source && IXC_ID.test(promise.customerId) && IXC_ID.test(promise.invoiceId)) {
        result.lookupCount++;
        try {
          const invoice = await source.getInvoiceForCustomer(promise.customerId, promise.invoiceId, correlationId);
          if (invoice?.id === promise.invoiceId && invoice.customerId === promise.customerId && typeof invoice.status === "string") status = invoice.status;
        } catch { /* Não substitui erro por dívida quitada ou vencida. */ }
      }
      evidence.set(key, status);
    }
    const status = evaluatePendingPromise(promise, evidence.get(key), today);
    if (status === "fulfilled" || status === "broken") {
      // Outra revisão pode ter encerrado a promessa enquanto o IXC respondia.
      if (await repository.updateStatus(promise.id, status)) result[status].push(promise.id);
      else result.unverified.push(promise.id);
    } else if (status === "pending") result.stillPending.push(promise.id);
    else result.unverified.push(promise.id);
  }
  return result;
}
