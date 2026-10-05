"use client";
import { useEffect, useRef, useState } from "react";
import { ISSUE_TEXT, type ContractIssue } from "@/lib/platform/contract-audit-shared";

type AuditStatus = "ok" | "pending" | "resolved" | "unverified";
type AuditFilter = AuditStatus | "all";
type AuditRecord = {
  contractId: string; customerId: string; customerName: string | null; plan: string | null; contractStatus: string | null;
  contractCreatedAt: string | null; status: AuditStatus; issues: ContractIssue[]; firstIssues: ContractIssue[]; detail: string | null;
  checks: number; firstCheckedAt: string; lastCheckedAt: string; resolvedAt: string | null;
};
type AuditRun = { trigger: "manual" | "tela" | "agendado"; actor: string | null; startedAt: string; finishedAt: string | null; newChecked: number; rechecked: number; resolved: number; stoppedReason: string | null };
type Payload = { available: boolean; detail?: string; error?: string; items: AuditRecord[]; counts?: Record<AuditStatus, number>; lastRun?: AuditRun | null; ixc?: "full-base" | "allowlist" | null };
type Outcome = { ran?: boolean; skipped?: string; newChecked?: number; rechecked?: number; resolved?: number; stoppedReason?: string | null; error?: string };

const FILTERS: Array<[AuditFilter, string]> = [["pending", "Pendentes"], ["resolved", "Corrigidos"], ["ok", "Sem pendência"], ["unverified", "Não verificados"], ["all", "Todos"]];
const STATUS: Record<AuditStatus, { label: string; tone: string }> = {
  pending: { label: "Pendente", tone: "amber" }, resolved: { label: "Corrigido", tone: "green" },
  ok: { label: "Sem pendência", tone: "green" }, unverified: { label: "Não verificado", tone: "" },
};
const TRIGGER: Record<AuditRun["trigger"], string> = { manual: "pelo botão", tela: "ao abrir a tela", agendado: "pelo agendamento" };
/** A tela pede uma passada a cada minuto; o servidor só executa se a última tiver mais de 10. */
const TICK_MS = 60_000;

const dateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
/** `data_cadastro_sistema` vem como "2026-10-05" ou "2026-10-05 14:32:10". */
const ixcDate = (value: string | null) => {
  if (!value) return "—";
  const [date] = value.split(/[ T]/);
  const [year, month, day] = date.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};
function describe(outcome: Outcome) {
  if (outcome.skipped) return outcome.skipped;
  const parts = [`${outcome.newChecked ?? 0} contrato(s) novo(s) conferido(s)`, `${outcome.rechecked ?? 0} pendência(s) reconferida(s)`];
  if (outcome.resolved) parts.push(`${outcome.resolved} corrigida(s) desde a última vez`);
  return `${parts.join(", ")}.${outcome.stoppedReason ? ` ${outcome.stoppedReason}` : ""}`;
}

function IssueChips({ issues, past = false }: { issues: ContractIssue[]; past?: boolean }) {
  return <div className="issue-chips">{issues.map((issue) =>
    <i key={issue.code} className={`issue-chip ${past ? "past" : ""}`} title={ISSUE_TEXT[issue.code].hint}>
      {ISSUE_TEXT[issue.code].label}{issue.found ? `: "${issue.found}"` : ""}
    </i>)}</div>;
}

/**
 * Auditoria de contratos: cada contrato novo do IXC, com o que falta no cadastro
 * do cliente. A verificação roda sozinha — ao abrir a tela e, enquanto ela está
 * aberta, a cada 10 minutos — e também pelo agendamento, quando configurado.
 */
export function ContractAuditModule() {
  const [filter, setFilter] = useState<AuditFilter>("pending");
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const filterRef = useRef<AuditFilter>("pending");

  async function load(target: AuditFilter = filterRef.current) {
    try {
      const response = await fetch(`/api/audit/contracts?status=${target}`);
      const payload = await response.json().catch(() => ({ available: false, items: [] })) as Payload;
      if (target !== filterRef.current) return;
      if (!response.ok) { setMessage(payload.error ?? "Não foi possível carregar a auditoria."); setState("error"); return; }
      setData(payload); setState("ready");
    } catch { setState("error"); }
  }

  async function run(trigger: "manual" | "tela") {
    if (trigger === "manual") { setRunning(true); setMessage(null); }
    try {
      const response = await fetch("/api/audit/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run", trigger }) });
      const outcome = await response.json().catch(() => ({})) as Outcome;
      // A passada automática só fala quando conferiu algo: "verificada há pouco" a cada minuto seria ruído.
      if (trigger === "manual") setMessage(response.ok ? describe(outcome) : outcome.error ?? "Não foi possível verificar agora.");
      else if (response.ok && outcome.ran && ((outcome.newChecked ?? 0) > 0 || outcome.resolved)) setMessage(describe(outcome));
      await load();
    } catch { if (trigger === "manual") setMessage("Não foi possível verificar agora."); }
    finally { if (trigger === "manual") setRunning(false); }
  }

  async function recheck(contractId: string) {
    setBusyId(contractId); setMessage(null);
    try {
      const response = await fetch("/api/audit/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recheck", contractId }) });
      const payload = await response.json().catch(() => ({})) as { record?: AuditRecord; error?: string };
      setMessage(response.ok && payload.record
        ? `Contrato ${contractId}: ${payload.record.issues.length ? `${payload.record.issues.length} pendência(s) ainda no cadastro.` : "cadastro sem pendência agora."}`
        : payload.error ?? "Não foi possível reconferir.");
      await load();
    } catch { setMessage("Não foi possível reconferir."); }
    finally { setBusyId(null); }
  }

  function choose(next: AuditFilter) { filterRef.current = next; setFilter(next); void load(next); }

  useEffect(() => {
    void load("pending").then(() => run("tela"));
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void run("tela"); }, TICK_MS);
    return () => window.clearInterval(timer);
    // Monta uma vez: as funções leem o filtro pela ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = data?.counts;
  const lastRun = data?.lastRun;
  const items = data?.items ?? [];

  return <main className="content">
    <div className="page-heading"><div><h1>Auditoria de contratos</h1><p>Cada contrato novo do IXC, conferido no cadastro do cliente: celular ou WhatsApp, e-mail e o Número do endereço.</p></div>
      <button className="button" disabled={running || data?.ixc === null} onClick={() => void run("manual")}>{running ? "Verificando…" : "Verificar agora"}</button>
    </div>
    {state === "loading" && <div className="state-card">Carregando auditoria…</div>}
    {state === "error" && <div className="state-card error">{message ?? "Não foi possível carregar a auditoria."}</div>}
    {state === "ready" && data && !data.available && <div className="state-card error">{data.detail}</div>}
    {state === "ready" && data?.available && <>
      {data.ixc === null && <div className="state-card error" style={{ marginBottom: 14 }}>A integração com o IXC está desligada neste ambiente: nenhum contrato é conferido.</div>}
      {data.ixc === "allowlist" && <div className="state-card error" style={{ marginBottom: 14 }}>A auditoria precisa ler a base inteira do IXC (<code>FEATURE_IXC_FULL_BASE</code>). Com a lista de homologação ela não alcança os contratos novos.</div>}
      <div className="metrics">
        <article className="metric"><div className="metric-top"><span>Pendentes</span></div><strong>{counts?.pending ?? 0}</strong><small style={{ color: "var(--warn)" }}>cadastro incompleto agora</small></article>
        <article className="metric"><div className="metric-top"><span>Corrigidos</span></div><strong>{counts?.resolved ?? 0}</strong><small>nasceram incompletos, já corrigidos</small></article>
        <article className="metric"><div className="metric-top"><span>Sem pendência</span></div><strong>{counts?.ok ?? 0}</strong><small>certos desde o primeiro dia</small></article>
        <article className="metric"><div className="metric-top"><span>Última verificação</span></div><strong style={{ fontSize: 18 }}>{lastRun ? dateTime(lastRun.startedAt) : "nunca"}</strong><small style={{ color: lastRun?.stoppedReason ? "var(--warn)" : undefined }}>{lastRun ? `${TRIGGER[lastRun.trigger]} • ${lastRun.newChecked} novo(s), ${lastRun.rechecked} reconferido(s)` : "roda ao abrir esta tela"}</small></article>
      </div>
      {lastRun?.stoppedReason && <div className="state-card" style={{ marginTop: 14 }}>A última verificação parou antes do fim: {lastRun.stoppedReason}</div>}
      {message && <div className="state-card" style={{ marginTop: 14 }}>{message}</div>}

      <section className="data-card" style={{ marginTop: 14 }}>
        <div className="card-header">
          <div className="filter-chips">{FILTERS.map(([value, label]) =>
            <button key={value} className={filter === value ? "active" : ""} onClick={() => choose(value)}>{label}{value !== "all" && counts ? ` (${counts[value as AuditStatus] ?? 0})` : ""}</button>)}
          </div>
        </div>
        <div className="data-row header audit-row"><span>Contrato</span><span>Cliente</span><span>Cadastrado em</span><span>Pendências</span><span>Situação</span><span></span></div>
        {items.length === 0 && <p className="conversation-empty">{filter === "pending" ? "Nenhum contrato com pendência." : "Nenhum contrato nesta lista ainda."}</p>}
        {items.map((item) => <div className="data-row audit-row" key={item.contractId}>
          <span><strong>Contrato {item.contractId}</strong><small>{item.plan ?? "plano não informado"}</small></span>
          <span><strong>{item.customerName ?? "Nome não informado"}</strong><small>Cliente {item.customerId}</small></span>
          <span><strong>{ixcDate(item.contractCreatedAt)}</strong><small>conferido {item.checks}x</small></span>
          <span>
            {item.status === "pending" && <IssueChips issues={item.issues} />}
            {item.status === "resolved" && <><IssueChips issues={item.firstIssues} past /><small>corrigido em {dateTime(item.resolvedAt)}</small></>}
            {item.status === "ok" && <small>Celular, e-mail e número certos.</small>}
            {item.status === "unverified" && <small>{item.detail ?? "Não foi possível conferir."}</small>}
          </span>
          <span><i className={`badge ${STATUS[item.status].tone}`}>{STATUS[item.status].label}</i><small>{dateTime(item.lastCheckedAt)}</small></span>
          <span><button className="button secondary" disabled={busyId !== null} onClick={() => void recheck(item.contractId)}>{busyId === item.contractId ? "…" : "Verificar de novo"}</button></span>
        </div>)}
      </section>

      <section className="data-card" style={{ marginTop: 14 }}>
        <div className="card-header"><strong>O que é conferido</strong></div>
        <div className="audit-rules">
          <p><b>Celular ou WhatsApp</b> preenchido, com DDD — um dos dois basta.</p>
          <p><b>E-mail</b> preenchido e no formato nome@dominio.com.</p>
          <p><b>Número do endereço</b>: o número da casa, ou <b>SN</b> quando não houver. <b>0</b> (ou 00, 000) não vale, nem grafias como S/N.</p>
          <p>Contrato pendente é reconferido sozinho por 30 dias: quando o cadastro é corrigido no IXC, ele passa para Corrigidos, e o que estava errado fica registrado. Nenhum telefone ou e-mail é copiado para o LZR HUB — só se o campo serve ou não.</p>
        </div>
      </section>
    </>}
  </main>;
}
