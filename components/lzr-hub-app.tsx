"use client";

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentResult, ChatMessage } from "@/lib/agent/types";
import { navigation, viewTitles, type View } from "@/lib/platform/navigation";
import { containsHomologationText } from "@/lib/platform/reply-templates-shared";
import { Customer360Module } from "@/components/modules/customer360";
import { SupportModule } from "@/components/modules/support";
import { BillingModule } from "@/components/modules/billing";
import { SalesModule } from "@/components/modules/sales";
import { IntelligenceModule } from "@/components/modules/intelligence";
import { AdminModule } from "@/components/modules/admin";
import { QualityModule } from "@/components/modules/quality";
import { InternalChatModule } from "@/components/modules/internal-chat";

type UiMessage = ChatMessage & { time: string; result?: AgentResult };

function Avatar({ initials = "JP" }: { initials?: string }) { return <div className="avatar">{initials}</div>; }

type Theme = "system" | "light" | "dark";
const THEME_KEY = "lzr-theme";
const THEME_LABELS: Record<Theme, [string, string]> = { system: ["◐", "Tema do sistema"], light: ["☀", "Tema claro"], dark: ["☾", "Tema escuro"] };
const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

/**
 * O tema vive no elemento raiz, não no estado do React — o script do `layout`
 * já o aplicou antes da primeira pintura. Aqui a gente apenas **lê** de lá, com
 * `useSyncExternalStore`, que existe para esse caso: um valor que mora fora do
 * React e precisa disparar renderização quando muda.
 */
const themeListeners = new Set<() => void>();
function subscribeTheme(callback: () => void) {
  themeListeners.add(callback);
  // Trocar o tema numa aba passa a valer nas outras: o evento `storage` só
  // chega nas abas que não fizeram a alteração, então elas aplicam aqui.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_KEY) return;
    if (event.newValue === "light" || event.newValue === "dark") document.documentElement.dataset.theme = event.newValue;
    else delete document.documentElement.dataset.theme;
    callback();
  };
  window.addEventListener("storage", onStorage);
  return () => { themeListeners.delete(callback); window.removeEventListener("storage", onStorage); };
}
function readTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}
/** No servidor não há elemento raiz para consultar: "sistema" é o padrão. */
const readThemeOnServer = (): Theme => "system";

/**
 * Alterna entre tema do sistema, claro e escuro.
 *
 * "Sistema" é o padrão e é uma opção de verdade, não a ausência de escolha:
 * quem trabalha de dia e de noite quer acompanhar o sistema operacional. Ele é
 * representado pela **ausência** de `data-theme` — aí o `color-scheme: light dark`
 * do CSS decide sozinho.
 */
function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, readThemeOnServer);

  function change() {
    const next = NEXT_THEME[theme];
    try {
      if (next === "system") { window.localStorage.removeItem(THEME_KEY); delete document.documentElement.dataset.theme; }
      else { window.localStorage.setItem(THEME_KEY, next); document.documentElement.dataset.theme = next; }
    } catch {
      // Armazenamento bloqueado: o tema ainda vale nesta aba, só não persiste.
      if (next === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
    }
    for (const listener of themeListeners) listener();
  }

  const [icon, label] = THEME_LABELS[theme];
  return <button className="theme-toggle" onClick={change} title={`${label} — clique para trocar`} aria-label={`${label}. Clique para trocar de tema.`}>
    <i aria-hidden="true">{icon}</i><span>{label}</span>
  </button>;
}

type SessionState = { authenticated: boolean; authRequired: boolean; mustChangePassword?: boolean; user?: { name: string; email: string; role: string } };

function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "??";
}

/**
 * Só redireciona depois que a sessão é consultada no cliente. A primeira
 * renderização é sempre a aplicação normal — o HTML inicial é verificado pelos
 * testes do ambiente de demonstração e não pode virar uma tela de carregamento.
 */
function useSessionRedirect() {
  const [session, setSession] = useState<SessionState | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: SessionState) => {
        if (!active) return;
        setSession(data);
        if (data.authRequired && !data.authenticated) window.location.href = "/login";
      })
      .catch(() => { if (active) setSession(null); });
    return () => { active = false; };
  }, []);
  return session;
}

export function LzrHubApp({ ixcMode = "disabled" }: { ixcMode?: string }) {
  const [view, setView] = useState<View>("dashboard");
  const [changingPassword, setChangingPassword] = useState(false);
  const session = useSessionRedirect();
  const user = session?.user;
  // Senha gerada pelo sistema: a pessoa define a dela antes de usar qualquer tela.
  const forced = session?.mustChangePassword === true;
  // Só existe dado real quando o IXC está de fato ligado. Fora disso a tela
  // continua avisando que é demonstração, que é a verdade nesse modo.
  const live = ixcMode === "staging-readonly" || ixcMode === "production-readonly";

  function signOut() {
    fetch("/api/auth/logout", { method: "POST" })
      .then(() => { window.location.href = "/login"; })
      .catch(() => { window.location.href = "/login"; });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">L</div><div className="brand-copy"><strong>LZR HUB</strong><small>BBNET Intelligence</small></div></div>
        {/* Em tela estreita a barra vira só ícones. O `title` e o `aria-label` são
            o que impede isso de virar 23 glifos indecifráveis. */}
        <nav className="nav-scroll" aria-label="Navegação principal">{navigation.map((item) => <div key={item.id}>{item.group ? <div className="nav-label">{item.group}</div> : null}<button className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)} title={item.group ? `${item.group} › ${item.label}` : item.label} aria-label={item.label} aria-current={view === item.id ? "page" : undefined}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span></button></div>)}</nav>
        <div className="sidebar-footer">
          <div className="sidebar-identity">
            <Avatar initials={user ? initialsOf(user.name) : "AD"} />
            <div><strong>{user ? user.name : "Admin Demonstração"}</strong><span>{user ? user.role : "Usuário sintético"}</span></div>
            {user && <div style={{ display: "flex", gap: 6 }}>
              <button className="button secondary" onClick={() => setChangingPassword(true)}>Senha</button>
              <button className="button secondary" onClick={signOut}>Sair</button>
            </div>}
          </div>
          <ThemeToggle />
        </div>
      </aside>
      {(changingPassword || forced) && <PasswordDialog forced={forced} onClose={() => { setChangingPassword(false); if (forced) window.location.reload(); }} />}
      <section className="workspace">
        <header className="topbar"><div className="topbar-title"><strong>{viewTitles[view][0]}</strong><span>{live ? "Dados reais de produção • somente leitura" : viewTitles[view][1]}</span></div><div className="live-pill">{live ? "● IXC conectado • somente leitura" : "● Homologação protegida • demo mock"}</div></header>
        {live
          ? <div className="demo-notice" role="status"><strong>Leitura de produção</strong><span>o cadastro vem do IXC; nenhuma escrita é executada no ERP</span></div>
          : <div className="demo-notice" role="status"><strong>Ambiente de demonstração</strong><span>nenhuma ação real é executada</span></div>}
        {view === "dashboard" && <Dashboard onOpen={() => setView("atendimento")} />}
        {view === "atendimento" && <Conversation />}
        {view === "training" && <TrainingMode />}
        {["integracoes","equipes","usuarios","auditoria","configuracoes"].includes(view) && <AdminModule view={view as "integracoes"|"equipes"|"usuarios"|"auditoria"|"configuracoes"} />}
        {view === "clientes" && <Customer360Module />}
        {view === "chat-interno" && <InternalChatModule />}
        {["monitoramento","mapa-alertas","massivas","chamados"].includes(view) && <SupportModule view={view as "monitoramento"|"mapa-alertas"|"massivas"|"chamados"} onNavigateMassivas={() => setView("massivas")} />}
        {["cobranca","regua","relatorios-cobranca"].includes(view) && <BillingModule view={view as "cobranca"|"regua"|"relatorios-cobranca"} />}
        {["comercial","funil","metas","relatorios-comercial"].includes(view) && <SalesModule view={view as "comercial"|"funil"|"metas"|"relatorios-comercial"} />}
        {["churn","conhecimento"].includes(view) && <IntelligenceModule view={view as "churn"|"conhecimento"} />}
        {["avaliacoes","prompts"].includes(view) && <QualityModule view={view as "avaliacoes"|"prompts"} />}
      </section>
    </div>
  );
}

type OverviewMetrics = { conversations:number; resolvedWithoutHuman:number; resolutionRate:number|null; handoffs:number; suggestionsOnly:number; handoffReasons:Record<string,number>; intents:Record<string,number>; csatAverage:number|null; csatCount:number; csatDistribution:Record<string,number>; costPerConversation:null };
type ConversationSummary = { channel:string; externalConversationId:string; lastMessage:string; lastRole:"customer"|"agent"|"suggestion"; lastAt:string; messages:number; finalStatus?:string; intent?:string; handoff?:boolean; displayName?:string; awaitingSince?:string; lastSentBy?:string };
type Overview = { period:string; available:boolean; detail?:string; metrics:OverviewMetrics|null; queue:ConversationSummary[]; averageHandlingSeconds:number|null; integrations:{ ixc:{mode:string;state:string}; channel:{enabled:boolean;configured:boolean;autoReply:boolean} } };

const INTENT_LABELS: Record<string,string> = {
  technical_no_connection:"Sem conexão", technical_slow:"Lentidão", technical_wifi:"Wi-Fi", technical_restart:"Reinício de equipamento",
  technical_ticket:"Abertura de chamado", technical_visit:"Visita técnica", financial_invoice:"Fatura / segunda via", financial_pix:"PIX",
  financial_payment:"Pagamento", financial_unlock:"Desbloqueio", financial_discount_request:"Pedido de desconto", complaint:"Reclamação", cancellation_risk:"Risco de cancelamento",
  human_handoff:"Pedido de atendente", unauthorized_request:"Pedido não autorizado", out_of_scope:"Fora de escopo", general_information:"Informação geral",
};
const HANDOFF_LABELS: Record<string,string> = {
  low_intent_confidence:"Baixa confiança na intenção", customer_requested_human:"Cliente pediu atendente", customer_irritated:"Cliente irritado",
  unauthorized_request:"Pedido não autorizado", cancellation_risk:"Risco de cancelamento", "não informado":"Não informado",
};
const intentLabel = (key:string) => INTENT_LABELS[key] ?? key;
const handoffLabel = (key:string) => HANDOFF_LABELS[key] ?? key;

/** Telefone do WhatsApp: mostra em formato legível, sem esconder dígito de quem atende. */
function conversationLabel(id:string) {
  const digits = id.replace(/\D/g,"");
  if (digits.length < 12 || digits.length > 13) return id;
  const ddd = digits.slice(2,4); const rest = digits.slice(4);
  return `(${ddd}) ${rest.slice(0,rest.length-4)}-${rest.slice(-4)}`;
}
function relativeTime(iso:string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "—";
  const minutes = Math.round(diff/60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes/60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours/24)} d`;
}

const PERIOD_LABELS: [string,string][] = [["24h","24 horas"],["7d","7 dias"],["30d","30 dias"]];

type CockpitMetric = { value:number|null; detail:string };
type Cockpit = {
  available:boolean; period:string;
  activeCustomers:CockpitMetric; openInvoices:CockpitMetric; overdueInvoices:CockpitMetric;
  conversations:CockpitMetric; resolutionRate:CockpitMetric; csat:CockpitMetric;
  openIncidents:CockpitMetric; affectedCustomers:CockpitMetric; goalProgressPercent:CockpitMetric; aiCost:CockpitMetric;
  recentActivity:Array<{id:string;action:string;entity:string;result:string;createdAt:string;actorId:string}>;
  degraded:string[];
};

const brl = (value:number) => `R$ ${value.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

/**
 * Cartão do cockpit. Indisponível nunca vira zero: mostra "—" e o motivo, para
 * um painel de gestor não ser lido como "não há inadimplente" quando na verdade
 * a fonte não respondeu.
 */
function CockpitCard({ label, metric, icon, format }: { label:string; metric:CockpitMetric; icon:string; format?:(value:number)=>string }) {
  return <Metric label={label} value={metric.value===null?"—":(format?format(metric.value):metric.value.toLocaleString("pt-BR"))} detail={metric.detail} icon={icon} />;
}

function Dashboard({ onOpen }: { onOpen: () => void }) {
  const [period,setPeriod] = useState("7d");
  const [data,setData] = useState<Overview|null>(null);
  const [state,setState] = useState<"loading"|"ready"|"error">("loading");
  useEffect(() => {
    let active = true;
    fetch(`/api/operation/overview?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: Overview) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [period]);

  const metrics = data?.metrics ?? null;
  const percent = (value:number|null) => value===null ? "—" : `${Math.round(value*100)}%`;
  return <main className="content">
    <div className="page-heading"><div><h1>Olá, equipe BBNET.</h1><p>Números medidos em cada módulo. O que não é medido aparece como não medido.</p></div><button className="button" onClick={onOpen}>Abrir central de atendimento</button></div>
    <section className="filter-bar"><select value={period} onChange={(e)=>{setState("loading");setPeriod(e.target.value)}}>{PERIOD_LABELS.map(([value,label])=><option key={value} value={value}>Últimos {label}</option>)}</select></section>
    <CockpitPanel period={period} />
    {state==="loading" && <div className="state-card">Carregando indicadores…</div>}
    {state==="error" && <div className="state-card error">Não foi possível carregar os indicadores.</div>}
    {state==="ready" && data && !data.available && <div className="state-card error">{data.detail ?? "Fonte de indicadores indisponível"} — nenhum número é exibido para não induzir a erro.</div>}
    {state==="ready" && data?.available && metrics && <>
      {data.integrations.channel.enabled && !data.integrations.channel.autoReply && <div className="state-card" style={{marginBottom:14}}><strong>Canal em modo observação.</strong> As mensagens são recebidas e classificadas, mas a IA não responde ao cliente. Por isso a taxa de resolução fica em zero: sugestão não é atendimento resolvido.</div>}
      <section className="metrics">
        <Metric label="Conversas no período" value={String(metrics.conversations)} detail={metrics.conversations?`Canal ${data.integrations.channel.enabled?(data.integrations.channel.autoReply?"respondendo":"em observação"):"desligado"}`:"Nenhuma conversa registrada"} icon="◫" />
        <Metric label="Resolvidas sem humano" value={percent(metrics.resolutionRate)} detail={metrics.conversations?`${metrics.resolvedWithoutHuman} de ${metrics.conversations}`:"Sem base para calcular"} icon="✦" />
        {data.integrations.channel.autoReply
          ? <Metric label="Transbordos" value={String(metrics.handoffs)} detail={metrics.handoffs?"Passaram para humano":"Nenhum no período"} icon="⇄" />
          : <Metric label="Sugestões sem envio" value={String(metrics.suggestionsOnly)} detail={metrics.handoffs?`${metrics.handoffs} recomendariam transbordo`:"Nenhuma recomendação de transbordo"} icon="◐" />}
        <Metric label="CSAT médio" value={metrics.csatAverage===null?"—":metrics.csatAverage.toFixed(1).replace(".",",")} detail={metrics.csatCount?`${metrics.csatCount} avaliação(ões)`:"Nenhuma avaliação recebida"} icon="✓" />
      </section>
      <section className="dashboard-grid">
        <div className="card"><div className="card-header"><strong>Últimas conversas</strong><span className={`badge ${data.integrations.channel.enabled?"green":"amber"}`}>{data.integrations.channel.enabled?"● Canal ativo":"● Canal desligado"}</span></div><div className="card-body">
          {data.queue.length===0
            ? <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.6}}>Nenhuma conversa registrada. {data.integrations.channel.enabled?"O canal está ligado e aguardando mensagens.":"O canal do WhatsApp está desligado (FEATURE_N8N_CHANNEL)."}</p>
            : data.queue.map((item)=><button className="queue-row" key={`${item.channel}:${item.externalConversationId}`} onClick={onOpen} style={{width:"100%",textAlign:"left",background:"none",border:"none",cursor:"pointer"}}>
                <Avatar initials={conversationLabel(item.externalConversationId).slice(-2)} />
                <div><p>{conversationLabel(item.externalConversationId)}</p><span>{item.intent?intentLabel(item.intent):"Sem desfecho registrado"} • {item.messages} mensagens</span></div>
                <span className={`badge ${item.handoff?"amber":"green"}`}>{relativeTime(item.lastAt)}</span>
              </button>)}
        </div></div>
        <div className="card"><div className="card-header"><strong>Conversas por intenção</strong><span className="badge blue">Últimos {PERIOD_LABELS.find(([v])=>v===period)?.[1]}</span></div><div className="card-body">
          {metrics.conversations===0
            ? <p style={{fontSize:12,color:"var(--muted)"}}>Sem conversas no período — nada a distribuir.</p>
            : Object.entries(metrics.intents).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([intent,count])=><Progress key={intent} label={`${intentLabel(intent)} (${count})`} value={Math.round(count/metrics.conversations*100)} />)}
          {metrics.handoffs>0 && <div style={{marginTop:22,padding:14,background:"var(--warn-bg)",borderRadius:10,fontSize:11,color:"var(--warn)",lineHeight:1.6}}><strong style={{display:"block",fontSize:12,color:"var(--warn)",marginBottom:4}}>Por que passou para humano</strong>{Object.entries(metrics.handoffReasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>`${handoffLabel(reason)}: ${count}`).join(" • ")}</div>}
          <div style={{marginTop:14,padding:14,background:"var(--blue-soft)",borderRadius:10,fontSize:11,color:"var(--text-2)",lineHeight:1.6}}><strong style={{display:"block",fontSize:12,color:"var(--blue)",marginBottom:4}}>Ainda não medimos</strong>Tempo médio de atendimento e custo por conversa dependem da instrumentação do Langfuse. Em vez de estimar, ficam de fora.</div>
        </div></div>
      </section>
    </>}
  </main>;
}

/**
 * Troca da própria senha. Fica na barra lateral, junto do "Sair", porque
 * pertence à pessoa e não à Administração — um "Somente leitura" também precisa
 * conseguir trocar a sua, sem depender de alguém resetar por ele.
 */
function PasswordDialog({ onClose, forced = false }: { onClose: () => void; forced?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (next !== confirm) { setMessage("A confirmação não confere com a nova senha."); return; }
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) { setMessage(payload.error ?? "Não foi possível trocar a senha."); return; }
      setDone(true); setCurrent(""); setNext(""); setConfirm("");
    } catch { setMessage("Falha ao falar com o servidor."); }
    finally { setBusy(false); }
  }

  // No primeiro acesso o diálogo não fecha: clicar fora ou apertar Esc deixaria
  // a pessoa navegando com uma senha que um administrador conhece.
  return <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "grid", placeItems: "center", zIndex: 50 }} onClick={forced ? undefined : onClose}>
    <div className="data-card" style={{ width: "min(420px, 92vw)", background: "white" }} onClick={(event) => event.stopPropagation()}>
      <div className="card-header"><strong>{forced ? "Defina a sua senha" : "Trocar minha senha"}</strong>{!forced && <button onClick={onClose}>Fechar</button>}</div>
      {forced && !done && <div className="state-card" style={{ margin: "0 14px" }}>A senha que você usou foi gerada pelo sistema e um administrador a conhece. Defina a sua para continuar.</div>}
      {done
        ? <div style={{ padding: 16, lineHeight: 1.7, fontSize: 12 }}><strong>Senha trocada.</strong><p style={{ marginTop: 6 }}>As suas outras sessões foram encerradas — se alguém estava logado na sua conta em outro lugar, perdeu o acesso agora. Esta continua valendo.</p><button className="button" style={{ marginTop: 10 }} onClick={onClose}>{forced ? "Entrar" : "Pronto"}</button></div>
        : <div className="wizard" style={{ display: "grid", gap: 8 }}>
            <input type="password" placeholder={forced ? "Senha que você recebeu" : "Senha atual"} value={current} onChange={(event) => { setCurrent(event.target.value); setMessage(null); }} />
            <input type="password" placeholder="Nova senha (mínimo 10 caracteres)" value={next} onChange={(event) => setNext(event.target.value)} />
            <input type="password" placeholder="Repita a nova senha" value={confirm} onChange={(event) => setConfirm(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} />
            {message && <p style={{ fontSize: 11, color: "var(--bad)", lineHeight: 1.5 }}>{message}</p>}
            <button className="button" disabled={busy || !current || !next} onClick={() => void submit()}>{busy ? "Trocando…" : "Trocar senha"}</button>
            <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>Pedimos a senha atual de propósito: sem isso, um cookie roubado bastaria para trancar você fora da própria conta.</p>
          </div>}
    </div>
  </div>;
}

const ACTION_LABELS: Record<string,string> = {
  "billing.rule.save":"Régua salva", "billing.collections.dispatch":"Disparo da régua", "billing.promise.create":"Promessa registrada",
  "billing.promise.review":"Promessas revisadas", "ixc.write.invoice_reissue":"Segunda via de boleto",
  "support.incident.create":"Massiva registrada", "support.incident.close":"Massiva encerrada", "support.incident.notify":"Aviso de massiva",
  "sales.goal.save":"Meta salva", "channel.message.processed":"Mensagem do canal", "integrations.telegram.alert":"Alerta de rede",
};

/**
 * Cockpit do gestor (issue #22): os números de todos os módulos numa tela só,
 * cada fonte consultada em paralelo e com falha isolada. Uma fonte fora do ar
 * mostra "—" com o motivo, e as outras continuam aparecendo.
 */
function CockpitPanel({ period }: { period:string }) {
  const [data,setData] = useState<Cockpit|null>(null);
  const [state,setState] = useState<"loading"|"ready"|"error">("loading");
  useEffect(() => {
    let active = true;
    fetch(`/api/cockpit?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: Cockpit) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [period]);

  if (state==="loading") return <div className="state-card">Consultando os módulos…</div>;
  if (state==="error" || !data) return <div className="state-card error">Não foi possível montar o cockpit.</div>;

  return <>
    {data.degraded.length>0 && <div className="state-card" style={{marginBottom:14}}>
      <strong>Fonte(s) indisponível(is): {data.degraded.join(", ")}.</strong> Os cartões dessas fontes aparecem como não medidos — nenhum deles vira zero.
    </div>}
    <section className="metrics">
      <CockpitCard label="Clientes ativos" metric={data.activeCustomers} icon="◉" />
      <CockpitCard label="Faturas em aberto" metric={data.openInvoices} icon="$" />
      <CockpitCard label="Faturas vencidas" metric={data.overdueInvoices} icon="$" />
      <CockpitCard label="Meta do mês" metric={data.goalProgressPercent} icon="◎" format={(v)=>`${v}%`} />
    </section>
    {/* "Conversas no período" fica só na seção de atendimento, logo abaixo, que
        já a mostra junto de resolução e CSAT — repetir aqui era ruído. */}
    <section className="metrics" style={{marginTop:14,gridTemplateColumns:"repeat(3, 1fr)"}}>
      <CockpitCard label="Massivas abertas" metric={data.openIncidents} icon="⚠" />
      <CockpitCard label="Clientes impactados" metric={data.affectedCustomers} icon="⚠" />
      <CockpitCard label="Custo de IA" metric={data.aiCost} icon="✦" format={brl} />
    </section>
    {data.recentActivity.length>0 && <section className="card" style={{marginTop:14}}>
      <div className="card-header"><strong>Atividades recentes da operação</strong><span className="badge blue">Do rastro de auditoria</span></div>
      <div className="card-body">
        {data.recentActivity.map((item)=><div className="aging-row" key={item.id}>
          <div><strong>{ACTION_LABELS[item.action] ?? item.action}</strong><span>{item.actorId} • {item.entity}</span></div>
          <b style={{fontSize:11,color:item.result==="success"?"var(--ok)":"var(--muted)"}}>{relativeTime(item.createdAt)}</b>
        </div>)}
      </div>
    </section>}
  </>;
}

function Metric({ label, value, detail, icon }: { label:string; value:string; detail:string; icon:string }) { return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></article>; }
function Progress({ label, value }: { label:string; value:number }) { return <div className="bar-row"><div className="bar-label"><span>{label}</span><strong>{value}%</strong></div><div className="bar"><span style={{width:`${value}%`}} /></div></div>; }

type ConversationMessage = { role:"customer"|"agent"|"suggestion"; content:string; createdAt:string; sentBy?:string; deliveryStatus?:string; deliveryError?:string };
type ChannelState = { enabled:boolean; autoReply:boolean; canReply:boolean };
type ReplyWindow = { lastCustomerAt:string|null; closesAt:string|null; open:boolean };
type IxcCustomer = { id:string; name:string; status:string; city:string; neighborhood:string };
type IxcMatch = { state:"loading" } | { state:"found"; customer:IxcCustomer } | { state:"none" } | { state:"unavailable"; detail:string };
type QuickReply = { intent:string; label:string; content:string };
type ConversationAudit = { intent:string|null; finalStatus:string|null; handoff:boolean|null; handoffReason:string|null; intentSource:string|null; intentConfidence:number|null; intentModel:string|null; appVersion:string|null; correlationId:string|null; createdAt:string|null };

/**
 * Ficha de auditoria da conversa: o que dá para provar depois sobre o que a IA
 * fez ali.
 *
 * Fica ao lado do histórico de propósito. Quem abre a conversa para entender
 * "por que ela respondeu isso?" não deveria precisar de uma segunda tela — e a
 * pergunta só aparece quando se está olhando a conversa.
 *
 * **Campo não registrado diz isso, com todas as letras.** Conversa anterior a
 * estas colunas existirem não tem como ser preenchida, e mostrar "regex" ou
 * "0%" no lugar seria inventar um fato de auditoria — exatamente o oposto do
 * que a auditoria serve para fazer.
 */
function ConversationAuditPanel({audit}:{audit:ConversationAudit|null}){
  if(!audit)return <div className="info-section">
    <h4>Auditoria da IA</h4>
    <p className="audit-empty">Nenhum atendimento registrado para esta conversa. Sem desfecho gravado, não há o que auditar.</p>
  </div>;

  const naoRegistrado = <em className="audit-missing">não registrado</em>;
  const origem = audit.intentSource==="llm"
    ? <>Modelo de linguagem{audit.intentModel?<> <code>{audit.intentModel}</code></>:null}</>
    : audit.intentSource==="rules" ? <>Regra de texto <span className="audit-note">(o modelo não respondeu a tempo, ou está desligado)</span></> : naoRegistrado;

  return <div className="info-section">
    <h4>Auditoria da IA</h4>
    <p className="audit-empty">O que dá para provar depois sobre este atendimento.</p>
    <div className="audit-line"><span>Quem classificou</span><strong>{origem}</strong></div>
    <div className="audit-line"><span>Confiança</span><strong>{audit.intentConfidence===null?naoRegistrado:`${audit.intentConfidence}%`}</strong></div>
    <div className="audit-line"><span>Intenção</span><strong>{audit.intent?intentLabel(audit.intent):naoRegistrado}</strong></div>
    <div className="audit-line"><span>Desfecho</span><strong>{audit.finalStatus ?? naoRegistrado}</strong></div>
    {audit.handoff && <div className="audit-line"><span>Transbordou porque</span><strong>{audit.handoffReason?handoffLabel(audit.handoffReason):naoRegistrado}</strong></div>}
    <div className="audit-line"><span>Versão do código</span><strong>{audit.appVersion?<code>{audit.appVersion}</code>:naoRegistrado}</strong></div>
    <div className="audit-line"><span>Rastro</span><strong>{audit.correlationId?<code className="audit-id">{audit.correlationId}</code>:naoRegistrado}</strong></div>
    <p className="audit-note">Procure esse identificador em <strong>Administração → Auditoria</strong> para ver a linha exata do rastro, com o texto que saiu.</p>
  </div>;
}

type CopilotSource = { id:string; title:string; category:string; version:number; excerpt:string; score:number };
type CopilotResult = { kind:"answer"|"summary"; written:"llm"|"excerpt"|"none"; text:string; caveat:string|null; sources:CopilotSource[]; basedOn?:string };

/**
 * Copiloto do atendente (issue #11): pergunta à base de conhecimento, sugere
 * resposta para a conversa aberta e resume o caso para passar a um colega.
 *
 * O botão é "Copiar", não "Enviar": responder pela tela não existe, e um botão
 * de enviar que não envia seria a mentira mais cara desta tela. Copiar é o que
 * de fato acontece — e é isso que vai para a auditoria.
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
        // mostrá-la, uma sugestão fora de contexto vira mistério — e foi o que
        // aconteceu na primeira versão, respondendo à nota de avaliação.
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

  return <div className="info-section">
    <h4>Copiloto</h4>
    <p className="copilot-note">Responde a partir da base de conhecimento e cita a fonte. Sem documento que sustente, diz que não sabe.</p>
    <div className="copilot-actions">
      <button className="button secondary" disabled={busy!==null} onClick={()=>void run("suggest")}>{busy==="suggest"?"Buscando…":"Sugerir resposta"}</button>
      <button className="button secondary" disabled={busy!==null} onClick={()=>void run("summary")}>{busy==="summary"?"Resumindo…":"Resumir para transferir"}</button>
    </div>
    <div className="copilot-ask">
      <input value={question} placeholder="Pergunte: como resolvo lentidão em fibra?" onChange={(e)=>setQuestion(e.target.value)}
        onKeyDown={(e)=>{ if(e.key==="Enter"&&question.trim().length>2&&busy===null){ e.preventDefault(); void run("ask"); } }} />
      <button className="button" disabled={busy!==null||question.trim().length<3} onClick={()=>void run("ask")}>{busy==="ask"?"…":"Perguntar"}</button>
    </div>
    {error && <p className="form-error" style={{marginTop:10}}>{error}</p>}
    {result && <div className="copilot-answer">
      {result.basedOn && <small className="copilot-basedon">Respondendo a: “{result.basedOn}”</small>}
      {/* Em modo trecho a resposta *é* a fonte logo abaixo — repetir o mesmo
          texto duas vezes faria o atendente ler duas vezes por engano. */}
      {result.written!=="excerpt" && <pre>{result.text}</pre>}
      {result.caveat && <small className="copilot-caveat">{result.caveat}</small>}
      {result.sources.map((source)=><div className="copilot-source" key={source.id}>
        <strong>{source.title}</strong><span>{source.category} • versão {source.version}</span>
        <em>{source.excerpt}</em>
      </div>)}
      <button className="button secondary" onClick={()=>void copy()}>{copied?"Copiado ✓":"Copiar"}</button>
      {/* Só resposta redigida vira rascunho: em modo trecho `text` é o recorte da
          fonte, não uma fala para o cliente. */}
      {onUse && result.kind==="answer" && result.written==="llm" && result.text && <button className="button secondary" style={{marginLeft:8}} onClick={()=>onUse(result.text)}>Usar no campo de resposta</button>}
    </div>}
  </div>;
}

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
function nameInitials(name:string) {
  // Por caractere, não por unidade de código: a primeira "letra" pode ser um emoji.
  const parts = name.trim().split(/\s+/).filter(Boolean).map((part) => Array.from(part));
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[parts.length-1][0]}` : (parts[0] ?? []).slice(0,2).join("");
  return letters.toUpperCase() || "?";
}
const conversationInitials = (item:ConversationSummary) => item.displayName ? nameInitials(item.displayName) : conversationLabel(item.externalConversationId).slice(-2);
function lastMessagePrefix(item:ConversationSummary) {
  if (item.lastRole==="suggestion") return "Sugestão: ";
  // Resposta sem autor registrado não é atribuída a ninguém — nem à IA.
  if (item.lastRole==="agent") return item.lastSentBy ? "Atendente: " : "Resposta: ";
  return "";
}
function waitLabel(iso:string) { const elapsed = relativeTime(iso); return elapsed==="agora" ? "Aguardando" : `Aguarda ${elapsed}`; }
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
function windowInfo(replyWindow:ReplyWindow|null, now:number): { tone:string; text:string } | null {
  if (!replyWindow) return null;
  if (!replyWindow.lastCustomerAt || !replyWindow.closesAt) return { tone:"", text:"Sem mensagem do cliente" };
  const remaining = Date.parse(replyWindow.closesAt) - now;
  if (remaining <= 0) return { tone:"red", text:"Janela de 24 h fechada" };
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 1) return { tone: hours < 2 ? "amber" : "green", text:`Janela aberta · ${hours} h restantes` };
  return { tone:"amber", text:`Janela fecha em ${Math.max(1, Math.ceil(remaining / 60_000))} min` };
}
/** Áudio, foto e documento chegam como aviso entre colchetes, gravado pelo canal. */
const isMediaNote = (message:ConversationMessage) => message.role==="customer" && /^\[[^\]]*recebid[oa] — /.test(message.content);

/**
 * Quem é o cliente no IXC, pelo telefone. Exatamente um cadastro ou nada:
 * identificar o cliente errado é pior que não identificar.
 */
function IxcPanel({ match }: { match:IxcMatch|null }) {
  return <div className="info-section">
    <h4>Cadastro no IXC</h4>
    {(!match || match.state==="loading") && <p className="audit-empty">Procurando pelo telefone…</p>}
    {match?.state==="found" && <>
      <div className="info-line"><span>Cliente</span><strong>{match.customer.name}</strong></div>
      <div className="info-line"><span>Código IXC</span><strong>{match.customer.id}</strong></div>
      <div className="info-line"><span>Situação</span><strong>{match.customer.status || "—"}</strong></div>
      <div className="info-line"><span>Local</span><strong>{[match.customer.neighborhood, match.customer.city].filter(Boolean).join(" — ") || "—"}</strong></div>
    </>}
    {match?.state==="none" && <p className="audit-empty">Nenhum cadastro com este número — ou mais de um. A busca só identifica quando há exatamente um, para não confundir clientes.</p>}
    {match?.state==="unavailable" && <p className="audit-empty">{match.detail}</p>}
  </div>;
}

function Conversation() {
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
  const messagesRef = useRef<HTMLDivElement>(null);
  // Refs porque o temporizador enxerga só a primeira renderização: sem elas ele
  // atualizaria sempre a conversa que estava aberta quando a tela montou.
  const selectedRef = useRef<ConversationSummary|null>(null);
  const queryRef = useRef("");
  const signatureRef = useRef("");
  const countRef = useRef(0);
  const stickRef = useRef(true);
  const listBusy = useRef(false);
  const messagesBusy = useRef(false);
  const titleRef = useRef<string|null>(null);

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
      else if (mode==="first" && !current && list.length) open(list[0]);
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
  useEffect(() => {
    titleRef.current = document.title;
    return () => { if (titleRef.current) document.title = titleRef.current; };
  }, []);
  useEffect(() => {
    // O número na aba avisa de cliente esperando mesmo com o atendente em outra janela.
    const base = titleRef.current ?? document.title;
    document.title = awaitingCount ? `(${awaitingCount}) ${base}` : base;
  }, [awaitingCount]);

  if (state==="loading") return <main className="content"><div className="state-card">Carregando conversas…</div></main>;
  if (state==="error") return <main className="content"><div className="state-card error">Não foi possível carregar as conversas.</div></main>;
  if (!available) return <main className="content"><div className="state-card error">Histórico de conversas indisponível. Nenhuma conversa de exemplo é exibida no lugar.</div></main>;
  if (items.length===0 && !query.trim() && !selected) return <main className="content"><div className="state-card"><strong>Nenhuma conversa registrada.</strong><p style={{marginTop:6,lineHeight:1.6}}>As conversas aparecem aqui assim que o canal do WhatsApp receber mensagens — esta tela se atualiza sozinha. Nada fictício é mostrado enquanto isso.</p></div></main>;

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
    : !windowOpen ? "Passaram mais de 24 horas desde a última mensagem do cliente. A Meta só aceita texto livre dentro dessa janela: é preciso que o cliente escreva de novo."
    : "Escreva a resposta ao cliente… (Enter envia, Shift+Enter quebra a linha)";
  const statusLabel = selected?.handoff ? "Transbordo" : selected?.finalStatus ? FINAL_STATUS_LABELS[selected.finalStatus] ?? selected.finalStatus : "Sem desfecho";

  return <main className="content" style={{paddingTop:18}}>
    {channelState.enabled && !channelState.autoReply && <div className="state-card" style={{marginBottom:14}}><strong>Modo observação.</strong> O canal recebe e registra as mensagens, e a IA propõe a resposta — mas nada é enviado automaticamente. {channelState.canReply ? "Quem responde é o atendente, pelo campo abaixo da conversa." : "O envio pela tela está desligado: ninguém responde ao cliente por aqui."}</div>}
    <div className="conversation-layout">
    <aside className="conversation-list">
      <div className="conversation-tools">
        <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar por nome ou número" aria-label="Buscar conversa" />
        <div className="conversation-filters">
          <button className={filter==="todas"?"active":""} onClick={()=>setFilter("todas")}>Todas</button>
          <button className={filter==="aguardando"?"active":""} onClick={()=>setFilter("aguardando")}>Aguardando resposta{awaitingCount ? ` (${awaitingCount})` : ""}</button>
        </div>
        <span className={`conversation-sync ${syncFailed?"stale":""}`}>{syncFailed ? "Falha ao atualizar — tentando de novo" : syncedAt ? `Atualiza sozinha · ${new Date(syncedAt).toLocaleTimeString("pt-BR")}` : ""}</span>
      </div>
      {visible.length===0 && <p className="conversation-empty">{filter==="aguardando" ? "Nenhum cliente aguardando resposta." : `Nenhuma conversa encontrada para “${query.trim()}”.`}</p>}
      {visible.map((item)=><div className={`contact ${selected && conversationKey(selected)===conversationKey(item)?"active":""}`} key={conversationKey(item)} onClick={()=>open(item)} role="button" tabIndex={0} onKeyDown={(e)=>{if(e.key==="Enter")open(item)}}>
        <Avatar initials={conversationInitials(item)} />
        <div>
          <p>{conversationTitle(item)}</p>
          {item.displayName && <small className="contact-phone">{conversationLabel(item.externalConversationId)}</small>}
          <span>{lastMessagePrefix(item)}{item.lastMessage.slice(0,60)}</span>
        </div>
        <div className="contact-meta">
          <time>{relativeTime(item.lastAt)}</time>
          {item.awaitingSince && <i className="wait-badge" title="Tempo desde a primeira mensagem do cliente ainda sem resposta">{waitLabel(item.awaitingSince)}</i>}
        </div>
      </div>)}
    </aside>
    <section className="conversation-main">
      <div className="chat-header">
        <div className="person"><Avatar initials={selected?conversationInitials(selected):"—"} /><div><strong>{selected?conversationTitle(selected):"—"}</strong><span>● {selected?.displayName ? `${conversationLabel(selected.externalConversationId)} · ` : ""}{selected?.channel ?? "canal"}</span></div></div>
        <div className="chat-badges">
          {windowState && <span className={`badge ${windowState.tone}`}>{windowState.text}</span>}
          <span className={`badge ${selected?.handoff?"amber":"blue"}`}>{statusLabel}</span>
        </div>
      </div>
      <div className="messages-wrap">
        <div className="messages" ref={messagesRef} onScroll={(e)=>{ const el = e.currentTarget; if (newBelow && el.scrollHeight - el.scrollTop - el.clientHeight < 80) setNewBelow(false); }}>
          {messagesState==="loading" && <div className="message agent">Carregando histórico…</div>}
          {messagesState==="error" && <div className="message agent">Não consegui carregar esta conversa. Abra de novo em instantes.</div>}
          {messagesState==="ready" && messages.length===0 && <div className="message agent">Conversa sem mensagens gravadas.</div>}
          {messages.map((message,index)=>{
            const day = dayLabel(message.createdAt, now);
            const newDay = index===0 || dayLabel(messages[index-1].createdAt, now)!==day;
            return <Fragment key={`${message.createdAt}-${index}`}>
              {newDay && <div className="day-separator">{day}</div>}
              <div className={`message ${message.role==="customer"?"":"agent"} ${isMediaNote(message)?"media-note":""}`} style={message.role==="suggestion"?{opacity:0.72,borderLeft:"3px solid var(--warn)"}:undefined}>
                {message.role==="suggestion" && <strong style={{display:"block",fontSize:11,color:"var(--warn)",textTransform:"uppercase",letterSpacing:0.4,marginBottom:4}}>Sugestão da IA — não enviada ao cliente</strong>}
                {message.content}
                {message.role==="suggestion" && canCompose && (containsHomologationText(message.content)
                  ? <small style={{display:"block",marginTop:6,color:"var(--warn)"}}>Texto de homologação — não pode ser enviado a um cliente.</small>
                  : <button className="button secondary" style={{marginTop:8}} onClick={()=>insertReply(message.content)}>Usar como rascunho</button>)}
                {message.role==="agent" && message.sentBy && <small className="delivery">Enviada por {message.sentBy} · <b className={message.deliveryStatus ?? "accepted"}>{DELIVERY_LABELS[message.deliveryStatus ?? ""] ?? "Aceita pela Meta"}</b></small>}
                {message.deliveryStatus==="failed" && message.deliveryError && <small className="delivery-error">{message.deliveryError}</small>}
                <time>{new Date(message.createdAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</time>
              </div>
            </Fragment>;
          })}
        </div>
        {newBelow && <button className="new-messages" onClick={()=>{ const el = messagesRef.current; if (el) el.scrollTop = el.scrollHeight; setNewBelow(false); }}>Novas mensagens ↓</button>}
      </div>
      {sendError && <p className="form-error" style={{margin:"0 15px 8px"}}>{sendError}</p>}
      <div className="composer">
        {quickReplies.length>0 && <select aria-label="Respostas rápidas" disabled={!canCompose || sending} value="" onChange={(e)=>{ const reply = quickReplies.find((entry)=>entry.intent===e.target.value); if (reply) insertReply(reply.content); }}>
          <option value="">Respostas rápidas</option>
          {quickReplies.map((reply)=><option key={reply.intent} value={reply.intent}>{reply.label}</option>)}
        </select>}
        <textarea value={draft} disabled={!canCompose || sending} maxLength={4096}
          onChange={(e)=>{setDraft(e.target.value);setSendError(null)}}
          onKeyDown={(e)=>{ if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){ e.preventDefault(); void send(); } }}
          placeholder={composerHint} />
        <button aria-label="Enviar" disabled={!canCompose || sending || !draft.trim()} onClick={()=>void send()}>{sending?"…":"➤"}</button>
      </div>
    </section>
    <aside className="customer-panel">
      <div className="customer-head"><Avatar initials={selected?conversationInitials(selected):"—"} /><h3>{selected?conversationTitle(selected):"—"}</h3><p>{selected ? `${conversationLabel(selected.externalConversationId)} • ${selected.channel}` : "—"}</p></div>
      {selected && <IxcPanel match={ixc} />}
      {/* `key` troca o copiloto inteiro ao mudar de conversa: sem isso a resposta
          de um cliente ficaria na tela ao lado do histórico de outro. */}
      {selected && <Copilot key={conversationKey(selected)} channel={selected.channel} conversationId={selected.externalConversationId} onUse={canCompose ? insertReply : undefined} />}
      {selected && <ConversationAuditPanel audit={audit} />}
      <Info title="Conversa" rows={[
        ["Mensagens",String(selected?.messages ?? 0)],
        ["Última",selected?relativeTime(selected.lastAt):"—"],
        ["Aguardando resposta",selected?.awaitingSince?`há ${relativeTime(selected.awaitingSince)}`:"Não"],
        ["Intenção",selected?.intent?intentLabel(selected.intent):"Não registrada"],
        ["Desfecho",statusLabel],
      ]} />
    </aside>
  </div></main>;
}

/** Usado só pelo AI Training Mode: conversa de treino, sem cliente real do outro lado. */
function ConversationWorkspace({ initial, onResult }: { initial: UiMessage[]; onResult?: (result: AgentResult) => void }) {
  const [messages, setMessages] = useState<UiMessage[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior:"smooth" }), [messages, busy]);
  async function send() {
    const value = input.trim(); if (!value || busy) return;
    const customer: UiMessage = { role:"customer", content:value, time:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) };
    const updated = [...messages, customer]; setMessages(updated); setInput(""); setBusy(true);
    try {
      const response = await fetch("/api/agent", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({message:value,history:updated.map(({role,content})=>({role,content}))}) });
      const result = await response.json() as AgentResult;
      if (!response.ok) throw new Error("Falha na análise");
      setMessages((current) => [...current, { role:"agent", content:result.response, time:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}), result }]);
      onResult?.(result);
    } catch { setMessages((current) => [...current,{role:"agent",content:"Tive uma falha ao consultar as ferramentas. Registrei o contexto e não vou confirmar nenhuma ação que não tenha sido concluída.",time:"agora"}]); }
    finally { setBusy(false); }
  }
  return <>
    <div className="training-messages">
      {messages.map((message,index) => <Message key={index} message={message} />)}
      {busy && <div className="message agent">Estou consultando isso aqui para você…</div>}
      <div ref={endRef} />
    </div>
    <div className="composer"><textarea value={input} onChange={(e)=>setInput(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder="Digite qualquer mensagem como um cliente…"/><button aria-label="Enviar" onClick={()=>void send()}>➤</button></div>
  </>;
}

function Message({ message }: { message: UiMessage }) { const artifacts=message.result?.tools.flatMap(t=>t.artifact?[t.artifact]:[])??[]; return <div className={`message ${message.role==="agent"?"agent":""}`}>{message.content}{artifacts.map((a,i)=><div className="artifact" key={i}><strong>✓ {a.label}</strong><code>{a.value}</code></div>)}<time>{message.time} {message.role==="agent"?"✓✓":""}</time></div>; }
function Info({ title, rows }: { title:string; rows:string[][] }) { return <div className="info-section"><h4>{title}</h4>{rows.map(([a,b])=><div className="info-line" key={a}><span>{a}</span><strong>{b}</strong></div>)}</div>; }

function TrainingMode() {
  const [result,setResult]=useState<AgentResult|null>(null);
  const [accepted,setAccepted]=useState(false);
  return <main className="content"><div className="page-heading"><div><h1>AI Training Mode</h1><p>Converse livremente. A análise é posterior e não muda o pipeline operacional.</p></div><span className="badge blue">Mesmo pipeline da produção</span></div><div className="training-grid">
    <section className="training-chat"><div className="training-header"><div><strong>Cliente de treinamento</strong><p>Gírias, erros, ironia e mudança de assunto são aceitos.</p></div><button className="button secondary" onClick={()=>location.reload()}>Nova conversa</button></div><ConversationWorkspace initial={[]} onResult={(r)=>{setResult(r);setAccepted(false)}} /></section>
    <aside className="analysis-panel"><div className="card-header"><strong>Supervisor de Qualidade</strong><span className="badge green">Automático</span></div>{!result?<div className="analysis-empty">Envie uma mensagem para visualizar intenção, execução, qualidade e a melhor resposta possível.</div>:<Analysis result={result} accepted={accepted} onAccept={()=>setAccepted(true)} />}</aside>
  </div></main>;
}

function Analysis({result,accepted,onAccept}:{result:AgentResult;accepted:boolean;onAccept:()=>void}) { const e=result.evaluation; const scores=[["Naturalidade",e.naturalness],["Precisão",e.precision],["Empatia",e.empathy],["Segurança",e.safety],["Continuidade",e.continuity],["Memória",e.memory],["Novidade",e.noveltyScore*10],["Progresso",e.progressScore*10]] as const; return <>
  <div className="analysis-block"><div className="analysis-main"><div><h4>Intenção detectada</h4><strong>{result.intent}</strong><div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>{result.goal} • confiança {Math.round(result.confidence*100)}%</div></div><div className="score"><span>{e.score}</span></div></div></div>
  <div className="analysis-block"><h4>Estado e execução</h4><div className="analysis-status"><span className="badge blue">{result.state}</span><span className={`badge ${result.actionExecuted?"amber":"green"}`}>{result.actionExecuted?"Ação externa":"Zero ação real"}</span><span className="badge">{result.finalStatus}</span></div><div className="correlation">{result.correlationId}</div></div>
  <div className="analysis-block"><h4>Ferramentas</h4><div className="tool-list">{result.tools.length?result.tools.map(t=><span className="tool-chip" key={t.tool}>{t.status==="completed"?"✓":"!"} {t.tool} • {t.outcome}</span>):<span className="analysis-muted">Nenhuma ferramenta necessária.</span>}</div></div>
  <div className="analysis-block"><h4>Evidências</h4>{result.evidence.length?<div className="evidence-list">{result.evidence.map((evidence)=><div className="evidence-item" key={evidence.id}><strong>{evidence.kind} • {evidence.source}</strong><span>{evidence.summary}</span><small>{evidence.simulated?"Evidência simulada e identificada":"Evidência validada"}</small></div>)}</div>:<p className="analysis-muted">Nenhuma evidência foi produzida; o agente não pode alegar sucesso.</p>}</div>
  <div className="analysis-block"><h4>Transbordo</h4><div className={`handoff-card ${result.handoff.required?"required":""}`}><strong>{result.handoff.required?"Necessário":"Não necessário"}</strong><span>{result.handoff.reason??"O fluxo demonstrativo pode continuar com segurança."}</span>{result.handoff.summary&&<small>{result.handoff.summary}</small>}</div></div>
  <div className="analysis-block"><h4>Avaliação</h4>{scores.map(([label,value])=><div className="score-row" key={label}><div><div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span>{label}</span><strong>{value}</strong></div><div className="mini-bar"><span style={{width:`${value*10}%`}} /></div></div><span>/10</span></div>)}</div>
  <div className="analysis-block"><h4>Resumo e próximo passo</h4><p style={{fontSize:11,lineHeight:1.55,color:"var(--text-2)"}}>{result.conversationSummary}</p><p style={{fontSize:11,lineHeight:1.55}}><strong>Próximo:</strong> {result.nextStep}</p></div>
  <div className="analysis-block"><h4>Resposta considerada perfeita</h4><div className="ideal">{e.idealResponse}</div><p style={{fontSize:11,color:"var(--muted)",lineHeight:1.5}}>{e.suggestion}</p><button className={`button ${accepted?"success":""}`} style={{width:"100%"}} onClick={onAccept}>{accepted?"✓ Melhoria salva como caso aprovado":"Aceitar melhoria"}</button></div>
  </>; }
