"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Chat interno da equipe (issue #10).
 *
 * "Tempo quase real" aqui é consulta periódica, não websocket: o runtime da
 * aplicação não mantém conexão persistente, e fingir tempo real com uma
 * tecnologia que não temos daria uma tela que trava sem explicação. 8 segundos
 * é o intervalo — rápido o bastante para uma conversa de trabalho, barato o
 * bastante para deixar aberto o dia todo.
 */
const POLL_MS = 8000;

type Person = { id: string; name: string; role: string };
type Thread = { id: string; subject: string; linkedConversationId: string | null; lastMessageAt: string; participants: Array<{ userId: string; name: string; role: string }>; unread: number };
type Message = { id: string; authorId: string; authorName: string; body: string; createdAt: string };
type ListPayload = { available: boolean; detail?: string; threads: Thread[]; people: Person[]; me?: string };

const timeLabel = (iso: string) => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export function InternalChatModule() {
  const [data, setData] = useState<ListPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ subject: "", participantIds: [] as string[], linkedConversationId: "" });
  const endRef = useRef<HTMLDivElement>(null);

  // `nonce` é o gatilho de recarga, mesmo padrão de useIncidents em support.tsx:
  // manter o efeito como única origem do fetch evita atualizar estado de forma
  // síncrona dentro dele.
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    fetch("/api/internal-chat")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: ListPayload) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [nonce]);

  useEffect(() => {
    // Sem conversa aberta não há o que buscar. Limpar `messages` aqui seria
    // setState síncrono dentro do efeito; a tela já não as renderiza quando
    // nenhuma conversa está aberta, e trocar de conversa substitui a lista.
    if (!openId) return;
    let active = true;
    fetch(`/api/internal-chat?threadId=${encodeURIComponent(openId)}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("sem acesso")))
      .then((payload: { messages: Message[] }) => { if (active) setMessages(payload.messages); })
      // Não mexe em `openId` aqui: ele é dependência deste efeito, e alterá-lo
      // de dentro dele criaria o ciclo de renderização. A conversa fica aberta
      // e vazia, com o erro visível — quem lê escolhe outra.
      .catch(() => { if (active) { setMessages([]); setError("Conversa não encontrada ou sem acesso."); } });
    return () => { active = false; };
  }, [openId, nonce]);

  // Consulta periódica: o runtime não mantém conexão persistente, então recarregar
  // é o que existe. O relógio só dispara o `nonce`; quem busca é o efeito acima.
  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages]);

  async function send() {
    if (!openId || !draft.trim()) return;
    setBusy(true); setError(null);
    const response = await fetch("/api/internal-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "message", threadId: openId, body: draft }) });
    if (response.ok) { setDraft(""); reload(); }
    else setError((await response.json().catch(() => ({}))).error ?? "Não foi possível enviar.");
    setBusy(false);
  }

  async function create() {
    setBusy(true); setError(null);
    const response = await fetch("/api/internal-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", ...form }) });
    const payload = await response.json();
    if (response.ok) { setCreating(false); setForm({ subject: "", participantIds: [], linkedConversationId: "" }); setOpenId(payload.id); reload(); }
    else setError(payload.error ?? "Não foi possível abrir a conversa.");
    setBusy(false);
  }

  const open = data?.threads.find((thread) => thread.id === openId) ?? null;
  const others = (thread: Thread) => thread.participants.filter((p) => p.userId !== data?.me);

  return <main className="content">
    <div className="page-heading"><div><h1>Chat da equipe</h1><p>Conversa interna entre quem trabalha aqui. O cliente nunca vê nada disto.</p></div>
      {state === "ready" && data?.available && <button className="button" onClick={() => { setCreating(true); setError(null); }}>Nova conversa</button>}
    </div>

    {state === "loading" && <div className="state-card">Carregando conversas…</div>}
    {state === "error" && <div className="state-card error">Não foi possível carregar o chat.</div>}
    {state === "ready" && data && !data.available && <div className="state-card error">{data.detail}.</div>}

    {creating && data && <section className="data-card" style={{ marginBottom: 14 }}>
      <div className="card-header"><strong>Nova conversa</strong><span className="badge blue">Só quem você escolher participa</span></div>
      <div style={{ padding: 16, display: "grid", gap: 10, maxWidth: 520 }}>
        <label className="field"><span>Assunto</span><input value={form.subject} placeholder="ex.: Cliente 21857 com queda recorrente" onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} /></label>
        <label className="field"><span>Atendimento relacionado (opcional)</span><input value={form.linkedConversationId} placeholder="ex.: 5579998307232" onChange={(e) => setForm((f) => ({ ...f, linkedConversationId: e.target.value }))} /></label>
        <fieldset className="reason-picker">
          <legend>Quem participa</legend>
          {data.people.filter((person) => person.id !== data.me).map((person) => <label key={person.id}>
            <input type="checkbox" checked={form.participantIds.includes(person.id)} onChange={() => setForm((f) => ({ ...f, participantIds: f.participantIds.includes(person.id) ? f.participantIds.filter((id) => id !== person.id) : [...f.participantIds, person.id] }))} />
            <span>{person.name} — {person.role}</span>
          </label>)}
        </fieldset>
        {error && <p className="form-error">{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button" disabled={busy} onClick={() => void create()}>{busy ? "Abrindo…" : "Abrir conversa"}</button>
          <button className="button secondary" disabled={busy} onClick={() => { setCreating(false); setError(null); }}>Cancelar</button>
        </div>
      </div>
    </section>}

    {state === "ready" && data?.available && <div className="conversation-layout" style={{ gridTemplateColumns: "300px minmax(420px, 1fr)" }}>
      <section className="conversation-list">
        {data.threads.length === 0
          ? <p style={{ padding: 16, fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>Nenhuma conversa ainda. Abra uma para tirar dúvida com um colega sem sair do sistema.</p>
          : data.threads.map((thread) => <button className={`contact ${thread.id === openId ? "active" : ""}`} key={thread.id} onClick={() => setOpenId(thread.id)} style={{ width: "100%", textAlign: "left", border: 0, background: "none", cursor: "pointer" }}>
              <div className="avatar">{thread.subject.slice(0, 2).toUpperCase()}</div>
              <div>
                <p>{thread.subject}</p>
                <span>{others(thread).map((p) => p.name).join(", ") || "só você"}</span>
              </div>
              {thread.unread > 0 ? <span className="badge amber">{thread.unread}</span> : <time>{timeLabel(thread.lastMessageAt)}</time>}
            </button>)}
      </section>

      <section className="conversation-main">
        {!open
          ? <p style={{ padding: 20, fontSize: 12, color: "var(--muted)" }}>Escolha uma conversa à esquerda.</p>
          : <>
              <div className="chat-header"><div className="person">
                <div className="avatar">{open.subject.slice(0, 2).toUpperCase()}</div>
                <div><strong>{open.subject}</strong><span>{others(open).map((p) => `${p.name} (${p.role})`).join(", ")}</span></div></div>
                {open.linkedConversationId && <span className="badge blue">Atendimento {open.linkedConversationId}</span>}
              </div>
              <div className="messages">
                {messages.length === 0
                  ? <p style={{ fontSize: 12, color: "var(--muted)", padding: 12 }}>Nenhuma mensagem ainda.</p>
                  : messages.map((message) => <div className={`message ${message.authorId === data.me ? "agent" : "customer"}`} key={message.id}>
                      {message.authorId !== data.me && <strong style={{ display: "block", fontSize: 11, marginBottom: 3 }}>{message.authorName}</strong>}
                      {message.body}
                      <time>{timeLabel(message.createdAt)}</time>
                    </div>)}
                <div ref={endRef} />
              </div>
              {error && <p className="form-error" style={{ padding: "0 16px" }}>{error}</p>}
              <div className="composer">
                <textarea value={draft} placeholder="Escreva para a equipe…" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                <button disabled={busy || !draft.trim()} onClick={() => void send()} title="Enviar" aria-label="Enviar mensagem">➤</button>
              </div>
            </>}
      </section>
    </div>}
  </main>;
}
