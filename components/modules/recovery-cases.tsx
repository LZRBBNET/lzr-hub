"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Navigate } from "@/components/lzr-hub-app";
import type { RecoveryCaseDetailPayload, RecoveryCaseEvent, RecoveryCaseMutation, RecoveryCaseMutationPayload, RecoveryCaseReason, RecoveryCasesListPayload, SupervisedRecoveryCase } from "@/lib/platform/recovery-cases-shared";
import { Badge, Card, Empty, ErrorState, Loading, Modal, Notice, Toolbar, count } from "@/components/ui/kit";

const ENDPOINT = "/api/billing/recovery/cases";
const PAGE_SIZE = 20;
const REASONS: Record<RecoveryCaseReason, string> = { debt: "Dívida a acompanhar", cancellation: "Pedido de cancelamento relatado", both: "Dívida e pedido de cancelamento" };
const STATUS: Record<SupervisedRecoveryCase["status"], string> = { open: "Aberto", in_progress: "Em acompanhamento", waiting: "Aguardando retorno", closed: "Encerrado" };
const EVENTS: Record<RecoveryCaseEvent["type"], string> = { opened: "Caso aberto", claimed: "Responsável alterado", scheduled: "Retorno registrado", note: "Relato manual", invoice_linked: "Fatura vinculada", promise_linked: "Promessa vinculada", attendance_linked: "Atendimento vinculado", closed: "Caso encerrado pelo operador", reopened: "Caso reaberto" };
const calendarDate = (value: string | null) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Não definido";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value.split("-").reverse().join("/") : "Data não confirmada";
};
const observedTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Horário não confirmado";
type DraftMutation = RecoveryCaseMutation extends infer T ? T extends RecoveryCaseMutation ? Omit<T, "idempotencyKey"> : never : never;
type Attempt = { body: RecoveryCaseMutation; uncertain: boolean; pending: boolean };
// Browser-memory journal only: no PII in persistent browser storage. Client events
// are its only writers; SSR always sees null. Actor keys prevent session crossover.
// Survives local navigation, not a full reload: then consult history before retrying.
const attempts = new Map<string, Attempt>();
const attemptListeners = new Set<() => void>();
const subscribeAttempts = (listener: () => void) => { attemptListeners.add(listener); return () => { attemptListeners.delete(listener); }; };
function publishAttempt(slot: string, attempt: Attempt | null) {
  if (attempt) attempts.set(slot, attempt); else attempts.delete(slot);
  for (const listener of attemptListeners) listener();
}
const ownerLabel = (item: SupervisedRecoveryCase) => item.ownerId ? (item.ownerName || `Operador ${item.ownerId} (nome indisponível)`) : "Sem responsável";

/** All writes here are explicit operator records in HUB; none send a message or alter IXC. */
export function RecoveryCasesModule({ initialCustomerId = "", onNavigate }: { initialCustomerId?: string; onNavigate?: Navigate }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("active");
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data?: RecoveryCasesListPayload; error?: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(!!initialCustomerId);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const key = `${page}|${status}|${revision}`;
  const loading = loaded?.key !== key;
  const data = loading ? undefined : loaded?.data;
  function reload() { if (alive.current) setRevision(value => value + 1); }

  useEffect(() => {
    const controller = new AbortController(); let active = true;
    fetch(`${ENDPOINT}?page=${page}&pageSize=${PAGE_SIZE}&status=${encodeURIComponent(status)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as RecoveryCasesListPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Não foi possível consultar os casos.");
        if (!Array.isArray(payload.items)) throw new Error("Resposta de casos não confirmada.");
        if (active && payload.available && page > Math.max(1, Math.ceil((payload.total ?? 0) / PAGE_SIZE))) { setPage(Math.max(1, Math.ceil((payload.total ?? 0) / PAGE_SIZE))); return; }
        if (active) setLoaded({ key, data: payload });
      }).catch((error: unknown) => { if (active) setLoaded({ key, error: error instanceof Error ? error.message : "Consulta indisponível." }); });
    return () => { active = false; controller.abort(); };
  }, [page, status, key]);

  const actor = data?.currentActorId ?? loaded?.data?.currentActorId ?? "";
  return <>
    <Notice title="Acompanhamento supervisionado">Responsável, retorno e histórico ficam no HUB. Nenhuma mensagem, cobrança, negociação ou alteração no IXC é executada por esta fila.</Notice>
    <Toolbar actions={<>
      <button type="button" className="button secondary" disabled={loading} onClick={reload}>Atualizar casos</button>
      {data?.available && data.canWrite && <button type="button" className="button" onClick={() => setCreating(true)}>Abrir caso</button>}
    </>}>
      <label className="field"><span>Mostrar casos</span><select aria-label="Mostrar casos" className="select" value={status} onChange={event => { setSelectedId(null); setStatus(event.target.value); setPage(1); }}><option value="active">Em aberto</option><option value="closed">Encerrados</option><option value="all">Todos</option></select></label>
    </Toolbar>
    {loading && <Loading rows={4} label="Consultando casos registrados" />}
    {!loading && loaded?.error && <ErrorState onRetry={reload}>{loaded.error}</ErrorState>}
    {data && !data.available && <Notice tone="warn">{data.detail ?? "Acompanhamento indisponível nesta instalação."} Nenhum caso foi criado automaticamente.</Notice>}
    {data?.available && <>
      {!data.canWrite && <Notice>Seu perfil pode consultar os casos. Alterações exigem permissão de cobrança e sessão autenticada.</Notice>}
      <Card title="Casos acompanhados" badge={<Badge>{count(data.total ?? 0)} registro(s)</Badge>} flush>
        {!data.items.length ? <Empty icon="clipboard" title="Nenhum caso neste filtro">A leitura de faturas não abre casos sozinha. Um operador precisa registrar o acompanhamento.</Empty> : <div className="list">{data.items.map(item => <button key={item.id} type="button" className="row link-like" style={{ width: "100%", textAlign: "left" }} onClick={() => setSelectedId(item.id)} aria-label={`Abrir caso do cliente ${item.customerId}`}>
          <span className="row-main"><strong>Cliente {item.customerId}</strong><span>{REASONS[item.reason] ?? "Motivo não confirmado"} · {ownerLabel(item)}</span><small>Retorno: {calendarDate(item.nextActionOn)}</small></span>
          <Badge tone={item.status === "closed" ? "neutral" : "info"}>{STATUS[item.status] ?? "Status não confirmado"}</Badge>
        </button>)}</div>}
      </Card>
      <Toolbar actions={<><button type="button" className="button secondary small" disabled={page <= 1} onClick={() => { setSelectedId(null); setPage(page - 1); }}>Casos anteriores</button><span className="small">Página {page} de {Math.max(1, Math.ceil((data.total ?? 0) / PAGE_SIZE))}</span><button type="button" className="button secondary small" disabled={page * PAGE_SIZE >= (data.total ?? 0)} onClick={() => { setSelectedId(null); setPage(page + 1); }}>Próximos casos</button></>}>
        <span className="hint">Fila por retorno e abertura. Não é previsão de cancelamento nem indicador de dinheiro recuperado.</span>
      </Toolbar>
    </>}
    {creating && data?.available && data.canWrite && <CreateCase actorId={actor} initialCustomerId={initialCustomerId} onChanged={reload} onClose={() => setCreating(false)} onCreated={item => { setCreating(false); setSelectedId(item.id); }} />}
    {selectedId && <CaseDetail key={`${actor}:${selectedId}`} id={selectedId} actorId={actor} onChanged={reload} onClose={() => setSelectedId(null)} onNavigate={onNavigate} />}
  </>;
}

/** Keeps the exact body/key after uncertainty; only an explicit operator retry resends it. */
function useMutation({ slot, onChanged, onConfirmed, onReload }: { slot: string; onChanged: () => void; onConfirmed?: (item: SupervisedRecoveryCase) => void; onReload?: () => void }) {
  const attempt = useSyncExternalStore(subscribeAttempts, () => attempts.get(slot) ?? null, () => null);
  const busy = !!attempt?.pending;
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const active = useRef(true), wasPending = useRef(busy), hasSubmitted = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  // A reopened modal observes the original request settling, without resending it.
  useEffect(() => {
    if (wasPending.current && !busy && !hasSubmitted.current) onReload?.();
    wasPending.current = busy;
  }, [busy, onReload]);
  async function submit(draft?: DraftMutation) {
    const existing = attempts.get(slot);
    if (existing?.pending || (existing && draft)) return;
    const body = existing?.body ?? (draft ? { ...draft, idempotencyKey: crypto.randomUUID() } as RecoveryCaseMutation : undefined);
    if (!body) return;
    hasSubmitted.current = true;
    publishAttempt(slot, { body, uncertain: false, pending: true }); setMessage(null); setSuccess(null);
    try {
      const response = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as RecoveryCaseMutationPayload & { error?: string };
      if (!response.ok) {
        if (response.status === 409 || response.status >= 500) {
          publishAttempt(slot, { body, uncertain: true, pending: false });
          if (active.current) setMessage(`${payload.error ?? "Alteração sem confirmação."} Consulte o estado atual antes de decidir. A solicitação anterior foi preservada, sem reenvio automático.`);
        } else {
          publishAttempt(slot, null);
          if (active.current) setMessage(payload.error ?? "Alteração recusada. Nenhum sucesso foi confirmado.");
        }
      } else {
        const item = payload.item;
        if (!item || typeof item.id !== "string" || !item.id.trim() || (body.action === "open" ? item.customerId !== body.customerId : item.id !== body.caseId)) throw new Error("Resposta de outro caso");
        publishAttempt(slot, null);
        if (active.current) { setSuccess(payload.replay ? "Solicitação anterior confirmada; não foi duplicada." : "Registro salvo no HUB. Nenhum contato foi enviado."); onConfirmed?.(item); }
      }
    } catch {
      publishAttempt(slot, { body, uncertain: true, pending: false });
      if (active.current) setMessage("Não foi possível confirmar a alteração. Ela pode ter sido salva. Consulte o caso antes de repetir; não houve reenvio automático.");
    } finally { if (active.current) onReload?.(); onChanged(); }
  }
  function discard() { if (attempts.get(slot)?.pending) return; publishAttempt(slot, null); setMessage("Prepare uma nova alteração somente após conferir o histórico atual. A operação anterior não foi desfeita."); }
  return { busy, attempt, message, success, submit, discard };
}

type MutationState = ReturnType<typeof useMutation>;
function MutationFeedback({ state, canRetry, onReload }: { state: MutationState; canRetry: boolean; onReload?: () => void }) {
  return <>
    {state.busy && <Notice>Gravação em andamento. Fechar não cancela a solicitação; aguarde a confirmação antes de outra alteração.</Notice>}
    {state.message && <Notice tone="warn">{state.message}</Notice>}
    {state.success && <Notice tone="ok">{state.success}</Notice>}
    {state.attempt?.uncertain && <div className="stack">
      <p className="hint">Editar ou fechar não cancela uma gravação já iniciada. O mesmo identificador será mantido para confirmar a solicitação anterior. Após recarregar o navegador, confira o histórico antes de repetir.</p>
      <div className="form-actions">{onReload && <button type="button" className="button secondary small" disabled={state.busy} onClick={onReload}>Consultar estado atual</button>}<button type="button" className="button secondary small" disabled={state.busy || !canRetry} onClick={() => void state.submit()}>Confirmar solicitação anterior</button><button type="button" className="button ghost small" disabled={state.busy || !canRetry} onClick={state.discard}>Conferi; preparar nova alteração</button></div>
    </div>}
  </>;
}

function CreateCase({ actorId, initialCustomerId, onChanged, onClose, onCreated }: { actorId: string; initialCustomerId: string; onChanged: () => void; onClose: () => void; onCreated: (item: SupervisedRecoveryCase) => void }) {
  const existing = attempts.get(`${actorId}:open`);
  const [customerId, setCustomerId] = useState(existing?.body.action === "open" ? existing.body.customerId : initialCustomerId);
  const [reason, setReason] = useState<RecoveryCaseReason>(existing?.body.action === "open" ? existing.body.reason : "debt");
  const mutation = useMutation({ slot: `${actorId}:open`, onChanged, onConfirmed: onCreated });
  const disabled = mutation.busy || !!mutation.attempt;
  return <Modal open title="Abrir acompanhamento no HUB" onClose={onClose} footer={<><button type="button" className="button secondary" onClick={onClose}>Fechar abertura</button><button type="button" className="button" disabled={disabled || !/^[1-9]\d{0,31}$/.test(customerId.trim())} onClick={() => void mutation.submit({ action: "open", customerId: customerId.trim(), reason })}>{mutation.busy ? "Salvando…" : "Salvar novo caso"}</button></>}>
    <Notice>Este registro organiza o trabalho humano. Não envia cobrança, não confirma dívida integral e não cancela ou altera contrato.</Notice>
    <div className="form-grid"><label className="field"><span>Cliente IXC</span><input aria-label="Cliente IXC do caso" value={customerId} disabled={disabled} onChange={event => setCustomerId(event.target.value)} inputMode="numeric" /></label><label className="field"><span>Motivo relatado</span><select aria-label="Motivo do caso" value={reason} disabled={disabled} onChange={event => setReason(event.target.value as RecoveryCaseReason)}>{Object.entries(REASONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <MutationFeedback state={mutation} canRetry={!mutation.busy} onReload={onChanged} />
    <p className="hint">O servidor confirma o cadastro e impede dois casos abertos para o mesmo cliente nesta instalação. Pedido de cancelamento é um relato a conferir, não cancelamento executado.</p>
  </Modal>;
}

function CaseDetail({ id, actorId, onChanged, onClose, onNavigate }: { id: string; actorId: string; onChanged: () => void; onClose: () => void; onNavigate?: Navigate }) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ revision: number; data?: RecoveryCaseDetailPayload; error?: string } | null>(null);
  const loading = loaded?.revision !== revision;
  const data = loading ? undefined : loaded?.data;
  const item = data?.item;
  const [action, setAction] = useState("note"), [value, setValue] = useState(""), [takeOver, setTakeOver] = useState(false);
  const reload = () => setRevision(current => current + 1);
  const mutation = useMutation({ slot: `${actorId}:${id}`, onChanged, onReload: reload, onConfirmed: () => { setValue(""); setTakeOver(false); } });
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    fetch(`${ENDPOINT}?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as RecoveryCaseDetailPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Não foi possível abrir este caso.");
        if (!Array.isArray(payload.events)) throw new Error("Histórico não confirmado.");
        if (payload.item && payload.item.id !== id) throw new Error("A identidade do caso não foi confirmada.");
        if (active) setLoaded({ revision, data: payload });
      }).catch((error: unknown) => { if (active) setLoaded({ revision, error: error instanceof Error ? error.message : "Consulta indisponível." }); });
    return () => { active = false; controller.abort(); };
  }, [id, revision]);
  const effectiveAction = item?.status === "closed" ? "reopen" : action;
  const manage = !!data?.available && !!data.canWrite && !!item && data.currentActorId === actorId;
  const locked = mutation.busy || !!mutation.attempt || !manage;
  const anotherOwner = !!item?.ownerId && item.ownerId !== actorId;
  const needsValue = ["schedule", "note", "link_invoice", "link_promise", "link_attendance", "close"].includes(effectiveAction);
  function save() {
    if (!item || locked) return;
    const base = { caseId: id, version: item.version };
    let draft: DraftMutation;
    switch (effectiveAction) {
      case "claim": draft = { ...base, action: "claim", takeOver }; break;
      case "schedule": draft = { ...base, action: "schedule", nextActionOn: value }; break;
      case "link_invoice": draft = { ...base, action: "link_invoice", invoiceId: value.trim() }; break;
      case "link_promise": draft = { ...base, action: "link_promise", promiseId: value.trim() }; break;
      case "link_attendance": draft = { ...base, action: "link_attendance", protocol: value.trim() }; break;
      case "close": draft = { ...base, action: "close", reason: value.trim() }; break;
      case "reopen": draft = { ...base, action: "reopen" }; break;
      default: draft = { ...base, action: "note", text: value.trim() };
    }
    void mutation.submit(draft);
  }
  return <Modal open wide title={item ? `Acompanhamento · cliente ${item.customerId}` : "Acompanhamento"} onClose={onClose} footer={<button type="button" className="button secondary" onClick={onClose}>Fechar acompanhamento</button>}>
    <Notice>Salvar altera somente o caso no HUB. Não envia mensagem, não renegocia e não atesta dinheiro recebido ou cancelamento evitado.</Notice>
    <MutationFeedback state={mutation} canRetry={manage && !loading} onReload={reload} />
    {loading && <Loading rows={4} label="Consultando caso e histórico" />}
    {!loading && loaded?.error && <ErrorState onRetry={reload}>{loaded.error}</ErrorState>}
    {data && (!data.available || !item) && <Notice tone="warn">{data.detail ?? "Caso indisponível nesta instalação."}</Notice>}
    {item && <>
      <Card title={REASONS[item.reason]} badge={<Badge>{STATUS[item.status]}</Badge>}>
        <dl className="facts"><div><dt>Responsável</dt><dd>{ownerLabel(item)}</dd></div><div><dt>Próximo retorno</dt><dd>{calendarDate(item.nextActionOn)}</dd></div><div><dt>Versão consultada</dt><dd>{item.version}</dd></div><div className="stacked"><dt>Faturas vinculadas</dt><dd>{item.invoiceIds.length ? item.invoiceIds.join(", ") : "Nenhuma"}</dd></div><div className="stacked"><dt>Promessas vinculadas</dt><dd>{item.promiseIds.length ? item.promiseIds.join(", ") : "Nenhuma"}</dd></div></dl>
        {item.closingReason && <p className="hint">Motivo do encerramento relatado pelo operador: {item.closingReason}</p>}
        {item.attendance ? <div className="stack"><p className="hint">Protocolo do Atendimento confirmado: {item.attendance.protocol ?? "não informado"}. O vínculo não transfere a conversa nem muda seu responsável.</p>{onNavigate && <button type="button" className="button secondary small" onClick={() => { onClose(); onNavigate("atendimento", { conversation: `${item.attendance!.channel}:${item.attendance!.conversationId}` }); }}>Abrir atendimento vinculado</button>}</div> : <p className="hint">Sem atendimento vinculado e confirmado.</p>}
      </Card>
      {manage ? <Card title="Registrar próximo passo">
        {item.status !== "closed" && <label className="field"><span>Ação no caso</span><select aria-label="Ação no caso" value={action} disabled={locked} onChange={event => { setAction(event.target.value); setValue(""); setTakeOver(false); }}><option value="note">Registrar relato manual</option><option value="claim">Assumir responsabilidade</option><option value="schedule">Definir próximo retorno</option><option value="link_invoice">Vincular fatura</option><option value="link_promise">Vincular promessa existente</option><option value="link_attendance">Vincular atendimento existente</option><option value="close">Encerrar acompanhamento</option></select></label>}
        {effectiveAction === "reopen" && <p>Reabrir este caso não cria dívida e será recusado se outro caso já estiver aberto para o cliente.</p>}
        {effectiveAction === "claim" && <><p>A responsabilidade será registrada em seu usuário autenticado.</p>{anotherOwner && <label className="small"><input type="checkbox" checked={takeOver} disabled={locked} onChange={event => setTakeOver(event.target.checked)} /> Confirmo assumir o caso que está com {item.ownerName ?? "outro operador"}.</label>}</>}
        {needsValue && <label className="field"><span>{effectiveAction === "schedule" ? "Próximo retorno (data de calendário)" : effectiveAction === "link_invoice" ? "Código da fatura IXC" : effectiveAction === "link_promise" ? "ID da promessa no HUB" : effectiveAction === "link_attendance" ? "Protocolo do Atendimento" : effectiveAction === "close" ? "Motivo relatado para encerrar" : "Relato do operador"}</span>{effectiveAction === "note" || effectiveAction === "close" ? <textarea aria-label="Conteúdo da alteração" maxLength={1000} rows={3} value={value} disabled={locked} onChange={event => setValue(event.target.value)} /> : <input aria-label="Conteúdo da alteração" type={effectiveAction === "schedule" ? "date" : "text"} inputMode={effectiveAction === "link_attendance" ? "numeric" : undefined} value={value} disabled={locked} onChange={event => setValue(event.target.value)} />}</label>}
        <p className="hint">{effectiveAction === "link_attendance" ? "Copie o protocolo visível no painel do Atendimento. O servidor confirma o mesmo cliente; não use telefone nem ID interno. Vincular não envia mensagem nem transfere a conversa." : effectiveAction.startsWith("link_") ? "O servidor valida o vínculo com o mesmo cliente. Vincular não cria promessa, recibo nem atendimento." : "Relato manual não comprova contato enviado, entregue, pagamento ou retenção. Encerrar o caso é uma decisão operacional, não baixa financeira."}</p>
        <button type="button" className="button" disabled={locked || (needsValue && !value.trim()) || (effectiveAction === "link_attendance" && !/^\d{14,18}$/.test(value.trim())) || (effectiveAction === "claim" && anotherOwner && !takeOver)} onClick={save}>{mutation.busy ? "Salvando…" : effectiveAction === "reopen" ? "Reabrir caso no HUB" : "Salvar registro no HUB"}</button>
      </Card> : <Notice>Consulta somente leitura. Alterações exigem permissão de cobrança e a mesma sessão que abriu esta consulta.</Notice>}
      <Card title="Histórico auditável" badge={<Badge>Horários de Brasília</Badge>}>
        {!data.events.length ? <p className="hint">Nenhum evento disponível nesta consulta.</p> : <div className="list">{data.events.map(event => <div className="row" key={event.id}><div className="row-main"><strong>{EVENTS[event.type] ?? "Evento registrado"}</strong><span>{observedTime(event.createdAt)} · {event.actorId === actorId ? "Seu usuário" : `Operador ${event.actorId}`}</span><EventEvidence event={event} /></div></div>)}</div>}
        {data.historyTruncated && <Notice tone="warn">Mostrando somente os eventos mais recentes. Este recorte não representa todo o histórico.</Notice>}
      </Card>
    </>}
  </Modal>;
}

function EventEvidence({ event }: { event: RecoveryCaseEvent }) {
  const evidence = event.evidence;
  return <div className="small break">
    {typeof evidence.text === "string" && <p>{evidence.text}</p>}
    {typeof evidence.reason === "string" && <p>Motivo registrado: {event.type === "opened" ? REASONS[evidence.reason as RecoveryCaseReason] ?? evidence.reason : evidence.reason}</p>}
    {typeof evidence.nextActionOn === "string" && <p>Retorno: {calendarDate(evidence.nextActionOn)}</p>}
    {typeof evidence.invoiceId === "string" && <p>Fatura {evidence.invoiceId}</p>}
    {typeof evidence.promiseId === "string" && <p>Promessa {evidence.promiseId}</p>}
    {typeof evidence.protocol === "string" && <p>Protocolo do Atendimento {evidence.protocol}</p>}
    <p className="hint">{event.type === "note" || event.type === "closed" ? "Relato do operador; não é comprovante de envio, entrega, pagamento ou retenção." : "Registro de acompanhamento. Vínculo confirmado não comprova resultado financeiro ou contato realizado."}</p>
  </div>;
}
