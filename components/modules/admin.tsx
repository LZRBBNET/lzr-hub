"use client";

import { useCallback, useEffect, useState } from "react";
import { queueNames, type QueueAction, type QueueSnapshot } from "@/lib/platform/queue-service";
import { permissions, rolePermissions, roles, type Role } from "@/lib/platform/rbac";

type Service = { name: string; state: string; mode: string; detail: string };
type StatusPayload = { environment: string; auth: { enforced: boolean; detail: string }; services: Service[] };

export function AdminModule({ view }: { view: "integracoes" | "equipes" | "usuarios" | "auditoria" | "configuracoes" }) {
  if (view === "integracoes") return <Integrations />;
  if (view === "usuarios") return <Users />;
  if (view === "auditoria") return <Audit />;
  if (view === "equipes") return <Queues />;
  return <Settings />;
}

const stateBadge = (state: string) => state === "ok" ? "green" : state === "degraded" || state === "observação" ? "amber" : "";

function Integrations() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    fetch("/api/admin/status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: StatusPayload) => { if (active) { setStatus(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [refresh]);

  return <main className="content">
    <Heading title="Saúde das integrações" text="Estado real de cada integração, resolvido no servidor." />
    {state === "loading" && <div className="state-card">Consultando o ambiente…</div>}
    {state === "error" && <div className="state-card error">Não foi possível consultar o estado das integrações.</div>}
    {state === "ready" && status && <>
      {!status.auth.enforced && <div className="protected-banner"><strong>Atenção:</strong> {status.auth.detail}.</div>}
      <section className="metrics">
        <article className="metric"><span>Ambiente</span><strong>{status.environment}</strong><small>LZR_ENV</small></article>
        <article className="metric"><span>Login</span><strong>{status.auth.enforced ? "obrigatório" : "desligado"}</strong><small>{status.auth.enforced ? "RBAC ativo" : "rotas abertas"}</small></article>
        <article className="metric"><span>Integrações ativas</span><strong>{status.services.filter((service) => service.state === "ok" || service.state === "observação").length}/{status.services.length}</strong><small>estado medido agora</small></article>
        <article className="metric"><span>Escrita no ERP</span><strong>bloqueada</strong><small>ausência de código, não flag</small></article>
      </section>
      <section className="service-grid">{status.services.map((service) => <article className="service-card" key={service.name}>
        <div className="service-top"><div className="service-logo">{service.name.slice(0, 2).toUpperCase()}</div><span className={`badge ${stateBadge(service.state)}`}>● {service.state}</span></div>
        <h3>{service.name}</h3><p>{service.detail}</p>
        <div className="service-meta"><span>{service.mode}</span><button onClick={() => { setState("loading"); setRefresh((value) => value + 1); }}>Atualizar</button></div>
      </article>)}</section>
    </>}
  </main>;
}

function Queues() {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => fetch("/api/queues", { cache: "no-store" })
    .then((response) => response.json())
    .then((data) => { setSnapshot(data as QueueSnapshot); setError(null); })
    .catch(() => { setError("Não foi possível consultar o serviço de filas."); }), []);
  useEffect(() => { void load(); }, [load]);

  async function act(action: QueueAction) {
    const key = "id" in action ? `${action.queue}:${action.id}` : "enqueue";
    setBusy(key);
    setError(null);
    try {
      const response = await fetch("/api/queues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Falha na ação");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Falha na ação de fila");
    } finally {
      setBusy(null);
    }
  }

  const jobs = snapshot?.jobs ?? [];
  return <main className="content"><Heading title="Equipes, Filas e Jobs" text="Processamento assíncrono real com Redis, BullMQ, idempotência, retries e DLQ." />{snapshot && !snapshot.enabled && <div className="protected-banner"><strong>Filas desabilitadas:</strong> {snapshot.detail ?? "ative FEATURE_QUEUES e configure o serviço."}</div>}{error && <div className="protected-banner"><strong>Falha:</strong> {error}</div>}<div className="queue-pills">{queueNames.map((queue) => <span key={queue}>{queue}<b>{snapshot?.counts[queue] ?? 0}</b></span>)}</div><section className="data-card"><div className="card-header"><strong>Runtime: {snapshot?.runtime ?? "carregando"}</strong><button onClick={() => void load()} disabled={busy !== null}>Atualizar filas</button></div><div className="job-row header"><span>Job / fila</span><span>Status</span><span>Tentativas</span><span>Correlação</span><span>Ações</span></div>{jobs.length === 0 && <div className="job-row"><span><strong>Nenhum job disponível</strong><small>Os jobs reais aparecerão aqui quando as filas estiverem habilitadas.</small></span></div>}{jobs.map((job) => { const key = `${job.queue}:${job.id}`; return <div className="job-row" key={key}><span><strong>{job.name}</strong><small>{job.queue} • {job.idempotencyKey}</small></span><span><i className={`badge ${job.status === "completed" ? "green" : job.status === "failed" ? "" : "blue"}`}>{job.status}</i>{job.error && <small>{job.error}</small>}</span><span>{job.attempts}/{job.maxAttempts}<small>{job.durationMs} ms</small></span><code>{job.correlationId}</code><span>{job.status === "failed" && <button disabled={busy === key} onClick={() => void act({ action: "retry", queue: job.queue, id: job.id })}>Reprocessar</button>}{job.status === "waiting" && job.queue !== "dead-letter" && <button disabled={busy === key} onClick={() => void act({ action: "cancel", queue: job.queue, id: job.id })}>Cancelar</button>}</span></div>; })}</section></main>;
}

type UserRow = { id: string; name: string; email: string; role: string; active: boolean; lastLoginAt: string | null; createdAt: string };

function Users() {
  const [role, setRole] = useState<Role>("Administrador");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [available, setAvailable] = useState(true);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    fetch("/api/admin/users", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: { available: boolean; users: UserRow[] }) => { if (active) { setAvailable(payload.available); setUsers(payload.users ?? []); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);

  const when = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR") : "nunca";
  return <main className="content">
    <Heading title="Usuários e Permissões" text="Quem tem acesso ao LZR HUB e o que cada perfil pode fazer." />
    <section className="data-card">
      <div className="card-header"><strong>Contas</strong><span className="badge green">{state === "ready" && available ? users.length : "—"}</span></div>
      {state === "loading" && <p style={{ padding: 14 }}>Carregando contas…</p>}
      {state === "error" && <p style={{ padding: 14 }}>Não foi possível consultar as contas.</p>}
      {state === "ready" && !available && <p style={{ padding: 14 }}>Lista de usuários indisponível — sem banco não há de onde ler.</p>}
      {state === "ready" && available && users.length === 0 && <p style={{ padding: 14, lineHeight: 1.6, color: "#64748b" }}>Nenhuma conta cadastrada.</p>}
      {state === "ready" && available && users.map((user) => <div className="permission-row" key={user.id}>
        <span><strong>{user.name}</strong><small style={{ display: "block", color: "#64748b" }}>{user.email} • último acesso: {when(user.lastLoginAt)}</small></span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}><i className="badge blue">{user.role}</i><i className={`badge ${user.active ? "green" : ""}`}>{user.active ? "ativa" : "inativa"}</i></span>
      </div>)}
      {/* Criar, desativar e trocar senha não existem na tela — dizer isso evita
          que alguém procure um botão que nunca foi construído. */}
      <div className="state-card" style={{ margin: 14 }}>Esta tela é somente leitura. Criar conta, desativar e trocar senha são feitos por <code>scripts/create-user.mjs</code> — não há tela para isso ainda.</div>
    </section>
    <div className="support-grid" style={{ marginTop: 14 }}>
      <section className="data-card"><div className="card-header"><strong>Perfis</strong></div>{roles.map((item) => <button className={`role-row ${item === role ? "active" : ""}`} onClick={() => setRole(item)} key={item}><span>{item}</span><b>{rolePermissions[item].length} permissões</b></button>)}</section>
      <section className="data-card"><div className="card-header"><strong>Permissões de {role}</strong><span className="badge blue">RBAC</span></div>{permissions.map((permission) => <div className="permission-row" key={permission}><span>{permission}</span><i className={`badge ${rolePermissions[role].includes(permission) ? "green" : ""}`}>{rolePermissions[role].includes(permission) ? "Permitido" : "Negado"}</i></div>)}</section>
    </div>
  </main>;
}

type AuditPayload = { available: boolean; events: Array<{ id: string; actorId: string; role: string; action: string; entity: string; reason: string; correlationId: string; result: string; origin: string; createdAt: string }>; detail?: string };

function Audit() {
  const [payload, setPayload] = useState<AuditPayload | null>(null);
  useEffect(() => {
    fetch("/api/audit", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setPayload(data as AuditPayload))
      .catch(() => setPayload({ available: false, events: [], detail: "Falha ao consultar a auditoria" }));
  }, []);

  const rows = payload?.events ?? [];
  return <main className="content"><Heading title="Auditoria" text="Ações humanas e da IA com antes/depois mascarado e correlação." />
    {/* Auditoria indisponível não pode cair para registros de exemplo: um rastro
        falso é exatamente o tipo de coisa que alguém usaria para dizer "está tudo
        registrado". Melhor a tela ficar vazia e explicar. */}
    {payload && !payload.available && <div className="protected-banner"><strong>Rastro indisponível:</strong> {payload.detail ?? "banco não configurado"}. Nada é exibido no lugar — um rastro de exemplo aqui daria a impressão de que as ações estão sendo registradas.</div>}
    <section className="data-card"><div className="audit-row header"><span>Ator / origem</span><span>Ação</span><span>Entidade</span><span>Resultado</span><span>Correlação / data</span></div>
      {payload === null && <div className="audit-row"><span>Carregando auditoria…</span></div>}
      {payload?.available && rows.length === 0 && <div className="audit-row"><span><strong>Nenhuma ação registrada ainda</strong><small>As ações reais aparecerão aqui conforme forem executadas.</small></span></div>}
      {payload?.available && rows.map((event) => <div className="audit-row" key={event.id}><span><strong>{event.actorId}</strong><small>{event.role} • {event.origin}</small></span><span>{event.action}<small>{event.reason}</small></span><span>{event.entity}</span><span><i className={`badge ${event.result === "success" ? "green" : event.result === "blocked" ? "amber" : ""}`}>{event.result}</i></span><span><code>{event.correlationId}</code><small>{new Date(event.createdAt).toLocaleString("pt-BR")}</small></span></div>)}
    </section></main>;
}

function Settings() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  useEffect(() => {
    fetch("/api/admin/status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then(setStatus).catch(() => setStatus(null));
  }, []);
  const ixc = status?.services.find((service) => service.name.startsWith("IXC"));

  // As políticas abaixo são decisões de código, não configuração ajustável —
  // por isso ficam escritas. O que é estado (ambiente, escopo do IXC) vem do
  // servidor: a versão anterior desta tela anunciava "Persistência: Cloudflare
  // D1", que o projeto abandonou, e uma allowlist "de no máximo 10 cadastros"
  // que deixou de valer quando a base inteira foi liberada.
  const rows: [string, string, string][] = [
    ["Ambiente", status?.environment ?? "—", "Definido por LZR_ENV"],
    ["Escopo do IXC", ixc?.mode ?? "—", "Somente leitura; escrita não existe no guard"],
    ["Login", status?.auth.enforced ? "obrigatório" : "desligado", status?.auth.detail ?? "—"],
    ["Persistência", "Postgres (Railway)", "Migrações aplicadas no deploy; D1 foi abandonado"],
    ["PII em log e telemetria", "Mascaramento obrigatório", "CPF, telefone, e-mail e endereço, via sanitizeTelemetry"],
    ["PII na tela", "Dado completo para quem tem sessão", "A proteção é login e RBAC, não texto truncado"],
    ["Resiliência do IXC", "Circuit breaker e rate limit", "Timeout curto, um retry, janela deslizante"],
    ["Busca de conhecimento", "Correspondência de texto", "Sem embeddings: FEATURE_PGVECTOR desligada"],
  ];
  return <main className="content"><Heading title="Configurações" text="Estado do ambiente e políticas que valem hoje." />
    <section className="settings-grid">{rows.map(([label, value, detail]) => <article className="service-card" key={label}><h3>{label}</h3><strong>{value}</strong><p>{detail}</p></article>)}</section>
  </main>;
}

function Heading({ title, text }: { title: string; text: string }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div><span className="badge green">Seguro por padrão</span></div>;
}
