"use client";

import { useCallback, useEffect, useState } from "react";
import { queueNames, type QueueAction, type QueueSnapshot } from "@/lib/platform/queue-service";
import { permissions, rolePermissions, roles, type Role } from "@/lib/platform/rbac";
import { HANDOFF_REASONS, reasonHint, reasonLabel, type Team, type TeamLoad } from "@/lib/platform/teams-shared";

/**
 * "Equipes e Filas" mostrava só as filas técnicas do BullMQ — `message-inbound`,
 * `ixc-sync` — que são jobs de infraestrutura, não gente. Equipe de atendimento
 * nunca existiu. As duas coisas continuam na mesma tela, mas separadas e com o
 * nome certo cada uma.
 */
function TeamsAndQueues() {
  return <><Teams /><Queues /></>;
}

type Person = { id: string; name: string; email: string; role: string; active: boolean };
type TeamsPayload = {
  available: boolean; detail?: string; period: string;
  teams: Team[]; load: TeamLoad[]; unclaimed: Array<{ reason: string; count: number }>;
  totalHandoffs: number; people: Person[];
};
const TEAM_PERIODS: [string, string][] = [["7d", "7 dias"], ["30d", "30 dias"], ["90d", "90 dias"]];
const EMPTY_TEAM = { name: "", queue: "", description: "", handoffReasons: [] as string[] };

function Teams() {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState<TeamsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [nonce, setNonce] = useState(0);
  const [form, setForm] = useState(EMPTY_TEAM);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/teams?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: TeamsPayload) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [period, nonce]);

  async function send(body: Record<string, unknown>) {
    setBusy(true); setError("");
    const response = await fetch("/api/admin/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) { setForm(EMPTY_TEAM); setEditing(null); setNonce((value) => value + 1); }
    else { const payload = await response.json().catch(() => ({})); setError(payload.error ?? "Não foi possível concluir a ação"); }
    setBusy(false);
  }

  const toggleReason = (reason: string) => setForm((current) => ({
    ...current,
    handoffReasons: current.handoffReasons.includes(reason)
      ? current.handoffReasons.filter((value) => value !== reason)
      : [...current.handoffReasons, reason],
  }));

  const loadOf = (id: string) => data?.load.find((item) => item.teamId === id);
  const coberto = new Set((data?.teams ?? []).filter((team) => team.active).flatMap((team) => team.handoffReasons));

  return <main className="content">
    <Heading title="Equipes de atendimento" text="Quem assume cada motivo de transbordo, e quantos atendimentos caíram em cada equipe." />

    {/* Sem isto a tela seria lida como roteador. Ela não é. */}
    <div className="state-card">Registrar equipe <strong>não encaminha atendimento</strong>. Nada no sistema entrega uma conversa para uma fila — quem responde é o fluxo do n8n. O que existe aqui é o registro de quem assume o quê, e a contagem real de transbordos por motivo.</div>

    <section className="filter-bar">
      <select value={period} onChange={(event) => { setState("loading"); setPeriod(event.target.value); }}>
        {TEAM_PERIODS.map(([value, label]) => <option key={value} value={value}>Últimos {label}</option>)}
      </select>
    </section>

    {state === "loading" && <div className="state-card">Carregando equipes…</div>}
    {state === "error" && <div className="state-card error">Não foi possível consultar as equipes.</div>}
    {state === "ready" && data && !data.available && <div className="state-card error">{data.detail}.</div>}

    {state === "ready" && data?.available && <>
      <section className="metrics">
        <Metric label="Equipes ativas" value={String(data.teams.filter((team) => team.active).length)} detail={data.teams.length ? `${data.teams.length} cadastrada(s)` : "Nenhuma cadastrada"} />
        <Metric label="Transbordos no período" value={data.totalHandoffs.toLocaleString("pt-BR")} detail="Medidos nas conversas gravadas" />
        <Metric label="Motivos cobertos" value={`${coberto.size} de ${HANDOFF_REASONS.length}`} detail="Assumidos por alguma equipe ativa" />
        <Metric label="Sem equipe" value={String(data.unclaimed.reduce((sum, row) => sum + row.count, 0))} detail={data.unclaimed.length ? `${data.unclaimed.length} motivo(s) descoberto(s)` : "Tudo coberto"} />
      </section>

      {data.unclaimed.length > 0 && <section className="data-card" style={{ marginTop: 14 }}>
        <div className="card-header"><strong>Transbordos que ninguém assumiu</strong><span className="badge amber">{data.unclaimed.length} motivo(s)</span></div>
        <div className="ranked-list">{data.unclaimed.map((row) => <div className="ranked-row" key={row.reason}>
          <div className="ranked-label"><strong>{reasonLabel(row.reason)}</strong><span>{reasonHint(row.reason)}</span></div>
          <div className="ranked-bar"><span style={{ width: `${Math.round(row.count / Math.max(data.totalHandoffs, 1) * 100)}%` }} /></div>
          <b>{row.count}</b>
        </div>)}</div>
      </section>}

      <div className="dashboard-grid">
        <section className="data-card">
          <div className="card-header"><strong>Equipes</strong><span className="badge blue">{data.teams.length}</span></div>
          {data.teams.length === 0
            ? <p className="card-empty">Nenhuma equipe cadastrada. Crie a primeira ao lado.</p>
            : data.teams.map((team) => <div className="team-row" key={team.id}>
                <div className="team-head">
                  <div>
                    <strong>{team.name}{!team.active && <span className="badge amber" style={{ marginLeft: 8 }}>desativada</span>}</strong>
                    <span><code>{team.queue}</code>{team.description ? ` • ${team.description}` : ""}</span>
                  </div>
                  <div className="team-load"><b>{loadOf(team.id)?.handoffs ?? 0}</b><small>transbordo(s)</small></div>
                </div>
                <div className="team-tags">
                  {team.handoffReasons.length === 0
                    ? <em>Nenhum motivo assumido — a equipe não recebe contagem.</em>
                    : team.handoffReasons.map((reason) => <span key={reason} title={reasonHint(reason)}>{reasonLabel(reason)} <b>{loadOf(team.id)?.byReason[reason] ?? 0}</b></span>)}
                </div>
                <div className="team-people">
                  {team.members.length === 0 ? <em>Sem ninguém vinculado.</em> : team.members.map((member) => <span key={member.userId}>
                    {member.name}<small>{member.role}</small>
                    <button className="link-button" disabled={busy} onClick={() => void send({ action: "remove-member", teamId: team.id, userId: member.userId })} title={`Remover ${member.name} da equipe`}>remover</button>
                  </span>)}
                </div>
                <div className="team-actions">
                  <select value="" disabled={busy} onChange={(event) => { if (event.target.value) void send({ action: "add-member", teamId: team.id, userId: event.target.value }); }}>
                    <option value="">Vincular pessoa…</option>
                    {data.people.filter((person) => person.active && !team.members.some((member) => member.userId === person.id))
                      .map((person) => <option key={person.id} value={person.id}>{person.name} — {person.role}</option>)}
                  </select>
                  <button className="button secondary" disabled={busy} onClick={() => { setEditing(team.id); setForm({ name: team.name, queue: team.queue, description: team.description ?? "", handoffReasons: [...team.handoffReasons] }); setError(""); }}>Alterar</button>
                  <button className="button secondary" disabled={busy} onClick={() => void send({ action: "set-active", id: team.id, active: !team.active })}>{team.active ? "Desativar" : "Reativar"}</button>
                </div>
              </div>)}
        </section>

        <section className="data-card">
          <div className="card-header"><strong>{editing ? "Alterar equipe" : "Nova equipe"}</strong><span className="badge blue">Fica auditado</span></div>
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            <label className="field"><span>Nome</span><input value={form.name} placeholder="ex.: Suporte técnico N1" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
            <label className="field"><span>Fila</span><input value={form.queue} placeholder="ex.: suporte-tecnico" onChange={(event) => setForm((current) => ({ ...current, queue: event.target.value }))} /></label>
            <label className="field"><span>Descrição (opcional)</span><input value={form.description} placeholder="ex.: primeiro nível, 8h às 18h" onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
            <fieldset className="reason-picker">
              <legend>Motivos de transbordo que esta equipe assume</legend>
              {HANDOFF_REASONS.map((reason) => <label key={reason} title={reasonHint(reason)}>
                <input type="checkbox" checked={form.handoffReasons.includes(reason)} onChange={() => toggleReason(reason)} />
                <span>{reasonLabel(reason)}</span>
              </label>)}
            </fieldset>
            {error && <p className="form-error">{error}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button" disabled={busy} onClick={() => void send(editing ? { action: "update", id: editing, ...form } : { action: "create", ...form })}>{busy ? "Salvando…" : editing ? "Salvar alteração" : "Criar equipe"}</button>
              {editing && <button className="button secondary" disabled={busy} onClick={() => { setEditing(null); setForm(EMPTY_TEAM); setError(""); }}>Cancelar</button>}
            </div>
          </div>
          <div className="insight">
            <strong>Um motivo pode ser assumido por mais de uma equipe.</strong>
            Nesse caso ele conta para as duas. Como nada roteia de fato, assumir é declaração de responsabilidade, não posse do atendimento.
          </div>
        </section>
      </div>
    </>}
  </main>;
}

type Service = { name: string; state: string; mode: string; detail: string };
type StatusPayload = { environment: string; auth: { enforced: boolean; detail: string }; services: Service[] };

export function AdminModule({ view }: { view: "integracoes" | "equipes" | "usuarios" | "auditoria" | "configuracoes" }) {
  if (view === "integracoes") return <Integrations />;
  if (view === "usuarios") return <Users />;
  if (view === "auditoria") return <Audit />;
  if (view === "equipes") return <TeamsAndQueues />;
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
  return <main className="content"><Heading title="Filas técnicas" text="Jobs de infraestrutura processados por Redis e BullMQ. Não são equipes nem atendimento." />{snapshot && !snapshot.enabled && <div className="protected-banner"><strong>Filas desabilitadas:</strong> {snapshot.detail ?? "ative FEATURE_QUEUES e configure o serviço."}</div>}{error && <div className="protected-banner"><strong>Falha:</strong> {error}</div>}<div className="queue-pills">{queueNames.map((queue) => <span key={queue}>{queue}<b>{snapshot?.counts[queue] ?? 0}</b></span>)}</div><section className="data-card"><div className="card-header"><strong>Runtime: {snapshot?.runtime ?? "carregando"}</strong><button onClick={() => void load()} disabled={busy !== null}>Atualizar filas</button></div><div className="job-row header"><span>Job / fila</span><span>Status</span><span>Tentativas</span><span>Correlação</span><span>Ações</span></div>{jobs.length === 0 && <div className="job-row"><span><strong>Nenhum job disponível</strong><small>Os jobs reais aparecerão aqui quando as filas estiverem habilitadas.</small></span></div>}{jobs.map((job) => { const key = `${job.queue}:${job.id}`; return <div className="job-row" key={key}><span><strong>{job.name}</strong><small>{job.queue} • {job.idempotencyKey}</small></span><span><i className={`badge ${job.status === "completed" ? "green" : job.status === "failed" ? "" : "blue"}`}>{job.status}</i>{job.error && <small>{job.error}</small>}</span><span>{job.attempts}/{job.maxAttempts}<small>{job.durationMs} ms</small></span><code>{job.correlationId}</code><span>{job.status === "failed" && <button disabled={busy === key} onClick={() => void act({ action: "retry", queue: job.queue, id: job.id })}>Reprocessar</button>}{job.status === "waiting" && job.queue !== "dead-letter" && <button disabled={busy === key} onClick={() => void act({ action: "cancel", queue: job.queue, id: job.id })}>Cancelar</button>}</span></div>; })}</section></main>;
}

type UserRow = { id: string; name: string; email: string; role: string; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string };
type ResetRequest = { id: string; email: string; note: string | null; createdAt: string };

function Users() {
  const [role, setRole] = useState<Role>("Administrador");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [resetRequests, setResetRequests] = useState<ResetRequest[]>([]);
  const [available, setAvailable] = useState(true);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", role: "Atendente" as string });
  // A senha aparece uma única vez: não é guardada em lugar nenhum, só o hash.
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/users", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: { available: boolean; users: UserRow[]; resetRequests?: ResetRequest[] }) => { if (active) { setAvailable(payload.available); setUsers(payload.users ?? []); setResetRequests(payload.resetRequests ?? []); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [nonce]);

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key); setError(null);
    try {
      const response = await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string; password?: string; user?: { email: string } };
      if (!response.ok) { setError(payload.error ?? "Ação recusada"); return; }
      if (payload.password && payload.user) setSecret({ email: payload.user.email, password: payload.password });
      setNonce((value) => value + 1);
    } catch { setError("Falha ao falar com o servidor"); }
    finally { setBusy(null); }
  }

  const when = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR") : "nunca";
  return <main className="content">
    <Heading title="Usuários e Permissões" text="Quem tem acesso ao LZR HUB, o que cada perfil pode fazer e como revogar." />
    {error && <div className="state-card error">{error}</div>}
    {secret && <div className="state-card"><strong>Senha de {secret.email}:</strong> <code style={{ fontSize: 14, userSelect: "all" }}>{secret.password}</code>
      <p style={{ marginTop: 8, lineHeight: 1.6 }}>Anote agora — ela não é guardada em lugar nenhum, só o hash. Não dá para consultá-la depois; só gerar outra.</p>
      <button className="button secondary" style={{ marginTop: 8 }} onClick={() => setSecret(null)}>Já anotei</button>
    </div>}

    {resetRequests.length > 0 && <section className="data-card">
      <div className="card-header"><strong>Pedidos de recuperação de senha</strong><span className="badge amber">{resetRequests.length}</span></div>
      <div style={{ padding: "4px 0" }}>
        {resetRequests.map((item) => {
          const match = users.find((user) => user.email === item.email);
          return <div className="permission-row" key={item.id} style={{ flexWrap: "wrap", gap: 10 }}>
            <span style={{ flex: 1, minWidth: 220 }}><strong>{item.email}</strong><small style={{ display: "block", color: "var(--muted)" }}>{new Date(item.createdAt).toLocaleString("pt-BR")}{item.note ? ` • "${item.note}"` : ""}{match ? "" : " • nenhuma conta com este e-mail"}</small></span>
            <span style={{ display: "flex", gap: 8 }}>
              {match && <button disabled={busy !== null} onClick={() => void act(`pwd:${match.id}`, { action: "reset-password", id: match.id, requestId: item.id })}>Gerar senha nova</button>}
              <button disabled={busy !== null} onClick={() => void act(`dismiss:${item.id}`, { action: "dismiss-reset", requestId: item.id })}>Descartar</button>
            </span>
          </div>;
        })}
      </div>
      {/* O pedido é aceito mesmo sem conta correspondente, de propósito: recusar
          revelaria quais e-mails têm conta. Por isso alguns aparecem sem par. */}
      <div className="state-card" style={{ margin: 14 }}>Não há envio de e-mail no LZR HUB: a senha gerada aparece aqui e você a entrega à pessoa. Ela vai ser obrigada a definir a dela no primeiro acesso.</div>
    </section>}

    <section className="data-card" style={{ marginTop: resetRequests.length > 0 ? 14 : 0 }}>
      <div className="card-header"><strong>Nova conta</strong><span className="badge blue">Senha gerada pelo sistema</span></div>
      <div className="wizard" style={{ display: "grid", gap: 8 }}>
        <input placeholder="Nome completo" value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }); setError(null); }} />
        <input placeholder="e-mail@bbnet.com" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <button className="button" disabled={busy !== null} onClick={() => void act("create", { action: "create", ...form }).then(() => setForm({ name: "", email: "", role: "Atendente" }))}>{busy === "create" ? "Criando…" : "Criar conta"}</button>
      </div>
    </section>

    <section className="data-card" style={{ marginTop: 14 }}>
      <div className="card-header"><strong>Contas</strong><span className="badge green">{state === "ready" && available ? users.length : "—"}</span></div>
      {state === "loading" && <p style={{ padding: 14 }}>Carregando contas…</p>}
      {state === "error" && <p style={{ padding: 14 }}>Não foi possível consultar as contas.</p>}
      {state === "ready" && !available && <p style={{ padding: 14 }}>Lista de usuários indisponível — sem banco não há de onde ler.</p>}
      {state === "ready" && available && users.length === 0 && <p style={{ padding: 14, lineHeight: 1.6, color: "var(--muted)" }}>Nenhuma conta cadastrada.</p>}
      {state === "ready" && available && users.map((user) => <div className="permission-row" key={user.id} style={{ flexWrap: "wrap", gap: 10 }}>
        <span style={{ flex: 1, minWidth: 220 }}><strong>{user.name}</strong><small style={{ display: "block", color: "var(--muted)" }}>{user.email} • último acesso: {when(user.lastLoginAt)}</small></span>
        <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={user.role} disabled={busy !== null} onChange={(event) => void act(`role:${user.id}`, { action: "set-role", id: user.id, role: event.target.value })}>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <i className={`badge ${user.active ? "green" : ""}`}>{user.active ? "ativa" : "inativa"}</i>
          {user.mustChangePassword && <i className="badge amber">senha provisória</i>}
          <button disabled={busy !== null} onClick={() => void act(`active:${user.id}`, { action: "set-active", id: user.id, active: !user.active })}>{user.active ? "Desativar" : "Reativar"}</button>
          <button disabled={busy !== null} onClick={() => void act(`pwd:${user.id}`, { action: "reset-password", id: user.id })}>Resetar senha</button>
        </span>
      </div>)}
      <div className="state-card" style={{ margin: 14 }}>Desativar tem efeito imediato: a sessão é verificada a cada requisição, então a pessoa perde o acesso no próximo clique — não é preciso esperar a sessão expirar. O mesmo vale para troca de perfil.</div>
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

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">♟</span></div><strong>{value}</strong><small>{detail}</small></article>;
}

function Heading({ title, text }: { title: string; text: string }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div><span className="badge green">Seguro por padrão</span></div>;
}
