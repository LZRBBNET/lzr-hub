import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { businessToday } from "@/lib/platform/billing-service";
import {
  DbPaymentPromiseRepository, PaymentPromiseValidationError, parsePromisedFor, reviewPendingPromises,
} from "@/lib/platform/payment-promise-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Promessa de pagamento (issue #16). Registrada só no HUB — gerar negociação
 * dentro do IXC depende do catálogo de escrita (issue #20) cobrir essa
 * operação, o que ainda não aconteceu.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  // Promessa pendente não tem janela de tempo — ou está pendente, ou não
  // está. `period` fica só para manter a resposta no mesmo formato das
  // outras telas de Cobrança.
  const period = new URL(request.url).searchParams.get("period") ?? "30d";

  try {
    const pending = await new DbPaymentPromiseRepository(await getDb()).listPending();
    return NextResponse.json({ available: true, period, pending, pendingCount: pending.length });
  } catch {
    return NextResponse.json({ available: false, detail: "Promessas indisponíveis", pending: [], pendingCount: 0 });
  }
}

async function loadInvoiceStatusByCustomer(customerId: string, correlationId: string): Promise<Map<string, string>> {
  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return new Map();
  const snapshot = await runtime.provider.getSnapshot(customerId, correlationId).catch(() => null);
  return new Map((snapshot?.invoices ?? []).map((invoice) => [invoice.id, invoice.status]));
}

export async function POST(request: Request) {
  const guard = await authorize(request, "billing.write-demo");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });
  const correlationId = randomUUID();

  if (body.action === "create") {
    const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId.trim() : "";
    const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
    const promisedForRaw = typeof body.promisedFor === "string" ? body.promisedFor.trim() : "";
    if (!invoiceId || !customerId || !promisedForRaw) {
      return NextResponse.json({ error: "Campos obrigatórios: invoiceId, customerId, promisedFor" }, { status: 400 });
    }
    try {
      const promisedFor = parsePromisedFor(promisedForRaw, new Date());
      // Revalida contra o IXC: promessa para fatura que não existe ou já não
      // está aberta não é registrada — não há dívida para prometer pagar.
      const statusByInvoice = await loadInvoiceStatusByCustomer(customerId, correlationId);
      if (!statusByInvoice.has(invoiceId)) return NextResponse.json({ error: "Fatura não encontrada no cadastro informado" }, { status: 404 });

      const created = await new DbPaymentPromiseRepository(await getDb()).create({
        invoiceId, customerId, promisedFor, registeredBy: guard.user?.email ?? "não identificado", correlationId,
      });
      await logUnauthenticatedAction({
        action: "billing.promise.create", entity: `payment_promise:${created.id}`, result: "success",
        reason: `Promessa de pagamento registrada para ${promisedFor} (fatura ${invoiceId})`, correlationId, actor: guard.user,
      });
      return NextResponse.json(created, { status: 201 });
    } catch (error) {
      if (error instanceof PaymentPromiseValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ error: "Não foi possível registrar a promessa" }, { status: 503 });
    }
  }

  if (body.action === "review") {
    const repository = new DbPaymentPromiseRepository(await getDb());
    const pending = await repository.listPending();
    const byCustomer = new Map<string, string[]>();
    for (const promise of pending) byCustomer.set(promise.customerId, [...(byCustomer.get(promise.customerId) ?? []), promise.invoiceId]);

    const statusByInvoice = new Map<string, string>();
    for (const customerId of byCustomer.keys()) {
      const statuses = await loadInvoiceStatusByCustomer(customerId, correlationId);
      for (const [invoiceId, status] of statuses) statusByInvoice.set(invoiceId, status);
    }

    const today = businessToday(new Date());
    const result = reviewPendingPromises(pending, statusByInvoice, today);
    for (const id of result.fulfilled) await repository.updateStatus(id, "fulfilled");
    for (const id of result.broken) await repository.updateStatus(id, "broken");

    await logUnauthenticatedAction({
      action: "billing.promise.review", entity: "payment_promises", result: "success",
      reason: `Revisão: ${result.fulfilled.length} cumprida(s), ${result.broken.length} quebrada(s) — precisam de recontato, ${result.stillPending.length} ainda pendente(s). Nenhum recontato foi enviado: sem ponte de envio.`,
      correlationId, actor: guard.user,
    });
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
}
