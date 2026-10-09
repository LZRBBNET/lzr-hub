"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canSee, navigation, parseView, sectionOf, tabOf, type NavSection, type View } from "@/lib/platform/navigation";
import { Icon, type IconKey } from "@/components/ui/icons";
import { Avatar, Modal, ToastProvider, Segmented } from "@/components/ui/kit";
import { setNavCollapsed, setTheme, useHash, useNavCollapsed, useTheme, type Theme } from "@/components/ui/preferences";
import { HomeModule } from "@/components/modules/home";
import { AttendanceModule } from "@/components/modules/attendance";
import { TrainingModule } from "@/components/modules/training";
import { Customer360Module } from "@/components/modules/customer360";
import { SupportModule } from "@/components/modules/support";
import { BillingModule } from "@/components/modules/billing";
import { SalesModule } from "@/components/modules/sales";
import { IntelligenceModule } from "@/components/modules/intelligence";
import { AdminModule } from "@/components/modules/admin";
import { QualityModule } from "@/components/modules/quality";
import { InternalChatModule } from "@/components/modules/internal-chat";
import { ContractAuditModule } from "@/components/modules/contract-audit";

type SessionState = { authenticated: boolean; authRequired: boolean; mustChangePassword?: boolean; permissions?: string[]; user?: { name: string; email: string; role: string } };
/** O que uma tela pode pedir a outra ao navegar — hoje, abrir uma conversa específica. */
export type NavIntent = { conversation?: string };
export type Navigate = (view: View, intent?: NavIntent) => void;

/**
 * Só redireciona depois que a sessão é consultada no cliente. A primeira
 * renderização é sempre a aplicação normal — o HTML inicial é verificado pelos
 * testes do ambiente de demonstração e não pode virar uma tela de carregamento.
 */
function useSession() {
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

/** Telas que ocupam a altura inteira: título e abas roubariam espaço da conversa. */
const FULL_BLEED: View[] = ["atendimento", "chat-interno", "training"];
const AWAITING_POLL_MS = 30_000;

export function LzrHubApp({ ixcMode = "disabled" }: { ixcMode?: string }) {
  const hash = useHash();
  const view: View = parseView(hash) ?? "dashboard";
  const [intent, setIntent] = useState<NavIntent>({});
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [awaitingFromInbox, setAwaitingFromInbox] = useState<number | null>(null);
  const [awaitingPolled, setAwaitingPolled] = useState<{ count: number; oldest: string | null }>({ count: 0, oldest: null });
  const collapsed = useNavCollapsed();
  const session = useSession();
  const user = session?.user;
  const permissions = session?.authenticated ? session.permissions ?? [] : null;
  // Senha gerada pelo sistema: a pessoa define a dela antes de usar qualquer tela.
  const forced = session?.mustChangePassword === true;
  // Só existe dado real quando o IXC está de fato ligado. Fora disso a tela
  // continua avisando que é demonstração, que é a verdade nesse modo.
  const live = ixcMode === "staging-readonly" || ixcMode === "production-readonly";

  const navigate = useCallback<Navigate>((next, nextIntent = {}) => {
    setIntent(nextIntent); setNavOpen(false);
    const target = `#/${next}`;
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  // Tela sem permissão (link antigo, perfil trocado) cai na primeira que a pessoa pode ver.
  const section = sectionOf(view);
  const tabs = section.tabs.filter((tab) => canSee(tab, permissions));
  const tab = tabOf(view);
  const blocked = !canSee(tab, permissions);
  const firstAllowed = tabs[0]?.id;
  useEffect(() => { if (blocked) window.location.hash = `#/${firstAllowed ?? "dashboard"}`; }, [blocked, firstAllowed]);

  // Clientes esperando resposta, de qualquer tela: na caixa de entrada a própria
  // tela informa (consulta a cada 5 s); fora dela, uma consulta leve a cada 30 s.
  const inInbox = view === "atendimento";
  useEffect(() => {
    if (inInbox) return;
    let active = true;
    const load = () => fetch("/api/conversations").then((response) => response.ok ? response.json() : null)
      .then((payload: { items?: Array<{ awaitingSince?: string }> } | null) => {
        if (!active || !payload?.items) return;
        const since = payload.items.flatMap((item) => item.awaitingSince ? [item.awaitingSince] : []).sort();
        setAwaitingPolled({ count: since.length, oldest: since[0] ?? null });
      })
      .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, AWAITING_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [inInbox]);
  const awaiting = inInbox ? awaitingFromInbox ?? 0 : awaitingPolled.count;

  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (baseTitle.current === null) baseTitle.current = document.title.replace(/^\(\d+\)\s*/, "");
    // O número na aba avisa de cliente esperando mesmo com o atendente em outra janela.
    document.title = awaiting ? `(${awaiting}) ${baseTitle.current}` : baseTitle.current;
  }, [awaiting]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen((value) => !value); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function signOut() {
    fetch("/api/auth/logout", { method: "POST" })
      .then(() => { window.location.href = "/login"; })
      .catch(() => { window.location.href = "/login"; });
  }

  const fullBleed = FULL_BLEED.includes(view);
  return <ToastProvider>
    <div className={`app-shell ${collapsed ? "nav-collapsed" : ""} ${navOpen ? "nav-open" : ""}`}>
      <Sidebar view={view} permissions={permissions} awaiting={awaiting} collapsed={collapsed} onNavigate={navigate} onClose={() => setNavOpen(false)} />
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      {(changingPassword || forced) && <PasswordDialog forced={forced} onClose={() => { setChangingPassword(false); if (forced) window.location.reload(); }} />}
      <CommandPalette open={paletteOpen} permissions={permissions} onClose={() => setPaletteOpen(false)} onNavigate={navigate}
        onPassword={user ? () => setChangingPassword(true) : undefined} onSignOut={user ? signOut : undefined} />
      <div className={`workspace ${fullBleed ? "bleed" : ""}`}>
        <header className="topbar">
          <button type="button" className="icon-button nav-toggle" onClick={() => setNavOpen(true)} aria-label="Abrir menu"><Icon name="menu" /></button>
          <nav className="crumbs" aria-label="Você está em"><span>{section.group}</span><Icon name="chevron-right" size={14} /><strong>{section.label}</strong></nav>
          <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={16} /><span>Ir para…</span><kbd>Ctrl K</kbd>
          </button>
          <EnvironmentChip live={live} />
          <UserMenu user={user} onPassword={() => setChangingPassword(true)} onSignOut={signOut} />
        </header>
        {!live && <div className="demo-banner" role="status"><strong>Ambiente de demonstração</strong> — nenhuma ação real é executada</div>}
        <main className={`page ${fullBleed ? "full-bleed" : ""}`} id="conteudo">
          {!fullBleed && <div className="page-head">
            <div><h1>{section.label}</h1><p>{tab.description}</p></div>
          </div>}
          {!fullBleed && tabs.length > 1 && <nav className="tabs" aria-label={`Seções de ${section.label}`}>
            {tabs.map((item) => <a key={item.id} href={`#/${item.id}`} className={item.id === view ? "active" : ""} aria-current={item.id === view ? "page" : undefined}
              onClick={(event) => { event.preventDefault(); navigate(item.id); }}>{item.label}</a>)}
          </nav>}
          {!blocked && <Screen view={view} intent={intent} awaiting={awaitingPolled} onNavigate={navigate} onAwaiting={setAwaitingFromInbox} />}
        </main>
      </div>
    </div>
  </ToastProvider>;
}

function Screen({ view, intent, awaiting, onNavigate, onAwaiting }: { view: View; intent: NavIntent; awaiting: { count: number; oldest: string | null }; onNavigate: Navigate; onAwaiting: (count: number) => void }) {
  switch (view) {
    case "dashboard": return <HomeModule awaiting={awaiting} onNavigate={onNavigate} />;
    case "atendimento": return <AttendanceModule initialConversation={intent.conversation} onAwaiting={onAwaiting} />;
    case "training": return <TrainingModule />;
    case "clientes": return <Customer360Module />;
    case "chat-interno": return <InternalChatModule />;
    case "auditoria-contratos": return <ContractAuditModule />;
    case "monitoramento": case "massivas": case "mapa-alertas": case "chamados": return <SupportModule view={view} onNavigate={onNavigate} />;
    case "cobranca": case "acoes-cobranca": case "regua": return <BillingModule view={view} />;
    case "comercial": case "funil": case "metas": return <SalesModule view={view} />;
    case "churn": case "conhecimento": case "respostas": return <IntelligenceModule view={view} />;
    case "avaliacoes": case "prompts": return <QualityModule view={view} onNavigate={onNavigate} />;
    case "usuarios": case "equipes": case "auditoria": case "integracoes": case "filas": return <AdminModule view={view} />;
  }
}

/* ---------------------------------------------------------------- menu --- */

function Sidebar({ view, permissions, awaiting, collapsed, onNavigate, onClose }: { view: View; permissions: string[] | null; awaiting: number; collapsed: boolean; onNavigate: Navigate; onClose: () => void }) {
  const current = sectionOf(view).id;
  const sections = navigation.filter((section) => section.tabs.some((tab) => canSee(tab, permissions)));
  const groups = [...new Set(sections.map((section) => section.group))];
  return <aside className="sidebar" aria-label="Menu principal">
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">L</div>
      <div className="brand-copy"><strong>LZR HUB</strong><small>BBNET</small></div>
      <button type="button" className="icon-button nav-close" onClick={onClose} aria-label="Fechar menu"><Icon name="x" /></button>
    </div>
    {/* Recolhido, o menu vira só ícones: o `title` e o `aria-label` são o que
        impede isso de virar 14 desenhos indecifráveis. */}
    <nav className="nav-scroll">
      {groups.map((group) => <div className="nav-group" key={group}>
        <div className="nav-label">{group}</div>
        {sections.filter((section) => section.group === group).map((section) => {
          const target = (section.tabs.find((tab) => canSee(tab, permissions)) ?? section.tabs[0]).id;
          const badge = section.id === "atendimentos" && awaiting > 0 ? awaiting : null;
          return <a key={section.id} href={`#/${target}`} className={`nav-item ${current === section.id ? "active" : ""}`}
            title={collapsed ? section.label : undefined} aria-current={current === section.id ? "page" : undefined}
            onClick={(event) => { event.preventDefault(); onNavigate(target); }}>
            <Icon name={section.icon} size={18} />
            <span className="nav-text">{section.label}</span>
            {badge !== null && <span className="nav-badge" aria-label={`${badge} aguardando resposta`}>{badge}</span>}
          </a>;
        })}
      </div>)}
    </nav>
    <button type="button" className="nav-collapse" onClick={() => setNavCollapsed(!collapsed)} aria-label={collapsed ? "Expandir menu" : "Recolher menu"} title={collapsed ? "Expandir menu" : "Recolher menu"}>
      <Icon name={collapsed ? "chevron-right" : "chevron-left"} size={16} /><span className="nav-text">Recolher menu</span>
    </button>
  </aside>;
}

/**
 * Um selo só para o ambiente. Antes eram três lugares dizendo a mesma coisa —
 * subtítulo da barra, pílula verde e uma faixa azul em toda tela — e a faixa
 * ainda afirmava "nenhuma escrita é executada no ERP", que deixou de ser
 * verdade quando o catálogo de escrita foi ligado.
 */
function EnvironmentChip({ live }: { live: boolean }) {
  return live
    ? <span className="env-chip live" title="Lendo a base do IXC. Escrita só pelas operações do catálogo, para quem tem permissão — e tudo fica na auditoria."><i />IXC conectado</span>
    : <span className="env-chip demo" title="Dados de demonstração; nada sai do sistema."><i />Homologação protegida</span>;
}

const THEME_OPTIONS: ReadonlyArray<readonly [Theme, string]> = [["system", "Sistema"], ["light", "Claro"], ["dark", "Escuro"]];

function UserMenu({ user, onPassword, onSignOut }: { user?: { name: string; email: string; role: string }; onPassword: () => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const theme = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const name = user?.name ?? "Admin Demonstração";
  return <div className="user-menu" ref={ref}>
    <button type="button" className="user-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu">
      <Avatar name={name} size="sm" /><span className="user-name">{name.split(" ")[0]}</span><Icon name="chevron-down" size={14} />
    </button>
    {open && <div className="menu-pop" role="menu">
      <div className="menu-identity"><Avatar name={name} /><div><strong>{name}</strong><span>{user ? `${user.role} · ${user.email}` : "Usuário sintético"}</span></div></div>
      <div className="menu-section"><span className="menu-label">Tema</span><Segmented label="Tema" value={theme} options={THEME_OPTIONS} onChange={setTheme} /></div>
      {user && <>
        <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onPassword(); }}><Icon name="key" size={16} />Trocar minha senha</button>
        <button type="button" role="menuitem" className="menu-item" onClick={onSignOut}><Icon name="logout" size={16} />Sair</button>
      </>}
    </div>}
  </div>;
}

/* ------------------------------------------------------ busca de telas --- */

type Command = { id: string; label: string; hint: string; icon: IconKey; run: () => void; keywords: string };

/**
 * Ctrl+K: ir para qualquer tela digitando o nome. Com 14 seções e abas dentro
 * delas, procurar no menu é mais lento que escrever "régua".
 */
function CommandPalette({ open, permissions, onClose, onNavigate, onPassword, onSignOut }: { open: boolean; permissions: string[] | null; onClose: () => void; onNavigate: Navigate; onPassword?: () => void; onSignOut?: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const commands = useMemo<Command[]>(() => {
    const screens = navigation.flatMap((section: NavSection) => section.tabs.filter((tab) => canSee(tab, permissions)).map((tab) => ({
      id: tab.id, icon: section.icon,
      label: section.tabs.length > 1 ? `${section.label} › ${tab.label}` : section.label,
      hint: tab.description, keywords: `${section.group} ${section.label} ${tab.label} ${tab.description}`,
      run: () => onNavigate(tab.id),
    })));
    const actions: Command[] = [
      { id: "theme-light", icon: "sun", label: "Tema claro", hint: "Aparência", keywords: "tema claro light", run: () => setTheme("light") },
      { id: "theme-dark", icon: "moon", label: "Tema escuro", hint: "Aparência", keywords: "tema escuro dark", run: () => setTheme("dark") },
      { id: "theme-system", icon: "monitor", label: "Tema do sistema", hint: "Aparência", keywords: "tema sistema automatico", run: () => setTheme("system") },
    ];
    if (onPassword) actions.push({ id: "password", icon: "key", label: "Trocar minha senha", hint: "Conta", keywords: "senha password", run: onPassword });
    if (onSignOut) actions.push({ id: "logout", icon: "logout", label: "Sair", hint: "Conta", keywords: "sair logout", run: onSignOut });
    return [...screens, ...actions];
  }, [permissions, onNavigate, onPassword, onSignOut]);

  const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const results = commands.filter((command) => terms.every((term) => normalize(`${command.label} ${command.keywords}`).includes(term))).slice(0, 12);
  const active = Math.min(index, Math.max(results.length - 1, 0));

  function close() { setQuery(""); setIndex(0); onClose(); }
  function choose(command: Command | undefined) { if (!command) return; close(); command.run(); }

  return <Modal open={open} title="Ir para" onClose={close}>
    <div className="palette">
      <label className="palette-input"><Icon name="search" size={18} />
        <input data-autofocus value={query} placeholder="Digite uma tela ou ação…" aria-label="Buscar tela ou ação"
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setIndex(Math.min(active + 1, results.length - 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setIndex(Math.max(active - 1, 0)); }
            if (event.key === "Enter") { event.preventDefault(); choose(results[active]); }
          }} />
      </label>
      <ul className="palette-list" role="listbox" aria-label="Resultados">
        {results.length === 0 && <li className="palette-empty">Nada encontrado para “{query}”.</li>}
        {results.map((command, position) => <li key={command.id} role="option" aria-selected={position === active}>
          <button type="button" className={position === active ? "active" : ""} onMouseEnter={() => setIndex(position)} onClick={() => choose(command)}>
            <Icon name={command.icon} size={16} /><span><strong>{command.label}</strong><small>{command.hint}</small></span>
          </button>
        </li>)}
      </ul>
      <p className="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> navegar · <kbd>Enter</kbd> abrir · <kbd>Esc</kbd> fechar</p>
    </div>
  </Modal>;
}

/* ---------------------------------------------------------------- senha --- */

/**
 * Troca da própria senha. Fica no menu da pessoa, não na Administração — um
 * "Somente leitura" também precisa conseguir trocar a sua, sem depender de
 * alguém resetar por ele.
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
  return <Modal open title={forced ? "Defina a sua senha" : "Trocar minha senha"} onClose={onClose} dismissible={!forced}
    footer={done
      ? <button className="button" onClick={onClose}>{forced ? "Entrar" : "Pronto"}</button>
      : <button className="button" disabled={busy || !current || !next} onClick={() => void submit()}>{busy ? "Trocando…" : "Trocar senha"}</button>}>
    {done
      ? <div className="stack"><p><strong>Senha trocada.</strong></p><p className="muted">As suas outras sessões foram encerradas — se alguém estava logado na sua conta em outro lugar, perdeu o acesso agora. Esta continua valendo.</p></div>
      : <form className="stack" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {forced && <p className="muted">A senha que você usou foi gerada pelo sistema e um administrador a conhece. Defina a sua para continuar.</p>}
          <label className="field"><span>{forced ? "Senha que você recebeu" : "Senha atual"}</span><input type="password" autoComplete="current-password" value={current} onChange={(event) => { setCurrent(event.target.value); setMessage(null); }} /></label>
          <label className="field"><span>Nova senha</span><input type="password" autoComplete="new-password" placeholder="mínimo 10 caracteres" value={next} onChange={(event) => setNext(event.target.value)} /></label>
          <label className="field"><span>Repita a nova senha</span><input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
          {message && <p className="form-error">{message}</p>}
          <p className="hint">Pedimos a senha atual de propósito: sem isso, um cookie roubado bastaria para trancar você fora da própria conta.</p>
          <button type="submit" hidden />
        </form>}
  </Modal>;
}
