"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { Avatar, Badge, Empty, Loading, Modal, Notice } from "@/components/ui/kit";

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
  const [pane, setPane] = useState<"list" | "chat">("list");
  const [form, setForm] = useState({ subject: "", participantIds: [] as string[], linkedConversationId: "" });
  const endRef = useRef<HTMLDivElement>(null);

  // `nonce` é o gatilho de recarga: manter o efeito como única origem do fetch
  // evita atualizar estado de forma síncrona dentro dele.
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
    // Sem conversa aberta não há o que buscar; a tela já não renderiza mensagens.
    if (!openId) return;
    let active = true;
    fetch(`/api/internal-chat?threadId=${encodeURIComponent(openId)}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("sem acesso")))
      .then((payload: { messages: Message[] }) => { if (active) setMessages(payload.messages); })
      // Não mexe em `openId` aqui: ele é dependência deste efeito, e alterá-lo
      // de dentro dele criaria o ciclo de renderização.
      .catch(() => { if (active) { setMessages([]); setError("Conversa não encontrada ou sem acesso."); } });
    return () => { active = false; };
  }, [openId, nonce]);

  // O relógio só dispara o `nonce`; quem busca é o efeito acima.
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
    if (response.ok) { setCreating(false); setForm({ subject: "", participantIds: [], linkedConversationId: "" }); setOpenId(payload.id); setPane("chat"); reload(); }
    else setError(payload.error ?? "Não foi possível abrir a conversa.");
    setBusy(false);
  }

  if (state === "loading") return <div className="inbox-state"><Loading rows={5} /></div>;
  if (state === "error") return <div className="inbox-state"><Notice tone="bad">Não foi possível carregar o chat.</Notice></div>;
  if (!data?.available) return <div className="inbox-state"><Notice tone="bad">{data?.detail}.</Notice></div>;

  const open = data.threads.find((thread) => thread.id === openId) ?? null;
  const others = (thread: Thread) => thread.participants.filter((p) => p.userId !== data.me);

  return <div className={`team-chat pane-${pane}`}>
    <aside className="inbox-list" aria-label="Conversas internas">
      <div className="inbox-list-head">
        <div className="inbox-title"><h1>Chat da equipe</h1></div>
        <button className="button" onClick={() => { setCreating(true); setError(null); }}><Icon name="plus" size={16} />Nova conversa</button>
      </div>
      <div className="inbox-items">
        {data.threads.length === 0
          ? <p className="inbox-empty">Nenhuma conversa ainda. Abra uma para tirar dúvida com um colega sem sair do sistema. O cliente nunca vê nada daqui.</p>
          : data.threads.map((thread) => <button type="button" className={`inbox-item ${thread.id === openId ? "active" : ""}`} key={thread.id} onClick={() => { setOpenId(thread.id); setPane("chat"); setError(null); }}>
              <Avatar name={thread.subject} />
              <span className="inbox-item-text">
                <span className="inbox-item-top"><strong>{thread.subject}</strong>{thread.unread > 0 ? <Badge tone="bad">{thread.unread}</Badge> : <time>{timeLabel(thread.lastMessageAt)}</time>}</span>
                <span className="inbox-item-preview">{others(thread).map((p) => p.name).join(", ") || "só você"}</span>
              </span>
            </button>)}
      </div>
    </aside>

    <section className="inbox-chat" aria-label="Conversa">
      {!open
        ? <Empty icon="team" title="Escolha uma conversa">ou abra uma nova para falar com a equipe.</Empty>
        : <>
            <header className="chat-head">
              <button type="button" className="icon-button chat-back" onClick={() => setPane("list")} aria-label="Voltar para a lista"><Icon name="arrow-left" /></button>
              <Avatar name={open.subject} />
              <div className="chat-who"><strong>{open.subject}</strong><span>{others(open).map((p) => `${p.name} (${p.role})`).join(", ") || "só você"}</span></div>
              {open.linkedConversationId && <div className="chat-badges"><Badge tone="info">Atendimento {open.linkedConversationId}</Badge></div>}
            </header>
            <div className="messages">
              {messages.length === 0
                ? <p className="messages-note">Nenhuma mensagem ainda.</p>
                : messages.map((message) => <div className={`bubble ${message.authorId === data.me ? "agent" : "customer"}`} key={message.id}>
                    {message.authorId !== data.me && <span className="bubble-author">{message.authorName}</span>}
                    <div className="bubble-text">{message.body}</div>
                    <footer><time>{timeLabel(message.createdAt)}</time></footer>
                  </div>)}
              <div ref={endRef} />
            </div>
            {error && <p className="form-error composer-error">{error}</p>}
            <div className="composer">
              <textarea value={draft} rows={1} placeholder="Escreva para a equipe… (Enter envia)" aria-label="Mensagem para a equipe" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              <div className="composer-bar"><span className="composer-count" /><button type="button" className="button send" disabled={busy || !draft.trim()} onClick={() => void send()}>Enviar<Icon name="send" size={15} /></button></div>
            </div>
          </>}
    </section>

    <Modal open={creating} title="Nova conversa" onClose={() => { setCreating(false); setError(null); }}
      footer={<><button className="button secondary" disabled={busy} onClick={() => { setCreating(false); setError(null); }}>Cancelar</button><button className="button" disabled={busy || !form.subject.trim()} onClick={() => void create()}>{busy ? "Abrindo…" : "Abrir conversa"}</button></>}>
      <div className="stack">
        <label className="field"><span>Assunto</span><input data-autofocus value={form.subject} placeholder="ex.: Cliente 21857 com queda recorrente" onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} /></label>
        <label className="field"><span>Atendimento relacionado (opcional)</span><input value={form.linkedConversationId} placeholder="número do WhatsApp do cliente" onChange={(e) => setForm((f) => ({ ...f, linkedConversationId: e.target.value }))} /></label>
        <fieldset className="checks">
          <legend>Quem participa</legend>
          {data.people.filter((person) => person.id !== data.me).map((person) => <label key={person.id}>
            <input type="checkbox" checked={form.participantIds.includes(person.id)} onChange={() => setForm((f) => ({ ...f, participantIds: f.participantIds.includes(person.id) ? f.participantIds.filter((id) => id !== person.id) : [...f.participantIds, person.id] }))} />
            <span>{person.name} <small className="muted">· {person.role}</small></span>
          </label>)}
        </fieldset>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  </div>;
}
