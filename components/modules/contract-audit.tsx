"use client";
import { useEffect, useRef, useState } from "react";
import { ISSUE_TEXT, type ContractIssue } from "@/lib/platform/contract-audit-shared";
import { Icon } from "@/components/ui/icons";
import { Badge, Card, Empty, InfoTip, Limits, Loading, Notice, Segmented, Stat, Stats, Toolbar, count, dateTime, useToast } from "@/components/ui/kit";

type AuditStatus = "ok" | "pending" | "resolved" | "unverified";
type AuditFilter = AuditStatus | "all";
type AuditRecord = {
  contractId: string; customerId: string; customerName: string | null; plan: string | null; contractStatus: string | null;
  contractCreatedAt: string | null; createdBy: string | null; creatorCheckedAt: string | null; status: AuditStatus; issues: ContractIssue[]; firstIssues: ContractIssue[]; detail: string | null;
  checks: number; firstCheckedAt: string; lastCheckedAt: string; resolvedAt: string | null;
};
type AuditRun = { trigger: "manual" | "tela" | "agendado"; actor: string | null; startedAt: string; finishedAt: string | null; newChecked: number; rechecked: number; resolved: number; stoppedReason: string | null };
type CreatorCount = { createdBy: string | null; total: number };
type Payload = { available: boolean; detail?: string; error?: string; items: AuditRecord[]; counts?: Record<AuditStatus, number>; lastRun?: AuditRun | null; byCreator?: CreatorCount[]; ixc?: "full-base" | "allowlist" | null };
type Outcome = { ran?: boolean; skipped?: string; newChecked?: number; rechecked?: number; resolved?: number; creatorsFilled?: number; stoppedReason?: string | null; error?: string };

const STATUS: Record<AuditStatus, { label: string; tone: string }> = {
  pending: { label: "Pendente", tone: "warn" }, resolved: { label: "Corrigido", tone: "ok" },
  ok: { label: "Sem pendência", tone: "ok" }, unverified: { label: "Não verificado", tone: "" },
};
const TRIGGER: Record<AuditRun["trigger"], string> = { manual: "pelo botão", tela: "ao abrir a tela", agendado: "pelo agendamento" };
/** A tela pede uma passada a cada minuto; o servidor só executa se a última tiver mais de 10. */
const TICK_MS = 60_000;

/** `data_cadastro_sistema` vem como "2026-10-05" ou "2026-10-05 14:32:10". */
const ixcDate = (value: string | null) => {
  if (!value) return "—";
  const [date] = value.split(/[ T]/);
  const [year, month, day] = date.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};
function describe(outcome: Outcome) {
  if (outcome.skipped) return outcome.skipped;
  const parts = [`${outcome.newChecked ?? 0} contrato(s) novo(s) conferido(s)`, `${outcome.rechecked ?? 0} reconferido(s)`];
  if (outcome.resolved) parts.push(`${outcome.resolved} corrigido(s) desde a última vez`);
  if (outcome.creatorsFilled) parts.push(`quem criou encontrado em ${outcome.creatorsFilled}`);
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
 * aberta, a cada 10 minutos — e também pelo agendamento.
 */
export function ContractAuditModule() {
  const [filter, setFilter] = useState<AuditFilter>("pending");
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Filtro por quem criou: `undefined` = todos; `null` = os que o log não identifica.
  const [creator, setCreator] = useState<string | null | undefined>(undefined);
  const filterRef = useRef<AuditFilter>("pending");
  const toast = useToast();

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
      else if (response.ok && outcome.ran && ((outcome.newChecked ?? 0) > 0 || outcome.resolved)) toast(describe(outcome), "ok");
      await load();
    } catch { if (trigger === "manual") setMessage("Não foi possível verificar agora."); }
    finally { if (trigger === "manual") setRunning(false); }
  }

  async function recheck(contractId: string) {
    setBusyId(contractId);
    try {
      const response = await fetch("/api/audit/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recheck", contractId }) });
      const payload = await response.json().catch(() => ({})) as { record?: AuditRecord; error?: string };
      if (response.ok && payload.record) toast(`Contrato ${contractId}: ${payload.record.issues.length ? `${payload.record.issues.length} pendência(s) ainda no cadastro.` : "cadastro sem pendência agora."}`, payload.record.issues.length ? "warn" : "ok");
      else toast(payload.error ?? "Não foi possível reconferir.", "bad");
      await load();
    } catch { toast("Não foi possível reconferir.", "bad"); }
    finally { setBusyId(null); }
  }

  function choose(next: AuditFilter) { filterRef.current = next; setFilter(next); setCreator(undefined); void load(next); }

  useEffect(() => {
    void load("pending").then(() => run("tela"));
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void run("tela"); }, TICK_MS);
    return () => window.clearInterval(timer);
    // Monta uma vez: as funções leem o filtro pela ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "loading") return <Loading stats={4} rows={5} />;
  if (state === "error") return <Notice tone="bad">{message ?? "Não foi possível carregar a auditoria."}</Notice>;
  if (!data?.available) return <Notice tone="bad">{data?.detail}</Notice>;

  const counts = data.counts;
  const lastRun = data.lastRun;
  const items = data.items.filter((item) => creator === undefined || item.createdBy === creator);
  const byCreator = data.byCreator ?? [];
  const filters: ReadonlyArray<readonly [AuditFilter, string]> = [
    ["pending", `Pendentes${counts ? ` · ${counts.pending}` : ""}`], ["resolved", "Corrigidos"], ["ok", "Sem pendência"], ["unverified", "Não verificados"], ["all", "Todos"],
  ];

  return <>
    <Toolbar actions={<button className="button" disabled={running || data.ixc === null} onClick={() => void run("manual")}><Icon name="refresh" size={16} />{running ? "Verificando…" : "Verificar agora"}</button>}>
      <span className="muted small">Última verificação: <strong className="text-ink">{lastRun ? dateTime(lastRun.startedAt) : "nunca"}</strong>{lastRun ? ` · ${TRIGGER[lastRun.trigger]}` : ""}</span>
      <InfoTip label="O que é conferido">
        <strong>Celular ou WhatsApp</strong> com DDD (um dos dois basta), <strong>e-mail</strong> no formato nome@dominio.com e o <strong>Número</strong> do endereço: o da casa ou <strong>SN</strong> — 0, 00 e S/N não valem. Pendente é reconferido sozinho por 30 dias.
      </InfoTip>
    </Toolbar>
    {data.ixc === null && <Notice tone="bad">A integração com o IXC está desligada neste ambiente: nenhum contrato é conferido.</Notice>}
    {data.ixc === "allowlist" && <Notice tone="bad">A auditoria precisa ler a base inteira do IXC (<code>FEATURE_IXC_FULL_BASE</code>). Com a lista de homologação ela não alcança os contratos novos.</Notice>}
    {lastRun?.stoppedReason && <Notice tone="warn" title="A última verificação parou antes do fim:">{lastRun.stoppedReason}</Notice>}
    {message && <Notice tone="info" action={<button className="icon-button" aria-label="Dispensar" onClick={() => setMessage(null)}><Icon name="x" size={16} /></button>}>{message}</Notice>}
    <Stats>
      <Stat label="Pendentes" icon="alert" tone={counts?.pending ? "warn" : "ok"} value={count(counts?.pending ?? 0)} hint="Cadastro incompleto agora" />
      <Stat label="Corrigidos" icon="check" value={count(counts?.resolved ?? 0)} hint="Nasceram incompletos, já corrigidos" />
      <Stat label="Sem pendência" icon="clipboard" tone="ok" value={count(counts?.ok ?? 0)} hint="Certos desde o primeiro dia" />
      <Stat label="Nesta verificação" icon="refresh" value={lastRun ? count(lastRun.newChecked) : "—"} hint={lastRun ? `novo(s) · ${lastRun.rechecked} reconferido(s)` : "Roda ao abrir esta tela"} />
    </Stats>

    {byCreator.length > 0 && <Card title={<>Pendências por quem criou o contrato <InfoTip label="De onde vem o nome">O nome vem do registro de inserção no log do IXC — quem digitou, que nem sempre é o vendedor do contrato. Clique para filtrar a lista.</InfoTip></>}>
      <div className="chips">{byCreator.map((entry) => <button key={entry.createdBy ?? "(sem registro)"} type="button"
        className={`chip ${filter === "pending" && creator === entry.createdBy ? "active" : ""}`}
        onClick={() => { if (filterRef.current !== "pending") { filterRef.current = "pending"; setFilter("pending"); void load("pending"); } setCreator(creator === entry.createdBy ? undefined : entry.createdBy); }}>
        {entry.createdBy ?? "Não consta no log"} <b>{entry.total}</b>
      </button>)}</div>
    </Card>}

    <Card title="Contratos" actions={<Segmented label="Filtrar contratos" value={filter} options={filters} onChange={choose} />} flush>
      {creator !== undefined && <div className="card-content" style={{ paddingBottom: 0 }}><Notice tone="neutral" action={<button className="link-button" onClick={() => setCreator(undefined)}>Mostrar todos</button>}>Só os criados por <strong>{creator ?? "quem não consta no log"}</strong>.</Notice></div>}
      {items.length === 0
        ? <Empty icon="check" title={filter === "pending" ? "Nenhum contrato com pendência" : "Nenhum contrato nesta lista ainda"} />
        : <div className="table" style={{ ["--cols" as string]: "minmax(0,1.2fr) minmax(0,1.3fr) minmax(0,2fr) 130px 120px" }}>
            <div className="tr head hide-sm"><span>Contrato</span><span>Cliente</span><span>Pendências</span><span>Situação</span><span></span></div>
            {items.map((item) => <div className="tr stack-sm" key={item.contractId}>
              <span className="cell"><strong>Contrato {item.contractId}</strong><small>{ixcDate(item.contractCreatedAt)} · {item.plan ?? "plano não informado"}</small>
                <small className="creator-line">{item.createdBy ? `Criado por ${item.createdBy}` : item.creatorCheckedAt ? "Quem criou não consta no log" : "Procurando quem criou…"}</small></span>
              <span className="cell"><strong>{item.customerName ?? "Nome não informado"}</strong><small>Cliente {item.customerId}</small></span>
              <span>
                {item.status === "pending" && <IssueChips issues={item.issues} />}
                {item.status === "resolved" && <><IssueChips issues={item.firstIssues} past /><small className="muted">corrigido em {dateTime(item.resolvedAt)}</small></>}
                {item.status === "ok" && <small className="muted">Celular, e-mail e número certos.</small>}
                {item.status === "unverified" && <small className="muted">{item.detail ?? "Não foi possível conferir."}</small>}
              </span>
              <span className="cell"><Badge tone={(STATUS[item.status].tone || "neutral") as "ok" | "warn" | "neutral"}>{STATUS[item.status].label}</Badge><small>conferido {item.checks}x · {dateTime(item.lastCheckedAt)}</small></span>
              <span><button className="button secondary small" disabled={busyId !== null} onClick={() => void recheck(item.contractId)}>{busyId === item.contractId ? "Conferindo…" : "Verificar de novo"}</button></span>
            </div>)}
          </div>}
    </Card>
    <Limits title="Como a verificação funciona" items={[
      ["O que é conferido", "Celular ou WhatsApp com DDD (um basta), e-mail válido e o Número do endereço — o da casa ou SN. Zero (0, 00, 000) não vale; grafias como S/N ficam como fora do padrão."],
      ["Reconferência", "Pendente e não verificado são reconferidos sozinhos por 30 dias. Quando o cadastro é corrigido no IXC, o contrato vai para Corrigidos e o que estava errado fica registrado."],
      ["Dado pessoal", "Nenhum telefone ou e-mail é copiado para o LZR HUB — só se o campo serve ou não."],
      ["Quando roda", "Ao abrir esta tela, pelo botão e de hora em hora (07h às 20h) pelo agendamento. Cada passada é pequena e para antes se o IXC estiver muito consultado — o atendimento tem prioridade."],
    ]} />
  </>;
}
