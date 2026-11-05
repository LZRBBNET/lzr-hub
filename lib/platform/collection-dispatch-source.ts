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
    return invoices.map((invoice) => ({ id: invoice.id, customerId: invoice.customerId, status: invoice.status, dueAt: invoice.dueAt, value: invoice.value }));
  });
}
