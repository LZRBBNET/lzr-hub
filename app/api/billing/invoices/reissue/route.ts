import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { fetchBoletoSecondCopy } from "@/lib/integrations/ixc/write-client";
import {
  DbIxcWriteOperationsRepository, IXC_WRITE_CATALOG, requestInvoiceReissue,
} from "@/lib/platform/ixc-write-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

const PERIODS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Catálogo e ledger de escrita no IXC (issue #20). Leitura só exige
 * `customer.read`: ver o que está bloqueado e por quê não é ação de escrita.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "30d";
  const days = PERIODS[period] ?? 30;

  try {
    const ledger = await new DbIxcWriteOperationsRepository(await getDb()).listSince(new Date(Date.now() - days * 86_400_000).toISOString());
    return NextResponse.json({
      available: true, period, catalog: IXC_WRITE_CATALOG, ledger,
      writeEnabled: process.env.FEATURE_IXC_WRITE === "true",
    });
  } catch {
    return NextResponse.json({ available: false, detail: "Ledger de escrita no IXC indisponível", catalog: IXC_WRITE_CATALOG, ledger: [], writeEnabled: false });
  }
}

/**
 * Gera segunda via de boleto (único item do catálogo implementado). O status
 * da fatura usado na política vem do IXC agora, nunca do que o cliente
 * mandou no corpo — confiar no status enviado deixaria qualquer um alegar
 * "está aberta" para contornar a regra.
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "ixc.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as { invoiceId?: string; customerId?: string; idempotencyKey?: string } | null;
  const invoiceId = body?.invoiceId?.trim();
  const customerId = body?.customerId?.trim();
  const idempotencyKey = body?.idempotencyKey?.trim();
  if (!invoiceId || !customerId || !idempotencyKey) {
    return NextResponse.json({ error: "Campos obrigatórios: invoiceId, customerId, idempotencyKey" }, { status: 400 });
  }

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return NextResponse.json({ error: "IXC indisponível — sem fonte para confirmar a fatura" }, { status: 503 });

  const correlationId = randomUUID();
  const snapshot = await runtime.provider.getSnapshot(customerId, correlationId).catch(() => null);
  const invoice = snapshot?.invoices.find((item) => item.id === invoiceId);
  if (!invoice) return NextResponse.json({ error: "Fatura não encontrada no cadastro informado" }, { status: 404 });

  const result = await requestInvoiceReissue(
    { invoiceId, customerId, idempotencyKey, correlationId, requestedBy: guard.user?.email ?? "não identificado", invoice: { status: invoice.status } },
    new DbIxcWriteOperationsRepository(await getDb()),
    (id, _customerId, corr) => fetchBoletoSecondCopy({ baseUrl: runtime.config.ixcBaseUrl!, token: runtime.config.ixcToken! }, id, corr),
  );

  await logUnauthenticatedAction({
    action: "ixc.write.invoice_reissue", entity: `invoice:${invoiceId}`, result: result.status,
    reason: `Segunda via de boleto: ${result.detail}`, correlationId, actor: guard.user,
  });

  return NextResponse.json(result, { status: result.status === "success" ? 201 : 200 });
}
