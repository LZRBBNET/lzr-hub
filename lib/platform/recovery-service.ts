import { asc, desc, inArray, lte, sql } from "drizzle-orm";
import { paymentPromises } from "../../db/schema.ts";
import type { IxcServiceDiagnosisData } from "../integrations/ixc/types.ts";
import { businessToday } from "./billing-service.ts";
import { INTERNET_STATUS } from "./connection-diagnosis-shared.ts";
import type { RecoveryCustomerDetail, RecoveryCustomerRow, RecoveryPayload, RecoveryPromise, RecoveryPromiseHistory } from "./recovery-shared.ts";

export const RECOVERY_MAX_PAGES = 2;
export const RECOVERY_IXC_PAGE_SIZE = 500;
export const RECOVERY_MAX_INVOICES = RECOVERY_MAX_PAGES * RECOVERY_IXC_PAGE_SIZE;
export const RECOVERY_PROMISES_PER_CUSTOMER = 20;
const MAX_PAGE_SIZE = 50;

export interface RecoveryProvider {
  listOverdueInvoices(today: string, correlationId: string, maxPages: number, pageSize: number): Promise<{ rows: Record<string, unknown>[]; total: number; truncated: boolean }>;
  getCustomerRecord(customerId: string, correlationId: string): Promise<Record<string, unknown> | undefined>;
  getServiceDiagnosis(customerId: string, correlationId: string): Promise<IxcServiceDiagnosisData>;
}
export interface RecoveryPromiseRepository {
  listForCustomers(customerIds: string[], maxPerCustomer: number): Promise<Map<string, RecoveryPromiseHistory>>;
}

function calendarDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}
function numericId(raw: unknown): string | null {
  const value = typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
  return /^[1-9]\d{0,31}$/.test(value) ? value : null;
}
function moneyCents(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const value = typeof raw === "number" ? raw : /^\d+(?:[.,]\d+)?$/.test(raw.trim()) ? Number(raw.trim().replace(",", ".")) : NaN;
  const cents = Math.round(value * 100);
  return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(cents) ? cents : null;
}
const hasAmount = (value: unknown) => value !== null && value !== undefined && !(typeof value === "string" && !value.trim());

export function parseRecoveryPage(params: URLSearchParams): { page: number; pageSize: number } {
  const read = (name: string, fallback: number, max: number) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new Error("Página ou tamanho de página inválido");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) throw new Error("Página ou tamanho de página inválido");
    return value;
  };
  return { page: read("page", 1, RECOVERY_MAX_INVOICES), pageSize: read("pageSize", 20, MAX_PAGE_SIZE) };
}

function safePromise(row: Record<string, unknown>): RecoveryPromise {
  const status = row.status === "pending" || row.status === "fulfilled" || row.status === "broken" ? row.status : "unknown";
  return {
    id: String(row.id), invoiceId: String(row.invoiceId), promisedFor: calendarDate(row.promisedFor), status,
    createdAt: typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : null,
  };
}

/** O limite é por cliente, não global: um histórico longo não apaga os demais. */
export class DbRecoveryPromiseRepository implements RecoveryPromiseRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async listForCustomers(customerIds: string[], maxPerCustomer: number): Promise<Map<string, RecoveryPromiseHistory>> {
    const ids = [...new Set(customerIds)].slice(0, MAX_PAGE_SIZE);
    const limit = Math.min(Math.max(maxPerCustomer, 1), RECOVERY_PROMISES_PER_CUSTOMER);
    const result = new Map(ids.map((id) => [id, { available: true, rows: [] as RecoveryPromise[], truncated: false }]));
    if (!ids.length) return result;
    const ranked = this.db.select({
      id: paymentPromises.id, customerId: paymentPromises.customerId, invoiceId: paymentPromises.invoiceId,
      promisedFor: paymentPromises.promisedFor, status: paymentPromises.status, createdAt: paymentPromises.createdAt,
      position: sql<number>`row_number() over (partition by ${paymentPromises.customerId} order by ${paymentPromises.createdAt} desc, ${paymentPromises.id} desc)`.as("position"),
    }).from(paymentPromises).where(inArray(paymentPromises.customerId, ids)).as("recovery_promises");
    const rows: Array<Record<string, unknown>> = await this.db.select().from(ranked).where(lte(ranked.position, limit + 1)).orderBy(asc(ranked.customerId), desc(ranked.createdAt), desc(ranked.id));
    for (const row of rows) {
      const history = result.get(String(row.customerId));
      if (!history) continue;
      if (history.rows.length < limit) history.rows.push(safePromise(row));
      else history.truncated = true;
    }
    return result;
  }
}

export function unavailableRecovery(page: number, pageSize: number, now: Date, detail: string): RecoveryPayload {
  return {
    available: false, detail, fetchedAt: null, referenceDate: businessToday(now), scope: "unavailable", page, pageSize,
    totalCustomers: null, rows: [], coverage: { scannedInvoices: null, totalOverdueInvoices: null, truncated: false, excludedInvoices: 0, maxInvoices: RECOVERY_MAX_INVOICES },
    sources: { ixc: "unavailable", promises: "not-consulted" }, summary: null,
  };
}

/**
 * A fila é um recorte explícito, não um censo: no máximo duas páginas do IXC.
 * Não carrega cadastro, contato ou diagnóstico por linha. Nome e bloqueio são
 * consulta sob demanda; atraso nunca vira duração de bloqueio por dedução.
 */
export async function loadRecovery(
  provider: RecoveryProvider,
  getPromises: () => Promise<RecoveryPromiseRepository>,
  options: { page: number; pageSize: number; correlationId: string; now: Date },
): Promise<RecoveryPayload> {
  const { page, pageSize, correlationId, now } = options;
  const today = businessToday(now);
  let listing;
  try { listing = await provider.listOverdueInvoices(today, correlationId, RECOVERY_MAX_PAGES, RECOVERY_IXC_PAGE_SIZE); }
  catch { return unavailableRecovery(page, pageSize, now, "Consulta de faturas do IXC indisponível. Nenhum valor foi estimado."); }
  const rawRows = listing.rows.slice(0, RECOVERY_MAX_INVOICES);
  const total = Number.isSafeInteger(listing.total) && listing.total >= rawRows.length ? listing.total : null;
  const truncated = listing.truncated || listing.rows.length > RECOVERY_MAX_INVOICES || (total !== null && total > rawRows.length);
  const grouped = new Map<string, RecoveryCustomerRow & { cents: number; knownAmounts: number }>();
  const seen = new Set<string>();
  let excludedInvoices = 0;
  for (const raw of rawRows) {
    const invoiceId = numericId(raw.id), customerId = numericId(raw.id_cliente), dueAt = calendarDate(raw.data_vencimento);
    if (!invoiceId || !customerId || !dueAt || dueAt >= today || raw.status !== "A" || seen.has(invoiceId)) { excludedInvoices += 1; continue; }
    seen.add(invoiceId);
    const fallback = !hasAmount(raw.valor_aberto);
    const cents = moneyCents(fallback ? raw.valor : raw.valor_aberto);
    let row = grouped.get(customerId);
    if (!row) {
      row = {
        customerId, customerName: null, overdueInvoices: 0, knownOverdueValue: null, amountIncomplete: truncated || total === null,
        faceValueFallbackInvoices: 0, oldestDueAt: dueAt, daysOverdue: 0, blockedSince: null, daysBlocked: null,
        aiContactStatus: null, predictiveRisk: null, promises: { available: false, rows: [], truncated: false },
        humanReview: { reason: "Conferir as faturas vencidas antes de qualquer contato." }, cents: 0, knownAmounts: 0,
      };
      grouped.set(customerId, row);
    }
    row.overdueInvoices += 1;
    if (dueAt < row.oldestDueAt) row.oldestDueAt = dueAt;
    if (cents === null || !Number.isSafeInteger(row.cents + cents)) row.amountIncomplete = true;
    else { row.cents += cents; row.knownAmounts += 1; if (fallback) row.faceValueFallbackInvoices += 1; }
  }
  const all = [...grouped.values()].map(({ cents, knownAmounts, ...row }) => ({
    ...row, knownOverdueValue: knownAmounts ? cents / 100 : null,
    daysOverdue: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.oldestDueAt}T00:00:00Z`)) / 86_400_000),
  })).sort((a, b) => b.daysOverdue - a.daysOverdue || a.customerId.localeCompare(b.customerId));
  const rows = all.slice((page - 1) * pageSize, page * pageSize);
  let promisesState: RecoveryPayload["sources"]["promises"] = "not-consulted";
  if (rows.length) {
    try {
      const histories = await (await getPromises()).listForCustomers(rows.map((row) => row.customerId), RECOVERY_PROMISES_PER_CUSTOMER);
      promisesState = "available";
      for (const row of rows) {
        row.promises = histories.get(row.customerId) ?? { available: false, rows: [], truncated: false };
        if (!row.promises.available || row.promises.truncated) promisesState = "partial";
        if (row.promises.rows.some((promise) => promise.status === "broken")) {
          row.humanReview.reason = "O histórico contém promessa marcada como quebrada. Conferir a situação atual da fatura antes de agir.";
        } else if (row.daysOverdue >= 30) row.humanReview.reason = `Fatura há ${row.daysOverdue} dias vencida; revisar o cadastro e a dívida antes de qualquer contato.`;
      }
    } catch { promisesState = "unavailable"; }
  }
  const knownValues = all.flatMap((row) => row.knownOverdueValue === null ? [] : [row.knownOverdueValue]);
  const knownCents = knownValues.reduce((sum, value) => sum + Math.round(value * 100), 0);
  const amountIncomplete = truncated || total === null || excludedInvoices > 0 || all.some((row) => row.amountIncomplete) || !Number.isSafeInteger(knownCents);
  return {
    available: true, fetchedAt: now.toISOString(), referenceDate: today, scope: "full-base", page, pageSize,
    totalCustomers: all.length, rows, coverage: { scannedInvoices: rawRows.length, totalOverdueInvoices: total, truncated, excludedInvoices, maxInvoices: RECOVERY_MAX_INVOICES },
    sources: { ixc: truncated || excludedInvoices > 0 || amountIncomplete || total === null ? "partial" : "available", promises: promisesState },
    summary: { customers: all.length, overdueInvoices: all.reduce((sum, row) => sum + row.overdueInvoices, 0), knownOverdueValue: knownValues.length && Number.isSafeInteger(knownCents) ? knownCents / 100 : all.length || excludedInvoices || total !== 0 || truncated ? null : 0,
      amountIncomplete, faceValueFallbackInvoices: all.reduce((sum, row) => sum + row.faceValueFallbackInvoices, 0) },
  };
}

export async function loadRecoveryCustomer(provider: RecoveryProvider, customerId: string, correlationId: string, now: Date): Promise<RecoveryCustomerDetail> {
  const [customer, diagnosis] = await Promise.allSettled([
    provider.getCustomerRecord(customerId, correlationId), provider.getServiceDiagnosis(customerId, correlationId),
  ]);
  const record = customer.status === "fulfilled" && numericId(customer.value?.id) === customerId ? customer.value : undefined;
  const rawName = record?.razao ?? record?.nome;
  const name = typeof rawName === "string" ? rawName.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 200) || null : null;
  const contracts = diagnosis.status === "fulfilled" ? diagnosis.value.contracts.slice(0, 5).map((contract) => {
    const code = /^[A-Z]{1,3}$/.test(contract.internetStatus) ? contract.internetStatus : "";
    const contractStatus = /^[A-Z]{1,3}$/.test(contract.status) ? contract.status : "";
    const trustUnlockActive = contract.trustUnlockKnown === true ? contract.trustUnlockActive : null;
    // O código de internet isolado pode pertencer a contrato encerrado ou liberado por confiança.
    const blocked = contractStatus === "A" && ["CM", "CA", "FA"].includes(code) && trustUnlockActive === false;
    return { id: contract.id, contractStatus, internetStatus: code, trustUnlockActive, label: INTERNET_STATUS[code] ?? (code ? `código ${code}` : "status não informado"), blocked };
  }) : [];
  const available = !!record || diagnosis.status === "fulfilled";
  return {
    available, customerId, customerName: name, observedAt: available ? now.toISOString() : null,
    ...(!available ? { detail: "Cadastro e contratos indisponíveis no IXC. Nenhum bloqueio foi inferido." } : {}),
    contracts, blockStatus: contracts.some((contract) => contract.blocked) ? "blocked-observed" : "inconclusive",
    contractsLimit: 5, blockedSince: null, daysBlocked: null,
    sources: { customer: record ? "available" : "unavailable", contracts: diagnosis.status === "fulfilled" ? "available" : "unavailable" },
  };
}

export type RecoveryAccess = { allowed: false; status: 401 | 403; error: string } | { allowed: true; user?: unknown };
export interface RecoveryDependencies {
  authorize(request: Request, permission: string): Promise<RecoveryAccess>;
  getRuntime(): { config: { ixcFullBase: boolean }; provider?: RecoveryProvider } | undefined;
  getPromises(): Promise<RecoveryPromiseRepository>;
  now?: () => Date;
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

/** O guard executa antes de resolver runtime/banco, inclusive nas rotas de detalhe. */
export function createRecoveryGetHandler(dependencies: RecoveryDependencies, detail = false) {
  return async (request: Request): Promise<Response> => {
    const guard = await dependencies.authorize(request, "customer.read");
    if (!guard.allowed) return json({ error: guard.error }, guard.status);
    if (!guard.user) return json({ error: "A recuperação exige sessão autenticada." }, 401);
    const params = new URL(request.url).searchParams;
    let pagination;
    try { pagination = parseRecoveryPage(params); } catch { return json({ error: "Página inválida. Use page positivo e pageSize entre 1 e 50." }, 400); }
    const customerId = detail ? numericId(params.get("customerId")) : null;
    if (detail && !customerId) return json({ error: "Informe um customerId numérico válido." }, 400);
    const now = dependencies.now?.() ?? new Date();
    let runtime;
    try { runtime = dependencies.getRuntime(); } catch { runtime = undefined; }
    if (!runtime?.provider || !runtime.config.ixcFullBase) {
      const reason = runtime?.provider ? "Recuperação exige leitura da base inteira. A allowlist não representa a carteira." : "IXC indisponível: sem fonte de faturas para recuperação.";
      return json(detail ? { available: false, customerId, customerName: null, observedAt: null, detail: reason, contracts: [], blockStatus: "inconclusive", contractsLimit: 5, blockedSince: null, daysBlocked: null, sources: { customer: "unavailable", contracts: "unavailable" } } : unavailableRecovery(pagination.page, pagination.pageSize, now, reason));
    }
    const correlationId = crypto.randomUUID();
    if (detail) return json(await loadRecoveryCustomer(runtime.provider, customerId!, correlationId, now));
    return json(await loadRecovery(runtime.provider, dependencies.getPromises, { ...pagination, correlationId, now }));
  };
}
