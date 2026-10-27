import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import {
  DbPaymentPromiseRepository, PaymentPromiseValidationError, parsePromisedFor, parsePromiseReviewCursor, reconcilePaymentPromises,
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
    const headers = { "cache-control": "private, no-store" };
    if (!guard.user) return NextResponse.json({ error: "A conferência exige sessão autenticada." }, { status: 401, headers });
    try {
      const cursor = parsePromiseReviewCursor(body.cursor);
      let runtime;
      try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
      const result = await reconcilePaymentPromises(new DbPaymentPromiseRepository(await getDb()), runtime?.provider, correlationId, new Date(), cursor);

      await logUnauthenticatedAction({
        action: "billing.promise.review", entity: "payment_promises", result: result.unverified.length || result.hasMore ? "partial" : "success",
        reason: `Lote de ${result.examined} promessa(s), ${result.lookupCount} consulta(s) pontual(is): ${result.fulfilled.length} cumprida(s), ${result.broken.length} quebrada(s), ${result.stillPending.length} pendente(s), ${result.unverified.length} sem confirmação. ${result.hasMore ? "Há próximo lote não conferido." : "Fim do recorte atual."} Nenhum contato foi enviado.`,
        correlationId, actor: guard.user,
      });
      return NextResponse.json(result, { headers });
    } catch (error) {
      if (error instanceof PaymentPromiseValidationError) return NextResponse.json({ error: error.message }, { status: 400, headers });
      return NextResponse.json({ error: "Não foi possível confirmar o lote. Consulte as promessas antes de repetir; uma parte pode ter sido atualizada no HUB." }, { status: 503, headers });
    }
  }

  return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
}
