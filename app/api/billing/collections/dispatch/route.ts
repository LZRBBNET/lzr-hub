import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import {
  DbCollectionDispatchRepository, resolveTodayCandidates, runTodayDispatch,
  type DispatchInvoiceInput, type DispatchLedgerRow,
} from "@/lib/platform/collection-dispatch-service";
import { DbCollectionRulesRepository } from "@/lib/platform/collection-rules-service";
import { businessToday } from "@/lib/platform/billing-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";
import { getDb } from "@/db";

const PERIODS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Disparo real da régua (issue #15) — só cobre o escopo em que "antes do
 * vencimento" é calculável de verdade: a allowlist, onde o snapshot por
 * cliente traz a fatura inteira (vencida e futura). Com a base cheia
 * (`FEATURE_IXC_FULL_BASE`) o IXC só expõe uma varredura de faturas **já
 * vencidas** — não existe consulta de "vence em breve" na base inteira sem
 * varrer 73 mil registros. Declarar essa fronteira é melhor que fingir que a
 * régua cobre a carteira inteira.
 */
async function loadOpenInvoices(): Promise<{ scope: "allowlist" | "unavailable"; invoices: DispatchInvoiceInput[]; detail?: string }> {
  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return { scope: "unavailable", invoices: [], detail: "IXC desligado: sem fonte de fatura" };

  const settled = await Promise.allSettled(
    runtime.config.ixcAllowlist.map((id) => runtime.provider!.getSnapshot(id, crypto.randomUUID())),
  );
  const invoices: DispatchInvoiceInput[] = settled.flatMap((result) => result.status === "fulfilled"
    ? result.value.invoices.map((invoice) => ({ id: invoice.id, customerId: invoice.customerId, status: invoice.status, dueAt: invoice.dueAt, value: invoice.value }))
    : []);
  return { scope: "allowlist", invoices };
}

function summarizeLedger(rows: DispatchLedgerRow[]) {
  const byStep: Record<string, number> = {};
  for (const row of rows) byStep[row.stepId] = (byStep[row.stepId] ?? 0) + 1;
  return { total: rows.length, byStep };
}

function toCsv(rows: DispatchLedgerRow[]): string {
  const header = ["id", "invoiceId", "customerId", "ruleId", "stepId", "scheduledFor", "status", "channel", "correlationId", "createdAt"];
  const escape = (value: string) => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = rows.map((row) => header.map((key) => escape(String(row[key as keyof DispatchLedgerRow]))).join(","));
  return [header.join(","), ...lines].join("\n");
}

export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "30d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 7d, 30d ou 90d." }, { status: 400 });

  const rule = await new DbCollectionRulesRepository(await getDb()).getLatest().catch(() => undefined);
  const { scope, invoices, detail } = await loadOpenInvoices();
  if (!rule || scope === "unavailable") {
    return NextResponse.json({ available: false, detail: detail ?? "Régua indisponível", period, today: null, indicators: null });
  }

  const now = new Date();
  const today = resolveTodayCandidates(rule, invoices, now);
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const ledger = await new DbCollectionDispatchRepository(await getDb()).listSince(sinceIso);

  if (url.searchParams.get("format") === "csv") {
    return new NextResponse(toCsv(ledger), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=disparos-regua.csv" } });
  }

  return NextResponse.json({
    available: true, period, scope,
    today: { scheduledFor: businessToday(now), candidates: today.length },
    indicators: summarizeLedger(ledger),
  });
}

/**
 * Roda o disparo de hoje. Registra no ledger e tenta enfileirar — a fila
 * pode estar desligada, e isso não é falha do disparo (ver runTodayDispatch).
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "billing.write-demo");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as { action?: string } | null;
  if (body?.action !== "run") return NextResponse.json({ error: "Ação inválida" }, { status: 400 });

  const rule = await new DbCollectionRulesRepository(await getDb()).getLatest().catch(() => undefined);
  if (!rule) return NextResponse.json({ error: "Nenhuma régua salva ainda" }, { status: 409 });

  const { scope, invoices, detail } = await loadOpenInvoices();
  if (scope === "unavailable") return NextResponse.json({ error: detail ?? "IXC indisponível" }, { status: 503 });

  const correlationId = crypto.randomUUID();
  const result = await runTodayDispatch(rule, invoices, new DbCollectionDispatchRepository(await getDb()), new Date(), correlationId);

  await logUnauthenticatedAction({
    action: "billing.collections.dispatch", entity: `collection_rule:${rule.id}`, result: result.businessHour ? "success" : "skipped-hours",
    reason: `Disparo de ${result.scheduledFor}: ${result.candidates} candidato(s), ${result.recorded} registrado(s), ${result.duplicates} duplicata(s) evitada(s), ${result.enqueued} enfileirado(s)${result.queueEnabled ? "" : " (fila desligada)"}`,
    actor: guard.user,
  });

  return NextResponse.json(result);
}
