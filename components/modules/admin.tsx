"use client";

import { useCallback, useEffect, useState } from "react";
import { auditEvents } from "@/lib/platform/demo-data";
import { queueNames, type QueueAction, type QueueSnapshot } from "@/lib/platform/queue-service";
import { permissions, rolePermissions, roles, type Role } from "@/lib/platform/rbac";

type HealthPayload = { status: "ok" | "degraded"; environment: string; runtimeMode: string; ixc: "disabled"; externalWrites: false };
type ChannelPayload = { enabled: boolean; configured: boolean };

export function AdminModule({ view }: { view: "integracoes" | "equipes" | "usuarios" | "auditoria" | "configuracoes" }) {
  if (view === "integracoes") return <Integrations />;
  if (view === "usuarios") return <Users />;
  if (view === "auditoria") return <Audit />;
  if (view === "equipes") return <Queues />;
  return <Settings />;
}

function Integrations() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [channel, setChannel] = useState<ChannelPayload | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { fetch("/api/health").then((response) => response.json()).then(setHealth).catch(() => setHealth(null)); }, [refresh]);
  useEffect(() => { fetch("/api/channels/n8n").then((response) => response.json()).then(setChannel).catch(() => setChannel(null)); }, [refresh]);
  const whatsappStatus = channel?.enabled ? (channel.configured ? "ok" : "degraded") : "disabled";
  const whatsappDetail = channel?.enabled
    ? (channel.configured ? "Canal ativo, conectado ao pipeline de IA" : "Ativado mas sem N8N_CHANNEL_SECRET configurado")
    : "Nenhuma mensagem externa";
  const services = [
    ["Pipeline LZR", health?.status ?? "degraded", "mock", "Respostas demonstrativas com evidência e transbordo"],
    ["IXC", "disabled", "disabled", "Nenhuma consulta ou escrita real"],
    ["WhatsApp", whatsappStatus, channel?.enabled ? "live" : "mock", whatsappDetail],
    ["Cobrança e filas", "disabled", "mock", "Jobs e pagamentos apenas demonstrativos"],
    ["Observabilidade externa", "disabled", "local", "Nenhum rastro enviado a terceiros"],
    ["Banco D1", "demo", "staging", "Dados exclusivamente sintéticos"],
  ];
  return <main className="content"><Heading title="Saúde das integrações" text="Resumo sanitizado do ambiente demonstrativo protegido." /><div className="protected-banner"><strong>Ambiente protegido:</strong> escrita no IXC, mensagens, cobrança, desbloqueio, mudança de plano e OS real permanecem bloqueados.</div><section className="metrics"><article className="metric"><span>Ambiente</span><strong>{health?.environment ?? "carregando"}</strong><small>acesso restrito</small></article><article className="metric"><span>Runtime</span><strong>{health?.runtimeMode ?? "—"}</strong><small>dados fictícios</small></article><article className="metric"><span>IXC</span><strong>{health?.ixc ?? "disabled"}</strong><small>zero consulta real</small></article><article className="metric"><span>Escrita externa</span><strong>bloqueada</strong><small>fail closed</small></article></section><section className="service-grid">{services.map(([service, status, mode, detail]) => <article className="service-card" key={service}><div className="service-top"><div className="service-logo">{service.slice(0, 2).toUpperCase()}</div><span className={`badge ${status === "ok" || status === "demo" ? "green" : status === "degraded" ? "amber" : ""}`}>● {status}</span></div><h3>{service}</h3><p>{detail}</p><div className="service-meta"><span>{mode}</span><button onClick={() => setRefresh((value) => value + 1)}>Atualizar health</button></div></article>)}</section></main>;
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

function Users() {
  const [role, setRole] = useState<Role>("Administrador");
  return <main className="content"><Heading title="Usuários e Permissões" text="RBAC por perfil, menor privilégio e alterações auditadas." /><div className="support-grid"><section className="data-card"><div className="card-header"><strong>Perfis</strong></div>{roles.map((item) => <button className={`role-row ${item === role ? "active" : ""}`} onClick={() => setRole(item)} key={item}><span>{item}</span><b>{rolePermissions[item].length} permissões</b></button>)}</section><section className="data-card"><div className="card-header"><strong>Permissões de {role}</strong><span className="badge blue">RBAC</span></div>{permissions.map((permission) => <div className="permission-row" key={permission}><span>{permission}</span><i className={`badge ${rolePermissions[role].includes(permission) ? "green" : ""}`}>{rolePermissions[role].includes(permission) ? "Permitido" : "Negado"}</i></div>)}</section></div></main>;
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
    {payload && !payload.available && <div className="protected-banner"><strong>Rastro indisponível:</strong> {payload.detail ?? "banco não configurado"}. Os registros abaixo são apenas exemplos de demonstração.</div>}
    <section className="data-card"><div className="audit-row header"><span>Ator / origem</span><span>Ação</span><span>Entidade</span><span>Resultado</span><span>Correlação / data</span></div>
      {payload === null && <div className="audit-row"><span>Carregando auditoria…</span></div>}
      {payload?.available && rows.length === 0 && <div className="audit-row"><span><strong>Nenhuma ação registrada ainda</strong><small>As ações reais aparecerão aqui conforme forem executadas.</small></span></div>}
      {payload?.available
        ? rows.map((event) => <div className="audit-row" key={event.id}><span><strong>{event.actorId}</strong><small>{event.role} • {event.origin}</small></span><span>{event.action}<small>{event.reason}</small></span><span>{event.entity}</span><span><i className={`badge ${event.result === "success" ? "green" : event.result === "blocked" ? "amber" : ""}`}>{event.result}</i></span><span><code>{event.correlationId}</code><small>{event.createdAt}</small></span></div>)
        : payload !== null && auditEvents.map((event) => <div className="audit-row" key={event.id}><span><strong>{event.actor}</strong><small>{event.role} • {event.origin}</small></span><span>{event.action}<small>{event.reason}</small></span><span>{event.entity}</span><span><i className={`badge ${event.result === "success" ? "green" : event.result === "blocked" ? "amber" : ""}`}>{event.result}</i></span><span><code>{event.correlationId}</code><small>{event.at}</small></span></div>)}
    </section></main>;
}

function Settings() {
  return <main className="content"><Heading title="Configurações" text="Ambientes, políticas e parâmetros protegidos." /><section className="settings-grid">{[["Ambiente operacional", "Homologação protegida", "Produção bloqueada na Fase 3A"], ["PII em logs", "Mascaramento obrigatório", "CPF, telefone, endereço e cobrança"], ["IXC", "Somente leitura + allowlist", "No máximo 10 cadastros"], ["Circuit breaker", "Habilitado no provider", "Timeout, retry curto e rate limit"], ["Persistência", "Cloudflare D1", "Migrations aditivas e backup testado"], ["Busca de conhecimento", "Híbrida com evidência", "Sem alegação de pgvector"]].map((row) => <article className="service-card" key={row[0]}><h3>{row[0]}</h3><strong>{row[1]}</strong><p>{row[2]}</p></article>)}</section></main>;
}

function Heading({ title, text }: { title: string; text: string }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div><span className="badge green">Seguro por padrão</span></div>;
}
