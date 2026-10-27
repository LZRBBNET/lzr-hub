/** Contrato de leitura da recuperação. Nulo significa sem evidência, nunca zero. */
export type RecoverySourceState = "available" | "partial" | "unavailable" | "not-consulted";
export interface RecoveryPromise {
  id: string;
  invoiceId: string;
  promisedFor: string | null;
  status: "pending" | "fulfilled" | "broken" | "unknown";
  createdAt: string | null;
}
export interface RecoveryPromiseHistory {
  available: boolean;
  rows: RecoveryPromise[];
  truncated: boolean;
}
export interface RecoveryCustomerRow {
  customerId: string;
  customerName: null;
  overdueInvoices: number;
  knownOverdueValue: number | null;
  amountIncomplete: boolean;
  faceValueFallbackInvoices: number;
  oldestDueAt: string;
  daysOverdue: number;
  blockedSince: null;
  daysBlocked: null;
  aiContactStatus: null;
  predictiveRisk: null;
  promises: RecoveryPromiseHistory;
  humanReview: { reason: string };
}
export interface RecoveryPayload {
  available: boolean;
  detail?: string;
  fetchedAt: string | null;
  referenceDate: string;
  scope: "full-base" | "unavailable";
  page: number;
  pageSize: number;
  totalCustomers: number | null;
  rows: RecoveryCustomerRow[];
  coverage: {
    scannedInvoices: number | null;
    totalOverdueInvoices: number | null;
    truncated: boolean;
    excludedInvoices: number;
    maxInvoices: number;
  };
  sources: { ixc: RecoverySourceState; promises: RecoverySourceState };
  summary: null | {
    customers: number;
    overdueInvoices: number;
    knownOverdueValue: number | null;
    amountIncomplete: boolean;
    faceValueFallbackInvoices: number;
  };
}
export interface RecoveryCustomerDetail {
  available: boolean;
  customerId: string;
  customerName: string | null;
  observedAt: string | null;
  detail?: string;
  contracts: Array<{ id: string; contractStatus: string; internetStatus: string; trustUnlockActive: boolean | null; label: string; blocked: boolean }>;
  /** Só a constatação positiva é conclusiva; a consulta tem teto de 5 contratos. */
  blockStatus: "blocked-observed" | "inconclusive";
  contractsLimit: 5;
  blockedSince: null;
  daysBlocked: null;
  sources: { customer: RecoverySourceState; contracts: RecoverySourceState };
}
