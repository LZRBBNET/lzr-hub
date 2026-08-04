import type { IxcCustomerSnapshot, IxcInvoiceDto, IxcPaymentDto } from "../integrations/ixc/types.ts";

/**
 * Posição financeira real, calculada das faturas e pagamentos do IXC.
 *
 * Toda a agregação é função pura sobre os snapshots já buscados: dá para provar
 * o cálculo de atraso e de valor em aberto sem banco e sem rede.
 *
 * O escopo é a allowlist do IXC — o ERP não expõe busca aberta da base — e a
 * resposta declara isso, para ninguém ler "R$ X em aberto" como se fosse a
 * carteira inteira da BBNET.
 */

/** No fn_areceber do IXC, "R" é recebido e "P" pago; o resto continua em aberto. */
export function isOpenInvoice(status: string): boolean {
  return !/^[PR]$/i.test(status.trim()) && !/pago|recebido|cancelad/i.test(status);
}

export interface AgingBucket { label: string; minDays: number; maxDays: number | null; invoices: number; value: number }
export interface BillingOverview {
  scope: "allowlist";
  customersConsulted: number;
  customersUnavailable: number;
  openInvoices: number;
  openValue: number;
  overdueInvoices: number;
  overdueValue: number;
  /** Faturas em aberto que ainda não venceram — não são inadimplência. */
  upcomingInvoices: number;
  upcomingValue: number;
  aging: AgingBucket[];
  paymentsInPeriod: number;
  paidInPeriod: number;
  paymentMethods: Record<string, number>;
  /** Faturas em aberto sem data de vencimento legível: contadas à parte, nunca chutadas para uma faixa. */
  invoicesWithoutDueDate: number;
}

const BUCKETS: Array<Omit<AgingBucket, "invoices" | "value">> = [
  { label: "1–5 dias", minDays: 1, maxDays: 5 },
  { label: "6–15 dias", minDays: 6, maxDays: 15 },
  { label: "16–30 dias", minDays: 16, maxDays: 30 },
  { label: "31+ dias", minDays: 31, maxDays: null },
];

/** Datas do IXC vêm como AAAA-MM-DD. Formato diferente devolve undefined em vez de NaN silencioso. */
export function daysOverdue(dueAt: string | undefined, now: Date): number | undefined {
  if (!dueAt) return undefined;
  const parsed = new Date(`${dueAt.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today.getTime() - parsed.getTime()) / 86400000);
}

export function summarizeBilling(
  snapshots: IxcCustomerSnapshot[],
  options: { now: Date; unavailable: number; paymentsSinceIso: string },
): BillingOverview {
  const invoices: IxcInvoiceDto[] = snapshots.flatMap((snapshot) => snapshot.invoices);
  const payments: IxcPaymentDto[] = snapshots.flatMap((snapshot) => snapshot.payments);
  const open = invoices.filter((invoice) => isOpenInvoice(invoice.status));

  const aging: AgingBucket[] = BUCKETS.map((bucket) => ({ ...bucket, invoices: 0, value: 0 }));
  let overdueInvoices = 0, overdueValue = 0, upcomingInvoices = 0, upcomingValue = 0, invoicesWithoutDueDate = 0;

  for (const invoice of open) {
    const value = invoice.value ?? 0;
    const days = daysOverdue(invoice.dueAt, options.now);
    if (days === undefined) { invoicesWithoutDueDate += 1; continue; }
    if (days < 1) { upcomingInvoices += 1; upcomingValue += value; continue; }
    overdueInvoices += 1; overdueValue += value;
    const bucket = aging.find((item) => days >= item.minDays && (item.maxDays === null || days <= item.maxDays));
    if (bucket) { bucket.invoices += 1; bucket.value += value; }
  }

  const inPeriod = payments.filter((payment) => (payment.paidAt ?? "") >= options.paymentsSinceIso.slice(0, 10));
  const paymentMethods: Record<string, number> = {};
  for (const payment of inPeriod) paymentMethods[payment.method] = (paymentMethods[payment.method] ?? 0) + 1;

  return {
    scope: "allowlist",
    customersConsulted: snapshots.length,
    customersUnavailable: options.unavailable,
    openInvoices: open.length,
    openValue: open.reduce((sum, invoice) => sum + (invoice.value ?? 0), 0),
    overdueInvoices, overdueValue, upcomingInvoices, upcomingValue,
    aging,
    paymentsInPeriod: inPeriod.length,
    paidInPeriod: inPeriod.reduce((sum, payment) => sum + (payment.value ?? 0), 0),
    paymentMethods,
    invoicesWithoutDueDate,
  };
}
