"use client";

/**
 * Peças de tela compartilhadas.
 *
 * Cada módulo tinha a sua cópia de `Heading` e `Metric` — sete versões quase
 * iguais, cada uma com um ícone decorativo diferente — e explicava os próprios
 * limites em parágrafos de `state-card` empilhados antes do dado. O resultado
 * era uma tela que se lia de cima para baixo como um documento, e o número
 * que importava ficava abaixo da dobra.
 *
 * A regra aqui: **o dado vem primeiro, a ressalva fica a um clique.** Nada do
 * que era dito some — "não medido" continua aparecendo como "não medido" —,
 * mas a explicação longa mora em `InfoTip` ou `Limits`, não no caminho.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconKey } from "./icons";

type Tone = "neutral" | "info" | "ok" | "warn" | "bad";

export function Toolbar({ children, actions }: { children?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="toolbar"><div className="toolbar-main">{children}</div>{actions && <div className="toolbar-actions">{actions}</div>}</div>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map(([option, text]) => <button key={option} type="button" aria-pressed={option === value} className={option === value ? "active" : ""} onClick={() => onChange(option)}>{text}</button>)}
  </div>;
}

export function Stats({ children, columns }: { children: React.ReactNode; columns?: number }) {
  return <section className="stats" style={columns ? { ["--stat-cols" as string]: columns } : undefined}>{children}</section>;
}

/**
 * Indicador. `value` nulo é "não medido", escrito como "—" e com o motivo em
 * `hint` — nunca zero, que seria lido como fato.
 */
export function Stat({ label, value, hint, tone = "neutral", icon, info }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone; icon?: IconKey; info?: React.ReactNode }) {
  return <article className={`stat tone-${tone}`}>
    <div className="stat-top">
      <span className="stat-label">{label}{info && <InfoTip label={`Sobre ${label}`}>{info}</InfoTip>}</span>
      {icon && <span className="stat-icon"><Icon name={icon} size={16} /></span>}
    </div>
    <strong className="stat-value">{value}</strong>
    {hint && <small className="stat-hint">{hint}</small>}
  </article>;
}

export function Card({ title, badge, actions, children, className, flush }: { title?: React.ReactNode; badge?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; flush?: boolean }) {
  return <section className={`card ${className ?? ""}`}>
    {(title || actions || badge) && <header className="card-head">
      <div className="card-title">{title && <h3>{title}</h3>}{badge}</div>
      {actions && <div className="card-actions">{actions}</div>}
    </header>}
    <div className={flush ? "card-flush" : "card-content"}>{children}</div>
  </section>;
}

export function Badge({ tone = "neutral", children, dot }: { tone?: Tone; children: React.ReactNode; dot?: boolean }) {
  return <span className={`badge tone-${tone}`}>{dot && <i className="badge-dot" />}{children}</span>;
}

const NOTICE_ICONS: Record<Tone, IconKey> = { neutral: "info", info: "info", ok: "check", warn: "alert", bad: "alert" };

/** Aviso de uma ou duas linhas. Para explicação longa, use `more` — fica recolhida. */
export function Notice({ tone = "info", title, children, action, more }: { tone?: Tone; title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; more?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className={`notice tone-${tone}`} role={tone === "bad" ? "alert" : "status"}>
    <Icon name={NOTICE_ICONS[tone]} size={16} className="notice-icon" />
    <div className="notice-body">
      {title && <strong>{title}</strong>}{title && children ? " " : null}{children}
      {more && <>{" "}<button type="button" className="link-button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? "menos" : "por quê?"}</button></>}
      {more && open && <div className="notice-more">{more}</div>}
    </div>
    {action && <div className="notice-action">{action}</div>}
  </div>;
}

export function Empty({ icon = "info", title, children, action }: { icon?: IconKey; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty">
    <span className="empty-icon"><Icon name={icon} size={20} /></span>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action}
  </div>;
}

/** Esqueleto no lugar de "Carregando…": a tela já mostra a forma do que vem. */
export function Loading({ rows = 3, stats = 0, label = "Carregando" }: { rows?: number; stats?: number; label?: string }) {
  return <div className="loading" role="status" aria-label={label}>
    {stats > 0 && <div className="stats">{Array.from({ length: stats }, (_, i) => <div key={i} className="stat skeleton-block"><span className="skeleton w-40" /><span className="skeleton h-lg w-60" /><span className="skeleton w-80" /></div>)}</div>}
    {rows > 0 && <div className="card skeleton-card">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row"><span className="skeleton w-30" /><span className="skeleton w-70" /></div>)}</div>}
  </div>;
}

export function ErrorState({ children, onRetry }: { children: React.ReactNode; onRetry?: () => void }) {
  return <Notice tone="bad" action={onRetry && <button type="button" className="button secondary small" onClick={onRetry}><Icon name="refresh" size={14} />Tentar de novo</button>}>{children}</Notice>;
}

/**
 * Explicação sob demanda. Abre por clique ou teclado e fecha com Esc ou
 * clicando fora — `title` nativo não serve: demora a aparecer, some ao mover o
 * mouse e não existe no toque.
 */
export function InfoTip({ children, label = "Mais informações" }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return <span className="infotip" ref={ref}>
    <button type="button" className="infotip-button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}><Icon name="info" size={14} /></button>
    {open && <span className="infotip-pop" id={id} role="note">{children}</span>}
  </span>;
}

/**
 * "O que esta tela não mede", recolhido no fim. Antes cada tela abria um cartão
 * inteiro para isso — honesto, mas disputando atenção com o dado real.
 */
export function Limits({ items, title = "O que esta tela ainda não mede" }: { items: Array<[string, React.ReactNode]>; title?: string }) {
  if (!items.length) return null;
  return <details className="limits">
    <summary><Icon name="info" size={15} />{title} <span className="limits-count">{items.length}</span><Icon name="chevron-down" size={15} className="limits-chevron" /></summary>
    <dl>{items.map(([term, why]) => <div key={term}><dt>{term}</dt><dd>{why}</dd></div>)}</dl>
  </details>;
}

/** Linha de lista com título, detalhe e valor à direita. */
export function Row({ title, detail, value, children, onClick, active }: { title: React.ReactNode; detail?: React.ReactNode; value?: React.ReactNode; children?: React.ReactNode; onClick?: () => void; active?: boolean }) {
  const body = <>
    <div className="row-main"><strong>{title}</strong>{detail && <span>{detail}</span>}{children}</div>
    {value !== undefined && <div className="row-value">{value}</div>}
  </>;
  return onClick
    ? <button type="button" className={`row clickable ${active ? "active" : ""}`} onClick={onClick}>{body}</button>
    : <div className="row">{body}</div>;
}

/** Barra proporcional com o número escrito ao lado: barra sozinha não é lida por leitor de tela. */
export function Bar({ label, detail, value, max, display }: { label: React.ReactNode; detail?: React.ReactNode; value: number; max: number; display?: React.ReactNode }) {
  const width = max > 0 ? Math.max(2, Math.round(value / max * 100)) : 0;
  return <div className="bar-row">
    <div className="bar-text"><strong>{label}</strong>{detail && <span>{detail}</span>}</div>
    <div className="bar-track"><span style={{ width: `${width}%` }} /></div>
    <b>{display ?? value.toLocaleString("pt-BR")}</b>
  </div>;
}

/**
 * Diálogo modal sobre o `<dialog>` nativo: foco preso, Esc e leitura por leitor
 * de tela vêm do navegador. `dismissible = false` é para o que não pode ser
 * fechado sem decidir — Esc e clique fora são ignorados.
 */
export function Modal({ open, title, onClose, children, footer, dismissible = true, side = false, wide = false }: { open: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; dismissible?: boolean; side?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // O navegador põe o foco no primeiro botão — o "Fechar". Quem marca um
      // campo com `data-autofocus` quer começar digitando ali.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return null;
  return <dialog ref={ref} className={`modal ${side ? "side" : ""} ${wide ? "wide" : ""}`}
    onCancel={(event) => { event.preventDefault(); if (dismissible) onClose(); }}
    onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose(); }}>
    <div className="modal-box">
      <header className="modal-head"><h2>{title}</h2>{dismissible && <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="x" /></button>}</header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </div>
  </dialog>;
}

/* ------------------------------------------------------------------ toasts --- */

type Toast = { id: number; tone: Tone; text: string };
const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);

/**
 * Confirmação passageira de ação ("Versão 3 salva"). Só para o que é
 * confirmação: resultado que a pessoa precisa ler com calma — senha gerada,
 * resposta do IXC — continua na tela, onde não some sozinho.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((text: string, tone: Tone = "ok") => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current.slice(-2), { id, tone, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === "bad" ? 7000 : 4000);
  }, []);
  return <ToastContext.Provider value={push}>
    {children}
    <div className="toasts" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast tone-${toast.tone}`}><Icon name={toast.tone === "bad" || toast.tone === "warn" ? "alert" : "check"} size={16} />{toast.text}</div>)}</div>
  </ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);

/* ----------------------------------------------------------------- formatos --- */

export const money = (value: number) => `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const count = (value: number) => value.toLocaleString("pt-BR");
export const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
export function relativeTime(iso: string, now = Date.now()) {
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "—";
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}
export const dateTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};
export const dateOnly = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString("pt-BR");
};

/** Cor estável por nome: a mesma pessoa tem sempre a mesma cor de avatar. */
export function avatarHue(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}
export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).map((part) => Array.from(part));
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : (parts[0] ?? []).slice(0, 2).join("");
  return letters.toUpperCase() || "?";
}
export function Avatar({ name, label, size = "md" }: { name: string; label?: string; size?: "sm" | "md" | "lg" }) {
  return <span className={`avatar ${size} hue-${avatarHue(name)}`} aria-hidden="true">{label ?? initialsOf(name)}</span>;
}

export const PERIODS_SHORT = [["24h", "24 h"], ["7d", "7 dias"], ["30d", "30 dias"]] as const;
