import { randomUUID } from "node:crypto";
import { desc, eq, and } from "drizzle-orm";
import { paymentPromises } from "../../db/schema.ts";
import { businessToday } from "./billing-service.ts";
import type { IxcCustomerSnapshot } from "../integrations/ixc/types.ts";

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Data prometida não pode ser passado (promessa por definição é futura) nem longe demais — mais de 60 dias não é "promessa", é ficção. */
export function parsePromisedFor(value: string, now: Date): string {
  if (!DATE_RE.test(value)) throw new PaymentPromiseValidationError("Data prometida deve estar no formato AAAA-MM-DD");
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
  updateStatus(id: string, status: PromiseStatus): Promise<void>;
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

  async updateStatus(id: string, status: PromiseStatus): Promise<void> {
    await this.db.update(paymentPromises).set({ status, updatedAt: new Date().toISOString() }).where(and(eq(paymentPromises.id, id)));
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
  async updateStatus(id: string, status: PromiseStatus) {
    const row = this.rows.find((item) => item.id === id);
    if (row) row.status = status;
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

export interface PromiseInvoiceSource {
  getSnapshot(customerId: string, correlationId: string, force: boolean): Promise<Pick<IxcCustomerSnapshot, "invoices" | "partialSources">>;
}

/**
 * Uma consulta fresca por cliente, sem reutilizar o cache do Customer 360.
 * Ausência, falha e fonte parcial preservam as promessas para nova conferência;
 * só evidência positiva altera o banco. Nunca envia cobrança nem escreve no IXC.
 */
export async function reconcilePaymentPromises(
  repository: PaymentPromiseRepository,
  source: PromiseInvoiceSource | undefined,
  correlationId: string,
  now: Date = new Date(),
): Promise<PromiseReviewResult> {
  const pending = await repository.listPending();
  const byCustomer = new Map<string, PaymentPromiseRow[]>();
  for (const promise of pending) byCustomer.set(promise.customerId, [...(byCustomer.get(promise.customerId) ?? []), promise]);
  const result: PromiseReviewResult = { fulfilled: [], broken: [], stillPending: [], unverified: [] };
  const today = businessToday(now);

  for (const [customerId, promises] of byCustomer) {
    const snapshot = await source?.getSnapshot(customerId, correlationId, true).catch(() => undefined);
    const invoices = snapshot && !snapshot.partialSources.includes("invoices") ? snapshot.invoices : [];
    // A evidência de um cadastro nunca liquida a promessa de outro, mesmo se
    // uma resposta do provedor contiver uma linha que não pertence ao cliente.
    const statuses = new Map(invoices.filter((invoice) => invoice.customerId === customerId).map((invoice) => [invoice.id, invoice.status]));
    const reviewed = reviewPendingPromises(promises, statuses, today);
    for (const id of reviewed.fulfilled) await repository.updateStatus(id, "fulfilled");
    for (const id of reviewed.broken) await repository.updateStatus(id, "broken");
    result.fulfilled.push(...reviewed.fulfilled);
    result.broken.push(...reviewed.broken);
    result.stillPending.push(...reviewed.stillPending);
    result.unverified.push(...reviewed.unverified);
  }
  return result;
}
