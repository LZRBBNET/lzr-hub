import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import {
  DbContractAuditRepository,
  recheckContract,
  runContractAudit,
  stopReason,
  type AuditFilter,
  type RunTrigger,
} from "@/lib/platform/contract-audit-service";
import { authorize } from "@/lib/platform/session-guard";

const LIST_LIMIT = 200;
const FILTERS: AuditFilter[] = ["pending", "resolved", "ok", "unverified", "all"];
/**
 * A tela dispara uma passada sozinha quando a última tem mais que isto. Várias
 * abas abertas não viram várias passadas: quem decide é o servidor, olhando a
 * última passada gravada.
 */
const AUTO_RUN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Disparo agendado (um cron externo chamando esta rota) com `x-job-secret`.
 * Comparação de tempo constante; sem segredo configurado, o caminho não existe.
 */
function jobAuthorized(request: Request): boolean {
  const expected = process.env.CONTRACT_AUDIT_JOB_SECRET?.trim();
  const offered = request.headers.get("x-job-secret")?.trim();
  if (!expected || !offered) return false;
  const a = Buffer.from(expected); const b = Buffer.from(offered);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const guard = await authorize(request, "audit.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const requested = new URL(request.url).searchParams.get("status") as AuditFilter | null;
  const filter: AuditFilter = requested && FILTERS.includes(requested) ? requested : "pending";
  const provider = getIxcRuntime().provider;
  try {
    const repository = new DbContractAuditRepository(await getDb());
    const [items, counts, lastRun] = await Promise.all([repository.list(filter, LIST_LIMIT), repository.counts(), repository.latestRun()]);
    return NextResponse.json({ available: true, filter, items, counts, lastRun: lastRun ?? null, ixc: provider ? provider.health().scope : null });
  } catch {
    return NextResponse.json({ available: false, detail: "Auditoria indisponível: o banco não respondeu.", items: [] });
  }
}

export async function POST(request: Request) {
  const job = jobAuthorized(request);
  const guard = job ? undefined : await authorize(request, "audit.read");
  if (guard && !guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  const provider = getIxcRuntime().provider;
  if (!provider) return NextResponse.json({ error: "A integração com o IXC está desligada neste ambiente." }, { status: 503 });

  try {
    const repository = new DbContractAuditRepository(await getDb());

    if (body.action === "recheck") {
      const contractId = typeof body.contractId === "string" ? body.contractId.trim() : "";
      if (!/^\d+$/.test(contractId)) return NextResponse.json({ error: "Informe o contrato" }, { status: 400 });
      const record = await recheckContract({ repository, provider }, contractId).catch((error) => { throw new Error(stopReason(error)); });
      return record ? NextResponse.json({ ok: true, record }) : NextResponse.json({ error: "Contrato ainda não auditado" }, { status: 404 });
    }

    const trigger: RunTrigger = job ? "agendado" : body.trigger === "tela" ? "tela" : "manual";
    if (trigger === "tela") {
      const last = await repository.latestRun();
      if (last && Date.now() - Date.parse(last.startedAt) < AUTO_RUN_INTERVAL_MS) return NextResponse.json({ ran: false, skipped: "Verificada há pouco." });
    }
    const outcome = await runContractAudit({ repository, provider }, { trigger, actor: job ? "agendamento" : guard?.user?.email ?? null });
    return NextResponse.json(outcome);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message ? error.message : "Auditoria indisponível agora." }, { status: 503 });
  }
}
