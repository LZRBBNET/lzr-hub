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

export async function POST(request: Request) {
  const guard = await authorize(request, "billing.write-demo");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });
  const correlationId = randomUUID();

  if (body.action === "create") {
    const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : "";
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    const promisedForRaw = typeof body.promisedFor === "string" ? body.promisedFor.trim() : "";
    if (!invoiceId || !customerId || !promisedForRaw) {
      return NextResponse.json({ error: "Campos obrigatórios: invoiceId, customerId, promisedFor" }, { status: 400 });
    }
    if (!/^[1-9]\d{0,31}$/.test(invoiceId) || !/^[1-9]\d{0,31}$/.test(customerId)) {
      return NextResponse.json({ error: "Referência de fatura ou cliente inválida" }, { status: 400 });
    }
    try {
      const promisedFor = parsePromisedFor(promisedForRaw, new Date());
      // Uma consulta fresca e exata, sem cache nem limite de 20 do snapshot.
      // O adaptador exige cobertura completa e vínculo cliente/fatura; aqui
      // ambos são revalidados antes de acessar o banco ou auditar sucesso.
      const { provider } = getIxcRuntime();
      if (!provider) throw new Error("IXC_INVOICE_UNVERIFIED");
      const invoice = await provider.getInvoiceForCustomer(customerId, invoiceId, correlationId);
      if (!invoice) return NextResponse.json({ error: "Fatura não encontrada no cadastro informado" }, { status: 404 });
      if (invoice.id !== invoiceId || invoice.customerId !== customerId) throw new Error("IXC_INVOICE_SCOPE_MISMATCH");
      if (invoice.status === "R" || invoice.status === "C") {
        return NextResponse.json({ error: "A fatura não está aberta para registrar uma promessa" }, { status: 409 });
      }
      if (invoice.status !== "A") throw new Error("IXC_INVOICE_STATUS_UNVERIFIED");

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
