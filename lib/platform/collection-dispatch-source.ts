import { daysOverdue } from "./billing-service.ts";
import { billingAmount } from "./billing-amount.ts";
import { evaluatePromiseHold } from "../../services/queue-runtime/src/promise-hold.mjs";
import { randomUUID } from "node:crypto";
import type { IxcReadonlyProvider } from "../integrations/ixc/readonly-provider.ts";
import type { DispatchInvoiceInput } from "./collection-dispatch-service.ts";

/** Uma consulta fresca por cliente. Falha ou recorte parcial nunca significa zero dívidas. */
export async function loadFreshDispatchInvoices(
  provider: Pick<IxcReadonlyProvider, "getOpenInvoicesForDispatch">,
  customerIds: string[],
): Promise<DispatchInvoiceInput[]> {
  if (!customerIds.length) throw new Error("COLLECTION_SCOPE_UNAVAILABLE");
  const batches = await Promise.all(
    customerIds.map((id) => provider.getOpenInvoicesForDispatch(id, randomUUID())),
  );
  return batches.flatMap((invoices, index) => {
    if (invoices.some((invoice) => invoice.customerId !== customerIds[index])) throw new Error("COLLECTION_INVOICE_SCOPE_MISMATCH");
    return invoices.map((invoice) => {
      if (typeof invoice.dueAt !== "string" || daysOverdue(invoice.dueAt, new Date()) === undefined) {
        throw new Error("COLLECTION_INVOICE_DUE_DATE_UNCONFIRMED");
      }
      const value = billingAmount(invoice.value, invoice.valueSource);
      if (invoice.status !== "A" || invoice.valueSource !== "open-balance" || value === null || value <= 0) {
        throw new Error("COLLECTION_INVOICE_BALANCE_UNCONFIRMED");
      }
      return { id: invoice.id, customerId: invoice.customerId, status: invoice.status, dueAt: invoice.dueAt, value };
    });
  });
}


/** Complete repository read per customer, shared by preview and ledger creation. */
export async function excludePromiseHeldInvoices(
  invoices: DispatchInvoiceInput[],
  repository: { listByCustomer(customerId: string): Promise<{ id: string; customerId: string; invoiceId: string; status: string; promisedFor: string }[]> },
  now: Date,
): Promise<{ invoices: DispatchInvoiceInput[]; paused: number }> {
  const byCustomer = new Map<string, Awaited<ReturnType<typeof repository.listByCustomer>>>();
  for (const customerId of new Set(invoices.map((invoice) => invoice.customerId))) {
    const rows = await repository.listByCustomer(customerId);
    if (!Array.isArray(rows) || rows.some((row) => !row || row.customerId !== customerId)) throw new Error("COLLECTION_PROMISE_SCOPE_UNCONFIRMED");
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row.invoiceId !== "string" || !row.invoiceId || seen.has(row.id)
        || evaluatePromiseHold({ complete: true, customerId, invoiceId: row.invoiceId, items: [row] }, customerId, row.invoiceId, now).state === "unverified") {
        throw new Error("COLLECTION_PROMISE_UNCONFIRMED");
      }
      seen.add(row.id);
    }
    byCustomer.set(customerId, rows);
  }
  const eligible: DispatchInvoiceInput[] = [];
  let paused = 0;
  for (const invoice of invoices) {
    const hold = evaluatePromiseHold({ complete: true, customerId: invoice.customerId, invoiceId: invoice.id,
      items: byCustomer.get(invoice.customerId)!.filter((row) => row.invoiceId === invoice.id) }, invoice.customerId, invoice.id, now);
    if (hold.state === "unverified") throw new Error("COLLECTION_PROMISE_UNCONFIRMED");
    if (hold.state === "paused") paused++;
    else eligible.push(invoice);
  }
  return { invoices: eligible, paused };
}
