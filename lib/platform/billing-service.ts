import type { IxcCustomerSnapshot, IxcInvoiceDto } from "../integrations/ixc/types.ts";

/** Observed financial evidence, never an estimate of missing balances or receipts. */
export function isOpenInvoice(status: string): boolean {
  return /^(a|aberta|aberto|em aberto)$/i.test(status.trim());
}
const isClosedInvoice = (status: string) => /^(r|p|c|pago|paga|recebido|recebida|cancelado|cancelada|baixado|baixada|estornado|estornada)$/i.test(status.trim());

export interface AgingBucket { label: string; minDays: number; maxDays: number | null; invoices: number; value: number | null }
export interface BillingOverview {
  scope: "allowlist";
  customersConsulted: number;
  customersUnavailable: number;
  openInvoices: number;
  openValue: number | null;
  overdueInvoices: number;
  overdueValue: number | null;
  upcomingInvoices: number;
  upcomingValue: number | null;
  aging: AgingBucket[];
  amountIncomplete: boolean;
  excludedInvoices: number;
  paymentsInPeriod: number;
  paidInPeriod: number | null;
  paymentsIncomplete: boolean;
  excludedPayments: number;
  paymentMethods: Record<string, number>;
  /** Open invoices without a valid calendar due date cannot be aged. */
  invoicesWithoutDueDate: number;
}

/** Counts come from the source; balances cover only validated rows actually read. */
export interface FullBaseBilling {
  scope: "full-base";
  openInvoices: number;
  openValue: null;
  overdueInvoices: number;
  overdueValue: number | null;
  overdueScanned: number;
  truncated: boolean;
  amountIncomplete: boolean;
  excludedInvoices: number;
  aging: AgingBucket[];
  invoicesWithoutDueDate: number;
}

const BUCKETS: Array<Omit<AgingBucket, "invoices" | "value">> = [
  { label: "1–5 dias", minDays: 1, maxDays: 5 },
  { label: "6–15 dias", minDays: 6, maxDays: 15 },
  { label: "16–30 dias", minDays: 16, maxDays: 30 },
  { label: "31+ dias", minDays: 31, maxDays: null },
];
const SAO_PAULO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
export const businessToday = (now: Date) => SAO_PAULO.format(now);

function calendarDate(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : undefined;
}
export function daysOverdue(dueAt: string | undefined, now: Date): number | undefined {
  const due = calendarDate(dueAt);
  if (!due) return undefined;
  return Math.round((Date.parse(`${businessToday(now)}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);
}

type Money = { cents: number; known: number };
const emptyMoney = (): Money => ({ cents: 0, known: 0 });
function centsOf(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}
function addMoney(total: Money, cents: number | undefined): boolean {
  if (cents === undefined || !Number.isSafeInteger(total.cents + cents)) return false;
  total.cents += cents;
  total.known++;
  return true;
}
const moneyValue = (total: Money, incomplete: boolean) => !total.known && incomplete ? null : total.cents / 100;
const agingState = () => BUCKETS.map((bucket) => ({ ...bucket, invoices: 0, total: emptyMoney() }));
const agingResult = (aging: ReturnType<typeof agingState>, incomplete: boolean): AgingBucket[] => aging.map(({ total, ...bucket }) => ({ ...bucket, value: moneyValue(total, incomplete) }));
function idCounts(rows: Array<{ id: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return counts;
}
function validIdentity(row: { id: string; customerId: string }, counts: Map<string, number>, customerId?: string): boolean {
  return typeof row.id === "string" && !!row.id.trim() && typeof row.customerId === "string" && !!row.customerId.trim()
    && counts.get(row.id) === 1 && (customerId === undefined || row.customerId === customerId);
}
function completeSource(snapshot: IxcCustomerSnapshot, source: "invoices" | "payments"): boolean {
  const metadata = snapshot.coverage?.[source];
  const count = snapshot[source].length;
  const limit = source === "invoices" ? 20 : 100;
  return !snapshot.partialSources.includes(source) && metadata?.complete === true
    && Number.isSafeInteger(metadata.total) && metadata.total === count && metadata.read === count && count <= limit;
}

export function summarizeFullBase(
  invoices: IxcInvoiceDto[],
  options: { now: Date; overdueTotal: number; openCount: number; truncated: boolean },
): FullBaseBilling {
  const aging = agingState(), total = emptyMoney(), counts = idCounts(invoices);
  let excludedInvoices = 0, invoicesWithoutDueDate = 0;
  let amountIncomplete = options.truncated || options.overdueTotal !== invoices.length;
  for (const invoice of invoices) {
    if (!validIdentity(invoice, counts) || !isOpenInvoice(invoice.status)) { excludedInvoices++; continue; }
    const days = daysOverdue(invoice.dueAt, options.now);
    if (days === undefined) { invoicesWithoutDueDate++; excludedInvoices++; continue; }
    if (days < 1) { excludedInvoices++; continue; }
    const cents = invoice.valueSource === "open-balance" ? centsOf(invoice.value) : undefined;
    const bucket = aging.find((item) => days >= item.minDays && (item.maxDays === null || days <= item.maxDays))!;
    bucket.invoices++;
    if (!addMoney(total, cents)) { excludedInvoices++; continue; }
    addMoney(bucket.total, cents);
  }
  amountIncomplete ||= excludedInvoices > 0;
  return {
    scope: "full-base", openInvoices: options.openCount, openValue: null,
    overdueInvoices: options.overdueTotal, overdueValue: moneyValue(total, amountIncomplete),
    overdueScanned: invoices.length, truncated: options.truncated, amountIncomplete, excludedInvoices,
    aging: agingResult(aging, amountIncomplete), invoicesWithoutDueDate,
  };
}

/** Exact instants use the inclusive interval. A date without a zone/time is not an instant. */
function paymentInPeriod(raw: string | undefined, since: Date, now: Date): "inside" | "outside" | "unknown" {
  if (!raw || !Number.isFinite(since.getTime()) || since > now) return "unknown";
  let date = calendarDate(raw);
  if (!date) {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
    if (!match || !calendarDate(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return "unknown";
    date = match[1];
    if (match[5]) {
      if (match[5] !== "Z" && (+match[5].slice(1, 3) > 23 || +match[5].slice(4) > 59)) return "unknown";
      const instant = new Date(raw.replace(" ", "T"));
      if (!Number.isFinite(instant.getTime()) || instant > now) return "unknown";
      return instant >= since ? "inside" : "outside";
    }
  }
  const firstDay = businessToday(since), lastDay = businessToday(now);
  if (date < firstDay) return "outside";
  // Only full interior calendar days are certainly within the requested interval.
  return date > firstDay && date < lastDay ? "inside" : "unknown";
}

export function summarizeBilling(
  snapshots: IxcCustomerSnapshot[],
  options: { now: Date; unavailable: number; paymentsSinceIso: string },
): BillingOverview {
  const aging = agingState(), open = emptyMoney(), overdue = emptyMoney(), upcoming = emptyMoney(), paid = emptyMoney();
  const invoiceIds = idCounts(snapshots.flatMap((snapshot) => snapshot.invoices));
  const paymentIds = idCounts(snapshots.flatMap((snapshot) => snapshot.payments));
  let amountIncomplete = options.unavailable > 0 || snapshots.some((snapshot) => !completeSource(snapshot, "invoices"));
  let paymentsIncomplete = options.unavailable > 0 || snapshots.some((snapshot) => !completeSource(snapshot, "payments"));
  let openInvoices = 0, overdueInvoices = 0, upcomingInvoices = 0, invoicesWithoutDueDate = 0, excludedInvoices = 0;
  let paymentsInPeriod = 0, excludedPayments = 0;
  const paymentMethods: Record<string, number> = {};
  const since = new Date(options.paymentsSinceIso);

  for (const snapshot of snapshots) {
    for (const invoice of snapshot.invoices) {
      if (!validIdentity(invoice, invoiceIds, snapshot.customer.id)) { excludedInvoices++; continue; }
      if (isClosedInvoice(invoice.status)) continue;
      if (!isOpenInvoice(invoice.status)) { excludedInvoices++; continue; }
      openInvoices++;
      const cents = invoice.valueSource === "open-balance" ? centsOf(invoice.value) : undefined;
      const known = addMoney(open, cents);
      const days = daysOverdue(invoice.dueAt, options.now);
      if (days === undefined) { invoicesWithoutDueDate++; excludedInvoices++; continue; }
      if (days < 1) {
        upcomingInvoices++;
        if (!known || !addMoney(upcoming, cents)) excludedInvoices++;
      } else {
        overdueInvoices++;
        const bucket = aging.find((item) => days >= item.minDays && (item.maxDays === null || days <= item.maxDays))!;
        bucket.invoices++;
        if (!known || !addMoney(overdue, cents)) { excludedInvoices++; continue; }
        addMoney(bucket.total, cents);
      }
    }
    for (const payment of snapshot.payments) {
      if (!validIdentity(payment, paymentIds, snapshot.customer.id)) { excludedPayments++; continue; }
      const period = paymentInPeriod(payment.paidAt, since, options.now);
      if (period === "outside") continue;
      if (period === "unknown") { excludedPayments++; continue; }
      paymentsInPeriod++;
      // An upstream method name is a data key, never a prototype setter.
      const method = payment.method || "Não informado";
      Object.defineProperty(paymentMethods, method, { value: (Object.hasOwn(paymentMethods, method) ? paymentMethods[method] : 0) + 1, enumerable: true, configurable: true });
      if (!addMoney(paid, centsOf(payment.value))) excludedPayments++;
    }
  }
  amountIncomplete ||= excludedInvoices > 0;
  paymentsIncomplete ||= excludedPayments > 0;
  return {
    scope: "allowlist", customersConsulted: snapshots.length, customersUnavailable: options.unavailable,
    openInvoices, openValue: moneyValue(open, amountIncomplete), overdueInvoices, overdueValue: moneyValue(overdue, amountIncomplete),
    upcomingInvoices, upcomingValue: moneyValue(upcoming, amountIncomplete), aging: agingResult(aging, amountIncomplete),
    amountIncomplete, excludedInvoices, invoicesWithoutDueDate,
    paymentsInPeriod, paidInPeriod: moneyValue(paid, paymentsIncomplete), paymentsIncomplete, excludedPayments, paymentMethods,
  };
}
