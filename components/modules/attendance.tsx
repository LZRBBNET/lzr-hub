"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { containsHomologationText } from "@/lib/platform/reply-templates-shared";
import { Icon } from "@/components/ui/icons";
import { Avatar, Badge, Empty, InfoTip, Loading, Notice, Segmented, relativeTime } from "@/components/ui/kit";
import { conversationLabel, handoffLabel, intentLabel } from "@/components/modules/labels";

type ConversationSummary = { channel:string; externalConversationId:string; lastMessage:string; lastRole:"customer"|"agent"|"suggestion"; lastAt:string; messages:number; finalStatus?:string; intent?:string; handoff?:boolean; displayName?:string; awaitingSince?:string; lastSentBy?:string };
type ConversationMessage = { role:"customer"|"agent"|"suggestion"; content:string; createdAt:string; sentBy?:string; deliveryStatus?:string; deliveryError?:string };
type ChannelState = { enabled:boolean; autoReply:boolean; canReply:boolean };
type ReplyWindow = { lastCustomerAt:string|null; closesAt:string|null; open:boolean };
type IxcCustomer = { id:string; name:string; status:string; city:string; neighborhood:string };
type IxcMatch = { state:"loading" } | { state:"found"; customer:IxcCustomer } | { state:"none" } | { state:"unavailable"; detail:string };
type QuickReply = { intent:string; label:string; content:string };
type ConversationAudit = { intent:string|null; finalStatus:string|null; handoff:boolean|null; handoffReason:string|null; intentSource:string|null; intentConfidence:number|null; intentModel:string|null; appVersion:string|null; correlationId:string|null; createdAt:string|null };
type CopilotSource = { id:string; title:string; category:string; version:number; excerpt:string; score:number };
type CopilotResult = { kind:"answer"|"summary"; written:"llm"|"excerpt"|"none"; text:string; caveat:string|null; sources:CopilotSource[]; basedOn?:string };

/**
 * Atendimentos: o que de fato entrou pelos canais, e a resposta do atendente.
 *
 * A tela se atualiza sozinha a cada poucos segundos. Antes ela só carregava ao
 * abrir, e mensagem nova de cliente exigia recarregar a página para aparecer —
 * quem atende não pode depender de lembrar de apertar F5.
 *
 * Nada de conversa de exemplo: sem histórico gravado, a tela diz isso.
 */
const POLL_MS = 5000;
/** Com a aba escondida, a lista é consultada a cada 6 voltas (30 s). */
const HIDDEN_POLL_EVERY = 6;
const FINAL_STATUS_LABELS: Record<string,string> = {
  suggested:"Sugestão registrada", handoff:"Transbordo", resolved:"Resolvido", waiting_customer:"Aguardando cliente",
  blocked:"Bloqueado", failed:"Falhou", simulated:"Simulado", rated:"Avaliado", unsupported:"Mídia recebida",
};
const DELIVERY_LABELS: Record<string,string> = { sent:"Enviada", delivered:"Entregue", read:"Lida", failed:"Falhou" };
const conversationKey = (item:{ channel:string; externalConversationId:string }) => `${item.channel}:${item.externalConversationId}`;
const conversationTitle = (item:ConversationSummary) => item.displayName ?? conversationLabel(item.externalConversationId);
function lastMessagePrefix(item:ConversationSummary) {
  if (item.lastRole==="suggestion") return "Sugestão: ";
  // Resposta sem autor registrado não é atribuída a ninguém — nem à IA.
  if (item.lastRole==="agent") return item.lastSentBy ? "Você: " : "Resposta: ";
  return "";
}
const messagesSignature = (messages:ConversationMessage[]) => messages.map((message) => `${message.createdAt}|${message.role}|${message.deliveryStatus ?? ""}`).join(";");
function dayLabel(iso:string, now:number) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const day = (value:Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  if (day(date)===day(new Date(now))) return "Hoje";
  if (day(date)===day(new Date(now - 86_400_000))) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day:"2-digit", month:"2-digit", year:"numeric" });
}
/** A janela de 24 horas da Meta, dita antes de o atendente escrever — não depois de uma recusa. */
function windowInfo(replyWindow:ReplyWindow|null, now:number): { tone:"neutral"|"ok"|"warn"|"bad"; text:string } | null {
  if (!replyWindow) return null;
  if (!replyWindow.lastCustomerAt || !replyWindow.closesAt) return { tone:"neutral", text:"Sem mensagem do cliente" };
  const remaining = Date.parse(replyWindow.closesAt) - now;
  if (remaining <= 0) return { tone:"bad", text:"Janela de 24 h fechada" };
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 1) return { tone: hours < 2 ? "warn" : "ok", text:`Janela aberta · ${hours} h` };
  return { tone:"warn", text:`Janela fecha em ${Math.max(1, Math.ceil(remaining / 60_000))} min` };
}
/** Áudio, foto e documento chegam como aviso entre colchetes, gravado pelo canal. */
const isMediaNote = (message:ConversationMessage) => message.role==="customer" && /^\[[^\]]*recebid[oa] — /.test(message.content);
const wideScreen = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1440px)").matches;

export function AttendanceModule({ initialConversation, onAwaiting }: { initialConversation?: string; onAwaiting?: (count:number) => void }) {
  const [items,setItems] = useState<ConversationSummary[]>([]);
  const [channelState,setChannelState] = useState<ChannelState>({enabled:false,autoReply:false,canReply:false});
  const [available,setAvailable] = useState(true);
  const [state,setState] = useState<"loading"|"ready"|"error">("loading");
  const [syncedAt,setSyncedAt] = useState<number|null>(null);
  const [syncFailed,setSyncFailed] = useState(false);
  const [filter,setFilter] = useState<"todas"|"aguardando">("todas");
  const [query,setQuery] = useState("");
  const [selected,setSelected] = useState<ConversationSummary|null>(null);
  const [messages,setMessages] = useState<ConversationMessage[]>([]);
  const [messagesState,setMessagesState] = useState<"idle"|"loading"|"ready"|"error">("idle");
  const [audit,setAudit] = useState<ConversationAudit|null>(null);
  const [replyWindow,setReplyWindow] = useState<ReplyWindow|null>(null);
  const [ixc,setIxc] = useState<IxcMatch|null>(null);
  const [quickReplies,setQuickReplies] = useState<QuickReply[]>([]);
  const [draft,setDraft] = useState("");
  const [sending,setSending] = useState(false);
  const [sendError,setSendError] = useState<string|null>(null);
  const [newBelow,setNewBelow] = useState(false);
  const [now,setNow] = useState(() => Date.now());
  const [pane,setPane] = useState<"list"|"chat">("list");
  const [details,setDetails] = useState(wideScreen);
  const [detailTab,setDetailTab] = useState<"cliente"|"copiloto"|"auditoria">("cliente");
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Refs porque o temporizador enxerga só a primeira renderização: sem elas ele
  // atualizaria sempre a conversa que estava aberta quando a tela montou.
  const selectedRef = useRef<ConversationSummary|null>(null);
  const queryRef = useRef("");
  const signatureRef = useRef("");
  const countRef = useRef(0);
  const stickRef = useRef(true);
  const listBusy = useRef(false);
  const messagesBusy = useRef(false);
  const initialRef = useRef(initialConversation);

  const isOpen = (key:string) => selectedRef.current !== null && conversationKey(selectedRef.current)===key;

  async function loadList(mode:"first"|"poll"|"force") {
    // Atualização que se sobrepõe à anterior só empilharia requisições.
    if (mode==="poll" && listBusy.current) return;
    listBusy.current = true;
    const q = queryRef.current.trim();
    try {
      const response = await fetch(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      if (!response.ok) throw new Error("falhou");
      const payload = await response.json() as { available:boolean; items:ConversationSummary[]; channelState:ChannelState };
      // A busca mudou enquanto esta resposta vinha: ela já não vale.
      if (q!==queryRef.current.trim()) return;
      const list = payload.items ?? [];
      setAvailable(payload.available); setItems(list);
      setChannelState(payload.channelState ?? {enabled:false,autoReply:false,canReply:false});
      setState("ready"); setSyncedAt(Date.now()); setSyncFailed(false);
      const current = selectedRef.current;
      const fresh = current ? list.find((item) => conversationKey(item)===conversationKey(current)) : undefined;
      if (fresh) { selectedRef.current = fresh; setSelected(fresh); }
      else if (mode==="first" && !current && list.length) {
        // Veio de um clique em outra tela ("Últimas conversas"): abre aquela, não a primeira da lista.
        const wanted = initialRef.current ? list.find((item) => conversationKey(item)===initialRef.current) : undefined;
        open(wanted ?? list[0]);
        if (wanted) setPane("chat");
      }
    } catch {
      // Falha de atualização não apaga o que já está na tela: avisa e tenta de novo.
      if (mode==="first") setState("error"); else setSyncFailed(true);
    } finally { listBusy.current = false; }
  }

  async function loadMessages(item:ConversationSummary, mode:"open"|"poll"|"force") {
    const key = conversationKey(item);
    if (mode==="poll" && messagesBusy.current) return;
    messagesBusy.current = true;
    try {
      const response = await fetch(`/api/conversations?channel=${encodeURIComponent(item.channel)}&id=${encodeURIComponent(item.externalConversationId)}`);
      if (!isOpen(key)) return;
      if (!response.ok) throw new Error("falhou");
      const payload = await response.json() as { messages:ConversationMessage[]; audit:ConversationAudit|null; replyWindow?:ReplyWindow };
      // Trocou de conversa enquanto esperava: esta resposta é de outro cliente.
      if (!isOpen(key)) return;
      const next = payload.messages ?? [];
      const signature = messagesSignature(next);
      if (mode!=="poll" || signature!==signatureRef.current) {
        const el = messagesRef.current;
        const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        // Quem está lendo o histórico lá em cima não é puxado para baixo: ganha um aviso.
        stickRef.current = mode!=="poll" || nearBottom;
        if (mode==="poll" && next.length > countRef.current && !nearBottom) setNewBelow(true);
        signatureRef.current = signature; countRef.current = next.length;
        setMessages(next);
      }
      setAudit(payload.audit ?? null); setReplyWindow(payload.replyWindow ?? null); setMessagesState("ready");
    } catch {
      if (mode==="open" && isOpen(key)) setMessagesState("error");
    } finally { messagesBusy.current = false; }
  }

  async function lookupIxc(item:ConversationSummary) {
    const key = conversationKey(item);
    if (!/^\d{10,15}$/.test(item.externalConversationId)) { setIxc({ state:"unavailable", detail:"Esta conversa não é de um número de telefone." }); return; }
    setIxc({ state:"loading" });
    try {
      const response = await fetch(`/api/conversations/customer?id=${encodeURIComponent(item.externalConversationId)}`);
      const payload = await response.json().catch(() => ({})) as { available?:boolean; detail?:string; error?:string; customer?:IxcCustomer|null };
      if (!isOpen(key)) return;
      if (!response.ok || !payload.available) { setIxc({ state:"unavailable", detail:payload.detail ?? payload.error ?? "O IXC não respondeu agora." }); return; }
      setIxc(payload.customer ? { state:"found", customer:payload.customer } : { state:"none" });
    } catch {
      if (isOpen(key)) setIxc({ state:"unavailable", detail:"O IXC não respondeu agora." });
    }
  }

  function open(item:ConversationSummary) {
    const same = isOpen(conversationKey(item));
    selectedRef.current = item; setSelected(item);
    if (same) return;
    signatureRef.current = ""; countRef.current = 0; stickRef.current = true;
    setMessages([]); setMessagesState("loading"); setAudit(null); setReplyWindow(null); setNewBelow(false);
    // O rascunho é da conversa em que foi escrito: trocar de cliente não o carrega junto.
    setDraft(""); setSendError(null);
    void loadMessages(item, "open");
    // O IXC tem limite de consultas por minuto: uma vez ao abrir, nunca a cada atualização.
    void lookupIxc(item);
  }

  async function send() {
    const item = selectedRef.current;
    if (!item || sending || !draft.trim()) return;
    setSending(true); setSendError(null);
    try {
      // Uma chave por clique: o duplo clique devolve o mesmo resultado em vez de mandar duas mensagens.
      const response = await fetch("/api/conversations/reply", { method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({ conversationId:item.externalConversationId, text:draft, idempotencyKey:crypto.randomUUID() }) });
      const payload = await response.json().catch(() => ({})) as { error?:string; recorded?:boolean };
      if (!response.ok) { setSendError(payload.error ?? "Não consegui enviar. Nada foi enviado."); return; }
      setDraft("");
      if (payload.recorded===false) setSendError("A mensagem foi enviada ao cliente, mas não consegui gravá-la no histórico. Não reenvie.");
      await loadMessages(item, "force");
      void loadList("force");
    } catch { setSendError("Não consegui falar com o servidor. Confira a conversa antes de reenviar."); }
    finally { setSending(false); }
  }

  function insertReply(content:string) {
    setDraft((current) => current.trim() ? `${current.trimEnd()}\n${content}` : content);
    setSendError(null);
    composerRef.current?.focus();
  }

  useEffect(() => {
    void loadList("first");
    fetch("/api/agent/replies").then((response) => response.ok ? response.json() : null)
      .then((payload:{ items?:QuickReply[] }|null) => { if (payload?.items) setQuickReplies(payload.items.map(({ intent, label, content }) => ({ intent, label, content }))); })
      .catch(() => undefined);
    const refresh = () => {
      setNow(Date.now());
      void loadList("poll");
      if (selectedRef.current) void loadMessages(selectedRef.current, "poll");
    };
    let ticks = 0;
    const tick = () => {
      ticks += 1;
      if (document.visibilityState==="visible") { refresh(); return; }
      // Aba escondida continua olhando a lista, mais devagar: é o que mantém o
      // "(3)" do título avisando de cliente esperando enquanto o atendente está
      // em outra aba. A conversa aberta não — ninguém a está lendo.
      if (ticks % HIDDEN_POLL_EVERY===0) { setNow(Date.now()); void loadList("poll"); }
    };
    const onVisibility = () => { if (document.visibilityState==="visible") refresh(); };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
    // Monta uma vez só: as funções leem o que muda pelas refs, e recriar o
    // temporizador a cada renderização zeraria a contagem dos 5 segundos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Espera curta: sem ela cada letra digitada viraria uma consulta.
    if (query.trim()===queryRef.current.trim()) return;
    const timer = window.setTimeout(() => { queryRef.current = query; void loadList("force"); }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loadList` lê a busca pela ref
  }, [query]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const awaitingCount = items.filter((item) => item.awaitingSince).length;
  useEffect(() => { onAwaiting?.(awaitingCount); }, [awaitingCount, onAwaiting]);

  if (state==="loading") return <div className="inbox-state"><Loading rows={6} label="Carregando conversas" /></div>;
  if (state==="error") return <div className="inbox-state"><Notice tone="bad">Não foi possível carregar as conversas.</Notice></div>;
  if (!available) return <div className="inbox-state"><Notice tone="bad">Histórico de conversas indisponível. Nenhuma conversa de exemplo é exibida no lugar.</Notice></div>;
  if (items.length===0 && !query.trim() && !selected) return <div className="inbox-state"><Empty icon="chat" title="Nenhuma conversa registrada">As conversas aparecem aqui assim que o canal do WhatsApp receber mensagens — esta tela se atualiza sozinha. Nada fictício é mostrado enquanto isso.</Empty></div>;

  const visible = filter==="aguardando"
    // Na fila, quem espera há mais tempo vem primeiro.
    ? items.filter((item) => item.awaitingSince).sort((a,b) => (a.awaitingSince ?? "").localeCompare(b.awaitingSince ?? ""))
    : items;
  const windowState = windowInfo(replyWindow, now);
  const windowOpen = !!replyWindow?.closesAt && now <= Date.parse(replyWindow.closesAt);
  const canCompose = channelState.canReply && messagesState==="ready" && windowOpen;
  const composerHint = !channelState.canReply ? "Responder pela tela está desligado. Nenhuma resposta é enviada ao cliente por aqui."
    : messagesState!=="ready" ? "Carregando a conversa…"
    : !replyWindow?.lastCustomerAt ? "Não há mensagem deste cliente para responder."
    : !windowOpen ? "Mais de 24 h desde a última mensagem do cliente: a Meta só aceita texto livre dentro dessa janela. É preciso que o cliente escreva de novo."
    : "Escreva a resposta… (Enter envia, Shift+Enter quebra a linha)";
  const statusLabel = selected?.handoff ? "Transbordo" : selected?.finalStatus ? FINAL_STATUS_LABELS[selected.finalStatus] ?? selected.finalStatus : "Sem desfecho";
  const observing = channelState.enabled && !channelState.autoReply;

  return <div className={`inbox pane-${pane} ${details ? "with-details" : ""}`}>
    <aside className="inbox-list" aria-label="Conversas">
      <div className="inbox-list-head">
        <div className="inbox-title">
          <h1>Atendimentos</h1>
          {observing && <span className="mode-chip">Modo observação<InfoTip label="O que é o modo observação">O canal recebe e registra as mensagens, e a IA propõe a resposta — mas nada é enviado automaticamente. {channelState.canReply ? "Quem responde é o atendente, pelo campo abaixo da conversa." : "O envio pela tela está desligado: ninguém responde ao cliente por aqui."}</InfoTip></span>}
        </div>
        <label className="search-field"><Icon name="search" size={16} /><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar nome ou número" aria-label="Buscar conversa" /></label>
        <Segmented label="Filtrar conversas" value={filter} onChange={setFilter} options={[["todas","Todas"],["aguardando",`Aguardando${awaitingCount ? ` · ${awaitingCount}` : ""}`]]} />
      </div>
      <div className="inbox-items">
        {visible.length===0 && <p className="inbox-empty">{filter==="aguardando" ? "Ninguém aguardando resposta. 🎉" : `Nenhuma conversa para “${query.trim()}”.`}</p>}
        {visible.map((item)=>{
          const active = selected && conversationKey(selected)===conversationKey(item);
          return <button type="button" className={`inbox-item ${active?"active":""} ${item.awaitingSince?"waiting":""}`} key={conversationKey(item)} onClick={()=>{ open(item); setPane("chat"); }}>
            <Avatar name={conversationTitle(item)} label={item.displayName ? undefined : conversationLabel(item.externalConversationId).slice(-2)} />
            <span className="inbox-item-text">
              <span className="inbox-item-top"><strong>{conversationTitle(item)}</strong><time>{relativeTime(item.lastAt, now)}</time></span>
              <span className="inbox-item-preview">{lastMessagePrefix(item)}{item.lastMessage.slice(0,80)}</span>
              {item.awaitingSince && <span className="wait-badge" title="Tempo desde a primeira mensagem do cliente ainda sem resposta"><Icon name="clock" size={12} />aguarda {relativeTime(item.awaitingSince, now)}</span>}
            </span>
          </button>;
        })}
      </div>
      <div className={`inbox-sync ${syncFailed?"stale":""}`}><i />{syncFailed ? "Falha ao atualizar — tentando de novo" : syncedAt ? `Ao vivo · ${new Date(syncedAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}` : ""}</div>
    </aside>

    <section className="inbox-chat" aria-label="Conversa">
      <header className="chat-head">
        <button type="button" className="icon-button chat-back" onClick={()=>setPane("list")} aria-label="Voltar para a lista"><Icon name="arrow-left" /></button>
        {selected && <Avatar name={conversationTitle(selected)} label={selected.displayName ? undefined : conversationLabel(selected.externalConversationId).slice(-2)} />}
        <div className="chat-who"><strong>{selected?conversationTitle(selected):"Nenhuma conversa aberta"}</strong>{selected && <span>{selected.displayName ? `${conversationLabel(selected.externalConversationId)} · ` : ""}{selected.channel}</span>}</div>
        <div className="chat-badges">
          {windowState && <Badge tone={windowState.tone}>{windowState.text}</Badge>}
          {selected && <Badge tone={selected.handoff?"warn":"info"}>{statusLabel}</Badge>}
          <button type="button" className={`icon-button ${details?"pressed":""}`} onClick={()=>setDetails((value)=>!value)} aria-pressed={details} aria-label="Mostrar detalhes do cliente" title="Detalhes do cliente"><Icon name="panel" /></button>
        </div>
      </header>
      <div className="messages-wrap">
        <div className="messages" ref={messagesRef} onScroll={(e)=>{ const el = e.currentTarget; if (newBelow && el.scrollHeight - el.scrollTop - el.clientHeight < 80) setNewBelow(false); }}>
          {messagesState==="loading" && <p className="messages-note">Carregando histórico…</p>}
          {messagesState==="error" && <p className="messages-note">Não consegui carregar esta conversa. Abra de novo em instantes.</p>}
          {messagesState==="ready" && messages.length===0 && <p className="messages-note">Conversa sem mensagens gravadas.</p>}
          {messages.map((message,index)=>{
            const day = dayLabel(message.createdAt, now);
            const newDay = index===0 || dayLabel(messages[index-1].createdAt, now)!==day;
            return <Fragment key={`${message.createdAt}-${index}`}>
              {newDay && <div className="day-separator"><span>{day}</span></div>}
              <div className={`bubble ${message.role} ${isMediaNote(message)?"media":""}`}>
                {message.role==="suggestion" && <span className="bubble-label"><Icon name="bot" size={13} />Sugestão da IA — não enviada ao cliente</span>}
                <div className="bubble-text">{message.content}</div>
                {message.role==="suggestion" && canCompose && (containsHomologationText(message.content)
                  ? <small className="bubble-warn">Texto de homologação — não pode ser enviado a um cliente.</small>
                  : <button type="button" className="button secondary small" onClick={()=>insertReply(message.content)}>Usar como rascunho</button>)}
                {message.deliveryStatus==="failed" && message.deliveryError && <small className="bubble-error">{message.deliveryError}</small>}
                <footer>
                  {message.role==="agent" && message.sentBy && <span>{message.sentBy} · <b className={message.deliveryStatus ?? "accepted"}>{DELIVERY_LABELS[message.deliveryStatus ?? ""] ?? "Aceita pela Meta"}</b></span>}
                  <time>{new Date(message.createdAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</time>
                </footer>
              </div>
            </Fragment>;
          })}
        </div>
        {newBelow && <button type="button" className="new-messages" onClick={()=>{ const el = messagesRef.current; if (el) el.scrollTop = el.scrollHeight; setNewBelow(false); }}>Novas mensagens <Icon name="chevron-down" size={14} /></button>}
      </div>
      {sendError && <p className="form-error composer-error">{sendError}</p>}
      <div className={`composer ${canCompose ? "" : "disabled"}`}>
        <textarea ref={composerRef} value={draft} disabled={!canCompose || sending} maxLength={4096} rows={1}
          onChange={(e)=>{setDraft(e.target.value);setSendError(null)}}
          onKeyDown={(e)=>{ if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){ e.preventDefault(); void send(); } }}
          placeholder={composerHint} aria-label="Resposta ao cliente" />
        <div className="composer-bar">
          {quickReplies.length>0 && <QuickReplies items={quickReplies} disabled={!canCompose || sending} onPick={insertReply} />}
          <span className="composer-count">{draft.length > 3500 ? `${draft.length}/4096` : ""}</span>
          <button type="button" className="button send" disabled={!canCompose || sending || !draft.trim()} onClick={()=>void send()}>{sending ? "Enviando…" : <>Enviar<Icon name="send" size={15} /></>}</button>
        </div>
      </div>
    </section>

    {details && <aside className="inbox-details" aria-label="Detalhes do cliente">
      <div className="details-head">
        {selected ? <><Avatar size="lg" name={conversationTitle(selected)} label={selected.displayName ? undefined : conversationLabel(selected.externalConversationId).slice(-2)} />
          <h2>{conversationTitle(selected)}</h2><p>{conversationLabel(selected.externalConversationId)} · {selected.channel}</p></> : <p>Nenhuma conversa aberta.</p>}
        <button type="button" className="icon-button details-close" onClick={()=>setDetails(false)} aria-label="Fechar detalhes"><Icon name="x" /></button>
      </div>
      {selected && <>
        <div className="details-tabs" role="tablist">
          {([["cliente","Cliente"],["copiloto","Copiloto"],["auditoria","Auditoria"]] as const).map(([id,label])=><button key={id} type="button" role="tab" aria-selected={detailTab===id} className={detailTab===id?"active":""} onClick={()=>setDetailTab(id)}>{label}</button>)}
        </div>
        <div className="details-body">
          {detailTab==="cliente" && <>
            <IxcPanel match={ixc} />
            <section className="details-section">
              <h3>Conversa</h3>
              <dl className="facts">
                <div><dt>Mensagens</dt><dd>{selected.messages}</dd></div>
                <div><dt>Última</dt><dd>{relativeTime(selected.lastAt, now)}</dd></div>
                <div><dt>Aguardando resposta</dt><dd>{selected.awaitingSince?`há ${relativeTime(selected.awaitingSince, now)}`:"Não"}</dd></div>
                <div><dt>Assunto</dt><dd>{selected.intent?intentLabel(selected.intent):"Não registrado"}</dd></div>
                <div><dt>Desfecho</dt><dd>{statusLabel}</dd></div>
              </dl>
            </section>
          </>}
          {/* `key` troca o copiloto inteiro ao mudar de conversa: sem isso a resposta
              de um cliente ficaria na tela ao lado do histórico de outro. */}
          {detailTab==="copiloto" && <Copilot key={conversationKey(selected)} channel={selected.channel} conversationId={selected.externalConversationId} onUse={canCompose ? insertReply : undefined} />}
          {detailTab==="auditoria" && <ConversationAuditPanel audit={audit} />}
        </div>
      </>}
    </aside>}
  </div>;
}

/** Respostas aprovadas a um clique, em vez de um `<select>` que some atrás do teclado. */
function QuickReplies({ items, disabled, onPick }: { items:QuickReply[]; disabled:boolean; onPick:(content:string)=>void }) {
  const [open,setOpen] = useState(false);
  const [filter,setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event:MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event:KeyboardEvent) => { if (event.key==="Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const shown = items.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()));
  return <div className="quick-replies" ref={ref}>
    <button type="button" className="button ghost small" disabled={disabled} onClick={()=>setOpen((value)=>!value)} aria-expanded={open}><Icon name="sparkles" size={15} />Respostas rápidas</button>
    {open && <div className="quick-pop">
      <input value={filter} onChange={(e)=>setFilter(e.target.value)} placeholder="Filtrar assunto…" aria-label="Filtrar respostas" />
      <ul>{shown.map((item)=><li key={item.intent}><button type="button" onClick={()=>{ onPick(item.content); setOpen(false); setFilter(""); }}><strong>{item.label}</strong><span>{item.content}</span></button></li>)}</ul>
    </div>}
  </div>;
}

/**
 * Quem é o cliente no IXC, pelo telefone. Exatamente um cadastro ou nada:
 * identificar o cliente errado é pior que não identificar.
 */
function IxcPanel({ match }: { match:IxcMatch|null }) {
  return <section className="details-section">
    <h3>Cadastro no IXC</h3>
    {(!match || match.state==="loading") && <p className="muted small">Procurando pelo telefone…</p>}
    {match?.state==="found" && <dl className="facts">
      <div><dt>Cliente</dt><dd>{match.customer.name}</dd></div>
      <div><dt>Código IXC</dt><dd>{match.customer.id}</dd></div>
      <div><dt>Situação</dt><dd>{match.customer.status || "—"}</dd></div>
      <div><dt>Local</dt><dd>{[match.customer.neighborhood, match.customer.city].filter(Boolean).join(" — ") || "—"}</dd></div>
    </dl>}
    {match?.state==="none" && <p className="muted small">Nenhum cadastro com este número — ou mais de um. A busca só identifica quando há exatamente um, para não confundir clientes.</p>}
    {match?.state==="unavailable" && <p className="muted small">{match.detail}</p>}
  </section>;
}

/**
 * Ficha de auditoria da conversa: o que dá para provar depois sobre o que a IA
 * fez ali. Fica ao lado do histórico de propósito — a pergunta "por que ela
 * respondeu isso?" só aparece quando se está olhando a conversa.
 *
 * **Campo não registrado diz isso, com todas as letras.** Conversa anterior a
 * estas colunas existirem não tem como ser preenchida, e mostrar "regex" ou
 * "0%" no lugar seria inventar um fato de auditoria.
 */
function ConversationAuditPanel({audit}:{audit:ConversationAudit|null}){
  if(!audit)return <section className="details-section"><h3>Auditoria da IA</h3><p className="muted small">Nenhum atendimento registrado para esta conversa. Sem desfecho gravado, não há o que auditar.</p></section>;
  const missing = <em className="audit-missing">não registrado</em>;
  const origem = audit.intentSource==="llm"
    ? <>Modelo de linguagem{audit.intentModel?<> <code>{audit.intentModel}</code></>:null}</>
    : audit.intentSource==="rules" ? <>Regra de texto <InfoTip>O modelo não respondeu a tempo, ou está desligado.</InfoTip></> : missing;
  return <section className="details-section">
    <h3>Auditoria da IA</h3>
    <dl className="facts">
      <div><dt>Quem classificou</dt><dd>{origem}</dd></div>
      <div><dt>Confiança</dt><dd>{audit.intentConfidence===null?missing:`${audit.intentConfidence}%`}</dd></div>
      <div><dt>Assunto</dt><dd>{audit.intent?intentLabel(audit.intent):missing}</dd></div>
      <div><dt>Desfecho</dt><dd>{audit.finalStatus ?? missing}</dd></div>
      {audit.handoff && <div><dt>Transbordou porque</dt><dd>{audit.handoffReason?handoffLabel(audit.handoffReason):missing}</dd></div>}
      <div><dt>Versão do código</dt><dd>{audit.appVersion?<code>{audit.appVersion}</code>:missing}</dd></div>
      <div className="stacked"><dt>Rastro</dt><dd>{audit.correlationId?<code className="break">{audit.correlationId}</code>:missing}</dd></div>
    </dl>
    <p className="hint">Procure esse identificador em <strong>Administração → Auditoria</strong> para ver a linha exata do rastro.</p>
  </section>;
}

/**
 * Copiloto do atendente (issue #11): pergunta à base de conhecimento, sugere
 * resposta para a conversa aberta e resume o caso para passar a um colega.
 * Só a resposta redigida vira rascunho; o envio é sempre do atendente.
 */
function Copilot({ channel, conversationId, onUse }: { channel:string; conversationId:string; onUse?:(text:string)=>void }) {
  const [question,setQuestion] = useState("");
  const [busy,setBusy] = useState<null|"ask"|"suggest"|"summary">(null);
  const [result,setResult] = useState<CopilotResult|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [copied,setCopied] = useState(false);

  async function run(action:"ask"|"suggest"|"summary") {
    setBusy(action); setError(null); setCopied(false);
    try {
      const response = await fetch("/api/copilot", { method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({ action, channel, conversationId, question }) });
      const payload = await response.json() as { answer?:string; summary?:string; written?:"llm"|"excerpt"|"none"; caveat?:string|null; sources?:CopilotSource[]; question?:string; error?:string; detail?:string };
      if (!response.ok) { setError(payload.error ?? payload.detail ?? "O copiloto não respondeu."); setResult(null); return; }
      setResult(action==="summary"
        ? { kind:"summary", written:"none", text:payload.summary ?? "", caveat:null, sources:[] }
        // `basedOn` é a fala do cliente que o servidor escolheu responder. Sem
        // mostrá-la, uma sugestão fora de contexto vira mistério.
        : { kind:"answer", written:payload.written ?? "none", text:payload.answer ?? "", caveat:payload.caveat ?? null, sources:payload.sources ?? [], basedOn:payload.question });
    } catch { setError("O copiloto não respondeu."); setResult(null); }
    finally { setBusy(null); }
  }

  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.text); }
    // Sem cópia não houve uso: registrar "usada" aqui gravaria o que não aconteceu.
    catch { setError("Não consegui copiar. Selecione o texto acima e copie à mão."); return; }
    setCopied(true); setError(null);
    void fetch("/api/copilot", { method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ action:"used", channel, conversationId, kind:result.kind }) });
  }

  return <section className="details-section">
    <h3>Copiloto <InfoTip>Responde a partir da base de conhecimento e cita a fonte. Sem documento que sustente, diz que não sabe.</InfoTip></h3>
    <div className="copilot-actions">
      <button type="button" className="button secondary small" disabled={busy!==null} onClick={()=>void run("suggest")}><Icon name="sparkles" size={14} />{busy==="suggest"?"Buscando…":"Sugerir resposta"}</button>
      <button type="button" className="button secondary small" disabled={busy!==null} onClick={()=>void run("summary")}>{busy==="summary"?"Resumindo…":"Resumir para transferir"}</button>
    </div>
    <form className="copilot-ask" onSubmit={(e)=>{ e.preventDefault(); if(question.trim().length>2&&busy===null) void run("ask"); }}>
      <input value={question} placeholder="Pergunte: como resolvo lentidão em fibra?" onChange={(e)=>setQuestion(e.target.value)} aria-label="Pergunta ao copiloto" />
      <button type="submit" className="button small" disabled={busy!==null||question.trim().length<3}>{busy==="ask"?"…":"Perguntar"}</button>
    </form>
    {error && <p className="form-error">{error}</p>}
    {result && <div className="copilot-answer">
      {result.basedOn && <small className="muted">Respondendo a: “{result.basedOn}”</small>}
      {/* Em modo trecho a resposta *é* a fonte logo abaixo — repetir o mesmo
          texto duas vezes faria o atendente ler duas vezes por engano. */}
      {result.written!=="excerpt" && <pre>{result.text}</pre>}
      {result.caveat && <small className="warn-text">{result.caveat}</small>}
      {result.sources.map((source)=><div className="copilot-source" key={source.id}>
        <strong>{source.title}</strong><span>{source.category} · versão {source.version}</span>
        <em>{source.excerpt}</em>
      </div>)}
      <div className="copilot-buttons">
        <button type="button" className="button secondary small" onClick={()=>void copy()}><Icon name={copied?"check":"copy"} size={14} />{copied?"Copiado":"Copiar"}</button>
        {/* Só resposta redigida vira rascunho: em modo trecho `text` é o recorte da
            fonte, não uma fala para o cliente. */}
        {onUse && result.kind==="answer" && result.written==="llm" && result.text && <button type="button" className="button secondary small" onClick={()=>onUse(result.text)}>Usar no campo de resposta</button>}
      </div>
    </div>}
  </section>;
}
