import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { renegotiateInvoices } from "@/lib/integrations/ixc/write-client";
import { DbIxcWriteOperationsRepository, requestRenegotiation } from "@/lib/platform/ixc-write-service";
import { isOpenInvoice } from "@/lib/platform/billing-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Renegociação de dívida no IXC (issue #20, terceira operação do catálogo).
 *
 * ⚠️ Esta é a operação que mexe em dinheiro. Ela **nunca é disparada pela IA**:
 * o pipeline do agente recusa desconto e renegociação de valor por decisão
 * própria e transborda para humano. Aqui só entra quem tem `ixc.write` e clicou.
 *
 * O GET monta a tela: faturas elegíveis do cliente (do IXC, agora), carteiras e
 * condições de pagamento. É ele que produz o total que o POST vai exigir de
 * volta — sem ver a tela, não dá para renegociar às cegas.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const customerId = new URL(request.url).searchParams.get("customerId")?.trim() ?? "";
  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) {
    return NextResponse.json({ available: false, detail: "IXC desligado — sem faturas nem catálogo", invoices: [], wallets: [], paymentTerms: [] });
  }

  const correlationId = randomUUID();
  try {
    const [wallets, paymentTerms] = await Promise.all([
      runtime.provider.listCollectionWallets(correlationId),
      runtime.provider.listPaymentTerms(correlationId),
    ]);
    if (!customerId) {
      return NextResponse.json({ available: true, invoices: [], wallets, paymentTerms, writeEnabled: process.env.FEATURE_IXC_WRITE === "true" });
    }
    const snapshot = await runtime.provider.getSnapshot(customerId, correlationId);
    const invoices = snapshot.invoices
      .filter((invoice) => isOpenInvoice(invoice.status) && (invoice.value ?? 0) > 0)
      .map((invoice) => ({ id: invoice.id, dueAt: invoice.dueAt ?? null, value: invoice.value ?? 0 }));
    return NextResponse.json({
      available: true, invoices, wallets, paymentTerms,
      customer: { id: snapshot.customer.id, name: snapshot.customer.name, hasAccount: !!snapshot.customer.accountId, hasBranch: !!snapshot.customer.branchId },
      contractId: snapshot.contracts[0]?.id ?? null,
      writeEnabled: process.env.FEATURE_IXC_WRITE === "true",
    });
  } catch {
    return NextResponse.json({ available: false, detail: "O IXC não respondeu", invoices: [], wallets: [], paymentTerms: [] });
  }
}

export async function POST(request: Request) {
  const guard = await authorize(request, "ixc.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const text = (key: string) => typeof body?.[key] === "string" ? (body[key] as string).trim() : "";
  const customerId = text("customerId");
  const walletId = text("walletId");
  const paymentTermId = text("paymentTermId");
  const idempotencyKey = text("idempotencyKey");
  const invoiceIds = Array.isArray(body?.invoiceIds) ? body.invoiceIds.map((id) => String(id).trim()).filter(Boolean) : [];
  const expectedTotal = Number(body?.expectedTotal);
  if (!customerId || !walletId || !paymentTermId || !idempotencyKey || invoiceIds.length === 0 || !Number.isFinite(expectedTotal)) {
    return NextResponse.json({ error: "Campos obrigatórios: customerId, invoiceIds, walletId, paymentTermId, expectedTotal, idempotencyKey" }, { status: 400 });
  }

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return NextResponse.json({ error: "IXC indisponível — sem fonte para confirmar as faturas" }, { status: 503 });

  const correlationId = randomUUID();
  const [snapshot, wallets, paymentTerms] = await Promise.all([
    runtime.provider.getSnapshot(customerId, correlationId).catch(() => null),
    runtime.provider.listCollectionWallets(correlationId).catch(() => null),
    runtime.provider.listPaymentTerms(correlationId).catch(() => null),
  ]);
  if (!snapshot) return NextResponse.json({ error: "Cadastro não encontrado no IXC" }, { status: 404 });
  if (!wallets || !paymentTerms) return NextResponse.json({ error: "O IXC não devolveu o catálogo financeiro — não dá para validar carteira e condição" }, { status: 503 });

  // Elegíveis e valores saem do IXC agora. Aceitar valor do corpo permitiria
  // renegociar R$ 5.000 dizendo que são R$ 50.
  const eligible = snapshot.invoices.filter((invoice) => isOpenInvoice(invoice.status) && (invoice.value ?? 0) > 0);
  const originalTotal = eligible
    .filter((invoice) => invoiceIds.includes(invoice.id))
    .reduce((sum, invoice) => sum + (invoice.value ?? 0), 0);

  const result = await requestRenegotiation(
    {
      customerId, invoiceIds, idempotencyKey, correlationId,
      requestedBy: guard.user?.email ?? "não identificado",
      policy: {
        invoiceIds, eligibleIds: new Set(eligible.map((invoice) => invoice.id)),
        originalTotal, expectedTotal, walletId, paymentTermId,
        knownWalletIds: new Set(wallets.map((item) => item.id)),
        knownPaymentTermIds: new Set(paymentTerms.map((item) => item.id)),
        branchId: snapshot.customer.branchId,
        accountId: snapshot.customer.accountId,
        contractId: snapshot.contracts[0]?.id,
      },
    },
    new DbIxcWriteOperationsRepository(await getDb()),
    (corr, onProgress) => renegotiateInvoices(
      { baseUrl: runtime.config.ixcBaseUrl!, token: runtime.config.ixcToken! },
      {
        invoiceIds, customerId,
        branchId: snapshot.customer.branchId ?? "", accountId: snapshot.customer.accountId ?? "",
        contractId: snapshot.contracts[0]?.id ?? "", walletId, paymentTermId,
        originalTotal, issuedOn: new Date().toLocaleDateString("pt-BR"),
      },
      corr, onProgress,
    ),
  );

  await logUnauthenticatedAction({
    action: "ixc.write.renegotiation", entity: `customer:${customerId}`, result: result.status,
    reason: `Renegociação de ${invoiceIds.length} fatura(s), total ${originalTotal.toFixed(2)}: ${result.detail}`,
    correlationId, actor: guard.user,
  });

  return NextResponse.json(result, { status: result.status === "success" ? 201 : 200 });
}
