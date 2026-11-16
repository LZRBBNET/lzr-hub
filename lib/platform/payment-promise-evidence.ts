import type { IxcReadonlyProvider } from "../integrations/ixc/readonly-provider.ts";
import { billingAmount } from "./billing-amount.ts";
/** Fresh, complete, customer-scoped evidence for review only. Unknown is never paid. */
export async function loadConfirmedReviewStatuses(customerId: string, correlationId: string, loadProvider: () => IxcReadonlyProvider | undefined): Promise<Map<string, string>> {
  try {
    const provider = loadProvider();
    if (!provider) return new Map();
    const requestedAt = Date.now();
    const snapshot = await provider.getSnapshot(customerId, correlationId, true);
    const observedAt = typeof snapshot.fetchedAt === "string" ? Date.parse(snapshot.fetchedAt) : NaN;
    const coverage = snapshot.coverage?.invoices;
    if (!Number.isFinite(observedAt) || observedAt < requestedAt || observedAt > Date.now()
      || snapshot.cache !== "miss" || snapshot.customer?.id !== customerId
      || !Array.isArray(snapshot.invoices) || !Array.isArray(snapshot.partialSources)
      || snapshot.partialSources.includes("invoices") || coverage?.complete !== true
      || !Number.isSafeInteger(coverage.total) || coverage.total !== snapshot.invoices.length
      || coverage.read !== snapshot.invoices.length) return new Map();
    const statuses = new Map<string, string>();
    const seen = new Set<string>();
    for (const invoice of snapshot.invoices) {
      if (!invoice || typeof invoice.id !== "string" || !invoice.id || invoice.customerId !== customerId || seen.has(invoice.id)) return new Map();
      seen.add(invoice.id);
      const balance = invoice.valueSource === "open-balance" ? billingAmount(invoice.value, invoice.valueSource) : null;
      if (invoice.status === "R" && balance === 0) statuses.set(invoice.id, "R");
      if (invoice.status === "A" && balance !== null && balance > 0) statuses.set(invoice.id, "A");
    }
    return statuses;
  } catch { return new Map(); }
}

