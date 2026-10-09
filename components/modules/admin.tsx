"use client";

import { useCallback, useEffect, useState } from "react";
import { queueNames, type QueueAction, type QueueSnapshot } from "@/lib/platform/queue-service";
import { permissions, rolePermissions, roles } from "@/lib/platform/rbac";
import { HANDOFF_REASONS, reasonHint, reasonLabel, type Team, type TeamLoad } from "@/lib/platform/teams-shared";
import { Icon } from "@/components/ui/icons";
import { Avatar, Badge, Bar, Card, Empty, InfoTip, Limits, Loading, Modal, Notice, Segmented, Stat, Stats, Toolbar, count, dateTime, useToast } from "@/components/ui/kit";

export function AdminModule({ view }: { view: "integracoes" | "equipes" | "usuarios" | "auditoria" | "filas" }) {
  if (view === "integracoes") return <Integrations />;
  if (view === "usuarios") return <Users />;
  if (view === "auditoria") return <Audit />;
  if (view === "filas") return <Queues />;
  return <Teams />;
}

/* ----------------------------------------------------------------- equipes --- */

type Person = { id: string; name: string; email: string; role: string; active: boolean };
type TeamsPayload = {
  available: boolean; detail?: string; period: string;
  teams: Team[]; load: TeamLoad[]; unclaimed: Array<{ reason: string; count: number }>;
  totalHandoffs: number; people: Person[];
};
const TEAM_PERIODS = [["7d", "7 dias"], ["30d", "30 dias"], ["90d", "90 dias"]] as const;
const EMPTY_TEAM = { name: "", queue: "", description: "", handoffReasons: [] as string[] };

/**
 * Equipes de atendimento. "Equipes e Filas" misturava isto com as filas técnicas
 * do BullMQ — jobs de infraestrutura, não gente. Agora cada um tem a sua aba.
 */
function Teams() {
  const [period, setPeriod] = useState<typeof TEAM_PERIODS[number][0]>("7d");
  const [data, setData] = useState<TeamsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [nonce, setNonce] = useState(0);
  const [form, setForm] = useState(EMPTY_TEAM);
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/teams?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: TeamsPayload) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [period, nonce]);

  async function send(body: Record<string, unknown>, success?: string) {
    setBusy(true); setError("");
    const response = await fetch("/api/admin/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) { setForm(EMPTY_TEAM); setEditing(null); setFormOpen(false); setNonce((value) => value + 1); if (success) toast(success); }
    else { const payload = await response.json().catch(() => ({})); setError(payload.error ?? "Não foi possível concluir a ação"); toast(payload.error ?? "Não foi possível concluir a ação", "bad"); }
    setBusy(false);
  }

  const toggleReason = (reason: string) => setForm((current) => ({
    ...current,
    handoffReasons: current.handoffReasons.includes(reason) ? current.handoffReasons.filter((value) => value !== reason) : [...current.handoffReasons, reason],
  }));
  const loadOf = (id: string) => data?.load.find((item) => item.teamId === id);
  const coberto = new Set((data?.teams ?? []).filter((team) => team.active).flatMap((team) => team.handoffReasons));

  return <>
    <Toolbar actions={state === "ready" && data?.available && <button className="button" onClick={() => { setEditing(null); setForm(EMPTY_TEAM); setError(""); setFormOpen(true); }}><Icon name="plus" size={16} />Nova equipe</button>}>
      <Segmented label="Período" value={period} options={TEAM_PERIODS} onChange={(value) => { setState("loading"); setPeriod(value); }} />
      {/* Sem isto a tela seria lida como roteador. Ela não é. */}
      <InfoTip label="O que uma equipe faz aqui">Registrar equipe <strong>não encaminha atendimento</strong>: nada entrega uma conversa para uma fila. O que existe é o registro de quem assume cada motivo de transbordo, e a contagem real por motivo. Um motivo pode ser assumido por mais de uma equipe — conta para as duas.</InfoTip>
    </Toolbar>

    {state === "loading" && <Loading stats={4} rows={3} />}
    {state === "error" && <Notice tone="bad">Não foi possível consultar as equipes.</Notice>}
    {state === "ready" && data && !data.available && <Notice tone="bad">{data.detail}.</Notice>}

    {state === "ready" && data?.available && <>
      <Stats>
        <Stat label="Equipes ativas" icon="team" value={count(data.teams.filter((team) => team.active).length)} hint={data.teams.length ? `${data.teams.length} cadastrada(s)` : "Nenhuma cadastrada"} />
        <Stat label="Transbordos no período" icon="users" value={count(data.totalHandoffs)} hint="Medidos nas conversas gravadas" />
        <Stat label="Motivos cobertos" icon="check" value={`${coberto.size} de ${HANDOFF_REASONS.length}`} hint="Assumidos por alguma equipe ativa" />
        <Stat label="Sem equipe" icon="alert" tone={data.unclaimed.length ? "warn" : "ok"} value={count(data.unclaimed.reduce((sum, row) => sum + row.count, 0))} hint={data.unclaimed.length ? `${data.unclaimed.length} motivo(s) descoberto(s)` : "Tudo coberto"} />
      </Stats>

      {data.unclaimed.length > 0 && <Card title="Transbordos que ninguém assumiu" badge={<Badge tone="warn">{data.unclaimed.length}</Badge>}>
        <div className="bars">{data.unclaimed.map((row) => <Bar key={row.reason} label={reasonLabel(row.reason)} detail={reasonHint(row.reason)} value={row.count} max={Math.max(data.totalHandoffs, 1)} />)}</div>
      </Card>}

      <Card title="Equipes" badge={<Badge>{data.teams.length}</Badge>} flush>
        {data.teams.length === 0
          ? <Empty icon="team" title="Nenhuma equipe cadastrada" action={<button className="button secondary" onClick={() => setFormOpen(true)}>Criar a primeira</button>} />
          : data.teams.map((team) => <div className="team-row" key={team.id}>
              <div className="team-head">
                <div>
                  <strong>{team.name}{!team.active && <Badge tone="warn">desativada</Badge>}</strong>
                  <span><code>{team.queue}</code>{team.description ? ` · ${team.description}` : ""}</span>
                </div>
                <div className="team-load"><b>{loadOf(team.id)?.handoffs ?? 0}</b><small>transbordo(s)</small></div>
              </div>
              <div className="chips">
                {team.handoffReasons.length === 0
                  ? <em>Nenhum motivo assumido — a equipe não recebe contagem.</em>
                  : team.handoffReasons.map((reason) => <span className="chip" key={reason} title={reasonHint(reason)}>{reasonLabel(reason)} <b>{loadOf(team.id)?.byReason[reason] ?? 0}</b></span>)}
              </div>
              <div className="team-people">
                {team.members.length === 0 ? <em>Sem ninguém vinculado.</em> : team.members.map((member) => <span key={member.userId}>
                  {member.name}<small>{member.role}</small>
                  <button className="icon-button" style={{ width: 20, height: 20 }} disabled={busy} onClick={() => void send({ action: "remove-member", teamId: team.id, userId: member.userId })} aria-label={`Remover ${member.name} da equipe`} title={`Remover ${member.name}`}><Icon name="x" size={12} /></button>
                </span>)}
              </div>
              <div className="team-actions">
                <select className="select" value="" disabled={busy} aria-label={`Vincular pessoa à equipe ${team.name}`} onChange={(event) => { if (event.target.value) void send({ action: "add-member", teamId: team.id, userId: event.target.value }); }}>
                  <option value="">+ Vincular pessoa…</option>
                  {data.people.filter((person) => person.active && !team.members.some((member) => member.userId === person.id))
                    .map((person) => <option key={person.id} value={person.id}>{person.name} — {person.role}</option>)}
                </select>
                <button className="button secondary small" disabled={busy} onClick={() => { setEditing(team.id); setForm({ name: team.name, queue: team.queue, description: team.description ?? "", handoffReasons: [...team.handoffReasons] }); setError(""); setFormOpen(true); }}>Alterar</button>
                <button className="button ghost small" disabled={busy} onClick={() => void send({ action: "set-active", id: team.id, active: !team.active }, team.active ? "Equipe desativada." : "Equipe reativada.")}>{team.active ? "Desativar" : "Reativar"}</button>
              </div>
            </div>)}
      </Card>
    </>}

    <Modal open={formOpen} title={editing ? "Alterar equipe" : "Nova equipe"} onClose={() => { setFormOpen(false); setEditing(null); setError(""); }}
      footer={<><button className="button secondary" disabled={busy} onClick={() => { setFormOpen(false); setEditing(null); }}>Cancelar</button>
        <button className="button" disabled={busy || !form.name.trim()} onClick={() => void send(editing ? { action: "update", id: editing, ...form } : { action: "create", ...form }, editing ? "Equipe alterada." : "Equipe criada.")}>{busy ? "Salvando…" : editing ? "Salvar" : "Criar equipe"}</button></>}>
      <div className="stack">
        <label className="field"><span>Nome</span><input data-autofocus value={form.name} placeholder="ex.: Suporte técnico N1" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
        <div className="form-grid">
          <label className="field"><span>Fila</span><input value={form.queue} placeholder="ex.: suporte-tecnico" onChange={(event) => setForm((current) => ({ ...current, queue: event.target.value }))} /></label>
          <label className="field"><span>Descrição (opcional)</span><input value={form.description} placeholder="ex.: 8h às 18h" onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
        </div>
        <fieldset className="checks">
          <legend>Motivos de transbordo que esta equipe assume</legend>
          {HANDOFF_REASONS.map((reason) => <label key={reason} title={reasonHint(reason)}>
            <input type="checkbox" checked={form.handoffReasons.includes(reason)} onChange={() => toggleReason(reason)} />
            <span>{reasonLabel(reason)}</span>
          </label>)}
        </fieldset>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  </>;
}

/* ------------------------------------------------------------- integrações --- */

type Service = { name: string; state: string; mode: string; detail: string };
type StatusPayload = { environment: string; auth: { enforced: boolean; detail: string }; services: Service[] };
const STATE_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { ok: "ok", healthy: "ok", "observação": "warn", degraded: "warn", error: "bad", disabled: "neutral" };
const STATE_LABEL: Record<string, string> = { ok: "funcionando", healthy: "funcionando", "observação": "observação", degraded: "incompleto", error: "com erro", disabled: "desligado" };

/**
 * Integrações e ambiente. "Configurações" era uma segunda tela lendo o mesmo
 * `/api/admin/status`, com cartões fixos que envelheceram mal: anunciava
 * "escrita não existe no guard" depois que o catálogo de escrita foi ligado.
 * O que é estado vem do servidor; o que é decisão de código fica recolhido.
 */
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

  if (state === "loading") return <Loading stats={3} rows={0} />;
  if (state === "error" || !status) return <Notice tone="bad">Não foi possível consultar o estado das integrações.</Notice>;
  const working = status.services.filter((service) => STATE_TONE[service.state] === "ok" || service.state === "observação").length;
  const problems = status.services.filter((service) => service.state === "error" || service.state === "degraded");
  return <>
    <Toolbar actions={<button className="button secondary" onClick={() => { setState("loading"); setRefresh((value) => value + 1); }}><Icon name="refresh" size={16} />Atualizar</button>}>
      <span className="muted small">Ambiente <strong className="text-ink">{status.environment}</strong> · login {status.auth.enforced ? "obrigatório" : <strong className="warn-text">desligado</strong>} · {working} de {status.services.length} integrações em uso</span>
    </Toolbar>
    {!status.auth.enforced && <Notice tone="bad" title="Atenção:">{status.auth.detail}.</Notice>}
    {problems.length > 0 && <Notice tone="warn">{problems.map((service) => service.name).join(", ")} {problems.length === 1 ? "precisa" : "precisam"} de atenção.</Notice>}
    <div className="grid-3">{status.services.map((service) => <article className="service" key={service.name}>
      <div className="service-top"><strong>{service.name}</strong><Badge tone={STATE_TONE[service.state] ?? "neutral"} dot>{STATE_LABEL[service.state] ?? service.state}</Badge></div>
      <span className="service-mode">{service.mode}</span>
      <p>{service.detail}</p>
    </article>)}</div>
    <Limits title="Políticas que valem hoje (decisões de código)" items={[
      ["Persistência", "Postgres no Railway; migrações aplicadas no deploy."],
      ["Dado pessoal em log", "Mascaramento obrigatório de CPF, telefone, e-mail e endereço antes de gravar ou enviar telemetria."],
      ["Dado pessoal na tela", "Completo para quem tem sessão: a proteção é login e perfil de acesso, não texto truncado."],
      ["Resiliência do IXC", "Circuit breaker, timeout curto, um retry e limite de consultas por minuto compartilhado pelo processo inteiro."],
      ["Busca de conhecimento", "Correspondência de texto; sem embeddings (FEATURE_PGVECTOR desligada)."],
    ]} />
  </>;
}

/* -------------------------------------------------------------------- filas --- */

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
    setBusy(key); setError(null);
    try {
      const response = await fetch("/api/queues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Falha na ação");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha na ação de fila"); }
    finally { setBusy(null); }
  }

  if (!snapshot && !error) return <Loading rows={3} />;
  const jobs = snapshot?.jobs ?? [];
  return <>
    <Toolbar actions={<button className="button secondary" onClick={() => void load()} disabled={busy !== null}><Icon name="refresh" size={16} />Atualizar</button>}>
      <span className="muted small">Jobs de infraestrutura (Redis/BullMQ). Não são equipes nem atendimento.</span>
    </Toolbar>
    {snapshot && !snapshot.enabled && <Notice tone="neutral" title="Filas desligadas.">{snapshot.detail ?? "Ative FEATURE_QUEUES e configure o serviço."}</Notice>}
    {error && <Notice tone="bad">{error}</Notice>}
    {snapshot?.enabled && <div className="chips" style={{ marginBottom: 16 }}>{queueNames.map((queue) => <span className="chip" key={queue}>{queue} <b>{snapshot.counts[queue] ?? 0}</b></span>)}</div>}
    <Card title={`Runtime: ${snapshot?.runtime ?? "—"}`} flush>
      {jobs.length === 0
        ? <Empty icon="clock" title="Nenhum job disponível">Os jobs reais aparecem aqui quando as filas estiverem ligadas.</Empty>
        : <div className="table" style={{ ["--cols" as string]: "minmax(0,1.4fr) 140px 110px minmax(0,1fr) 120px" }}>
            <div className="tr head hide-sm"><span>Job / fila</span><span>Situação</span><span>Tentativas</span><span>Correlação</span><span></span></div>
            {jobs.map((job) => {
              const key = `${job.queue}:${job.id}`;
              return <div className="tr stack-sm" key={key}>
                <span className="cell"><strong>{job.name}</strong><small>{job.queue} · {job.idempotencyKey}</small></span>
                <span className="cell"><Badge tone={job.status === "completed" ? "ok" : job.status === "failed" ? "bad" : "info"}>{job.status}</Badge>{job.error && <small>{job.error}</small>}</span>
                <span className="cell"><strong>{job.attempts}/{job.maxAttempts}</strong><small>{job.durationMs} ms</small></span>
                <code className="clip">{job.correlationId}</code>
                <span>{job.status === "failed" && <button className="button secondary small" disabled={busy === key} onClick={() => void act({ action: "retry", queue: job.queue, id: job.id })}>Reprocessar</button>}
                  {job.status === "waiting" && job.queue !== "dead-letter" && <button className="button ghost small" disabled={busy === key} onClick={() => void act({ action: "cancel", queue: job.queue, id: job.id })}>Cancelar</button>}</span>
              </div>;
            })}
          </div>}
    </Card>
  </>;
}

/* ----------------------------------------------------------------- usuários --- */

type UserRow = { id: string; name: string; email: string; role: string; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string };
type ResetRequest = { id: string; email: string; note: string | null; createdAt: string };

function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [resetRequests, setResetRequests] = useState<ResetRequest[]>([]);
  const [available, setAvailable] = useState(true);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [showMatrix, setShowMatrix] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "Atendente" as string });
  // A senha aparece uma única vez: não é guardada em lugar nenhum, só o hash.
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    fetch("/api/admin/users", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: { available: boolean; users: UserRow[]; resetRequests?: ResetRequest[] }) => { if (active) { setAvailable(payload.available); setUsers(payload.users ?? []); setResetRequests(payload.resetRequests ?? []); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [nonce]);

  async function act(key: string, body: Record<string, unknown>, success?: string) {
    setBusy(key); setError(null);
    try {
      const response = await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string; password?: string; user?: { email: string } };
      if (!response.ok) { setError(payload.error ?? "Ação recusada"); return false; }
      if (payload.password && payload.user) setSecret({ email: payload.user.email, password: payload.password });
      else if (success) toast(success);
      setNonce((value) => value + 1);
      return true;
    } catch { setError("Falha ao falar com o servidor"); return false; }
    finally { setBusy(null); }
  }

  if (state === "loading") return <Loading rows={6} />;
  if (state === "error") return <Notice tone="bad">Não foi possível consultar as contas.</Notice>;
  if (!available) return <Notice tone="bad">Lista de usuários indisponível — sem banco não há de onde ler.</Notice>;
  const when = (value: string | null) => value ? dateTime(value) : "nunca";
  const term = query.trim().toLowerCase();
  const shown = users.filter((user) => !term || `${user.name} ${user.email} ${user.role}`.toLowerCase().includes(term));
  return <>
    <Toolbar actions={<>
      <button className="button secondary" onClick={() => setShowMatrix(true)}>Perfis e permissões</button>
      <button className="button" onClick={() => { setCreating(true); setError(null); }}><Icon name="plus" size={16} />Nova conta</button>
    </>}>
      <label className="search-field"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nome, e-mail ou perfil" aria-label="Buscar usuário" /></label>
      <InfoTip label="Como desativar funciona">Desativar e trocar perfil têm efeito imediato: a sessão é verificada a cada requisição, então a pessoa perde o acesso no próximo clique.</InfoTip>
    </Toolbar>
    {error && <Notice tone="bad">{error}</Notice>}
    {secret && <Notice tone="ok" title={`Senha de ${secret.email}:`} action={<button className="button secondary small" onClick={() => setSecret(null)}>Já anotei</button>}>
      <div className="secret"><code>{secret.password}</code><button className="button ghost small" onClick={() => { void navigator.clipboard.writeText(secret.password).then(() => toast("Senha copiada.")).catch(() => undefined); }}><Icon name="copy" size={14} />Copiar</button></div>
      <p className="hint" style={{ marginTop: 6 }}>Anote agora — ela não é guardada em lugar nenhum, só o hash. Não há envio de e-mail: entregue à pessoa, que vai definir a dela no primeiro acesso.</p>
    </Notice>}

    {resetRequests.length > 0 && <Card title="Pedidos de nova senha" badge={<Badge tone="warn">{resetRequests.length}</Badge>} flush>
      {/* O pedido é aceito mesmo sem conta correspondente, de propósito: recusar
          revelaria quais e-mails têm conta. Por isso alguns aparecem sem par. */}
      <div className="list">{resetRequests.map((item) => {
        const match = users.find((user) => user.email === item.email);
        return <div className="row" key={item.id}>
          <div className="row-main"><strong>{item.email}</strong><span>{dateTime(item.createdAt)}{item.note ? ` · “${item.note}”` : ""}{match ? "" : " · nenhuma conta com este e-mail"}</span></div>
          <div className="row-value">
            {match && <button className="button small" disabled={busy !== null} onClick={() => void act(`pwd:${match.id}`, { action: "reset-password", id: match.id, requestId: item.id })}>Gerar senha nova</button>}
            <button className="button ghost small" disabled={busy !== null} onClick={() => void act(`dismiss:${item.id}`, { action: "dismiss-reset", requestId: item.id }, "Pedido descartado.")}>Descartar</button>
          </div>
        </div>;
      })}</div>
    </Card>}

    <Card title="Contas" badge={<Badge>{users.length}</Badge>} flush>
      {shown.length === 0
        ? <Empty icon="users" title={users.length ? "Ninguém com esse nome" : "Nenhuma conta cadastrada"} />
        : <div className="table" style={{ ["--cols" as string]: "minmax(0,2fr) 170px 150px 230px" }}>
            <div className="tr head hide-sm"><span>Pessoa</span><span>Perfil</span><span>Situação</span><span></span></div>
            {shown.map((user) => <div className="tr stack-sm" key={user.id}>
              <span className="cell" style={{ display: "flex", gap: 10, alignItems: "center" }}><Avatar name={user.name} /><span style={{ minWidth: 0 }}><strong>{user.name}</strong><small>{user.email} · último acesso: {when(user.lastLoginAt)}</small></span></span>
              <select className="select" value={user.role} disabled={busy !== null} aria-label={`Perfil de ${user.name}`} onChange={(event) => void act(`role:${user.id}`, { action: "set-role", id: user.id, role: event.target.value }, `Perfil de ${user.name} alterado.`)}>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <span className="chips"><Badge tone={user.active ? "ok" : "neutral"} dot>{user.active ? "ativa" : "inativa"}</Badge>{user.mustChangePassword && <Badge tone="warn">senha provisória</Badge>}</span>
              <span className="form-actions" style={{ justifyContent: "flex-end" }}>
                <button className="button ghost small" disabled={busy !== null} onClick={() => void act(`pwd:${user.id}`, { action: "reset-password", id: user.id })}>Resetar senha</button>
                <button className={`button small ${user.active ? "danger" : "secondary"}`} disabled={busy !== null} onClick={() => void act(`active:${user.id}`, { action: "set-active", id: user.id, active: !user.active }, user.active ? `${user.name} desativado(a).` : `${user.name} reativado(a).`)}>{user.active ? "Desativar" : "Reativar"}</button>
              </span>
            </div>)}
          </div>}
    </Card>

    <Modal open={creating} title="Nova conta" onClose={() => setCreating(false)}
      footer={<><button className="button secondary" onClick={() => setCreating(false)}>Cancelar</button>
        <button className="button" disabled={busy !== null || !form.name.trim() || !form.email.trim()} onClick={() => void act("create", { action: "create", ...form }).then((ok) => { if (ok) { setForm({ name: "", email: "", role: "Atendente" }); setCreating(false); } })}>{busy === "create" ? "Criando…" : "Criar conta"}</button></>}>
      <div className="stack">
        <label className="field"><span>Nome completo</span><input data-autofocus value={form.name} placeholder="ex.: Camila Torres" onChange={(event) => { setForm({ ...form, name: event.target.value }); setError(null); }} /></label>
        <label className="field"><span>E-mail</span><input type="email" value={form.email} placeholder="ex.: camila@bbnet.com" onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="field"><span>Perfil de acesso</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <p className="field-hint">A senha é gerada pelo sistema e mostrada uma única vez. A pessoa é obrigada a definir a dela no primeiro acesso.</p>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>

    <Modal open={showMatrix} title="Perfis e permissões" wide onClose={() => setShowMatrix(false)}>
      <div className="matrix"><table>
        <thead><tr><th>Permissão</th>{roles.map((role) => <th key={role}>{role}</th>)}</tr></thead>
        <tbody>{permissions.map((permission) => <tr key={permission}><td><code>{permission}</code></td>{roles.map((role) => {
          const allowed = rolePermissions[role].includes(permission);
          return <td key={role} className={allowed ? "yes" : "no"} aria-label={allowed ? "permitido" : "negado"}>{allowed ? "✓" : "—"}</td>;
        })}</tr>)}</tbody>
      </table></div>
    </Modal>
  </>;
}

/* ---------------------------------------------------------------- auditoria --- */

type AuditEvent = { id: string; actorId: string; role: string; action: string; entity: string; reason: string; correlationId: string; result: string; origin: string; createdAt: string };
type AuditPayload = { available: boolean; events: AuditEvent[]; detail?: string };
const RESULT_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { success: "ok", blocked: "warn", failed: "bad", simulated: "neutral" };

function Audit() {
  const [payload, setPayload] = useState<AuditPayload | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<"all" | "success" | "blocked" | "failed">("all");
  useEffect(() => {
    fetch("/api/audit", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setPayload(data as AuditPayload))
      .catch(() => setPayload({ available: false, events: [], detail: "Falha ao consultar a auditoria" }));
  }, []);

  if (!payload) return <Loading rows={8} />;
  // Auditoria indisponível não pode cair para registros de exemplo: um rastro
  // falso é exatamente o tipo de coisa que alguém usaria para dizer "está tudo
  // registrado". Melhor a tela ficar vazia e explicar.
  if (!payload.available) return <Notice tone="bad" title="Rastro indisponível:">{payload.detail ?? "banco não configurado"}. Nada é exibido no lugar.</Notice>;
  const term = query.trim().toLowerCase();
  const rows = payload.events.filter((event) => (result === "all" || event.result === result) && (!term || `${event.actorId} ${event.action} ${event.entity} ${event.reason} ${event.correlationId}`.toLowerCase().includes(term)));
  return <>
    <Toolbar>
      <label className="search-field"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar ação, pessoa, entidade ou rastro (correlationId)" aria-label="Buscar na auditoria" /></label>
      <Segmented label="Resultado" value={result} onChange={setResult} options={[["all", "Todos"], ["success", "Sucesso"], ["blocked", "Bloqueado"], ["failed", "Falhou"]]} />
    </Toolbar>
    <Card flush>
      {rows.length === 0
        ? <Empty icon="clipboard" title={payload.events.length ? "Nada com esse filtro" : "Nenhuma ação registrada ainda"}>{payload.events.length ? undefined : "As ações reais aparecem aqui conforme forem executadas."}</Empty>
        : <div className="table" style={{ ["--cols" as string]: "minmax(0,1fr) minmax(0,1.6fr) minmax(0,1fr) 110px minmax(0,1.1fr)" }}>
            <div className="tr head hide-sm"><span>Quem / origem</span><span>Ação</span><span>Entidade</span><span>Resultado</span><span>Rastro / quando</span></div>
            {rows.map((event) => <div className="tr stack-sm" key={event.id}>
              <span className="cell"><strong>{event.actorId}</strong><small>{event.role} · {event.origin}</small></span>
              <span className="cell"><strong>{event.action}</strong><small title={event.reason}>{event.reason}</small></span>
              <span className="clip" title={event.entity}>{event.entity}</span>
              <span><Badge tone={RESULT_TONE[event.result] ?? "neutral"}>{event.result}</Badge></span>
              <span className="cell"><code className="clip" title={event.correlationId}>{event.correlationId}</code><small>{dateTime(event.createdAt)}</small></span>
            </div>)}
          </div>}
    </Card>
  </>;
}
