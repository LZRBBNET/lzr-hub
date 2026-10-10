/**
 * Ícones do sistema, em SVG de traço.
 *
 * Antes eram caracteres Unicode (⌂ ◫ ◎ ⌁ ▣ ≋ ⚟ ♟ ⚿) — cada fonte desenha esses
 * glifos de um jeito, dois deles se repetiam no menu e nenhum dizia o que a
 * tela era. SVG inline herda a cor do texto (`currentColor`), não depende de
 * fonte nem de biblioteca, e escala com o tamanho da letra.
 */
import type { IconName } from "@/lib/platform/navigation";

type Name = IconName
  | "search" | "menu" | "chevron-left" | "chevron-right" | "chevron-down" | "x" | "plus" | "refresh" | "send"
  | "sun" | "moon" | "monitor" | "logout" | "key" | "info" | "alert" | "check" | "clock" | "phone"
  | "bot" | "panel" | "filter" | "external" | "download" | "arrow-left" | "copy" | "dots" | "bell" | "bell-off" | "hand" | "keyboard";

const PATHS: Record<Name, React.ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></>,
  chat: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9.5h8M8 12.5h5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.8c1.8.7 3 2.4 3.5 5.2" /></>,
  team: <><path d="M3 6h12v8H8l-3 3v-3H3z" /><path d="M15 9h6v8h-2v3l-3-3h-4v-3" /></>,
  network: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5M12 12l-6 5.4M12 12l6 5.4" /></>,
  ticket: <><path d="M4 7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v3a2 2 0 0 0 0 4v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-4z" /><path d="M14 6v12" strokeDasharray="2 2" /></>,
  wallet: <><path d="M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M4 7l11-3v3" /><path d="M16 13.5h2" /></>,
  trending: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  churn: <><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></>,
  sparkles: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  flask: <><path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path d="M7.5 15h9" /></>,
  book: <><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z" /><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3" /><path d="M8 7h8" /></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="1.5" /><path d="M9 4V3h6v1M9 4h6v2H9z" /><path d="M8.5 12.5l2.3 2.3 4.7-4.6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  "chevron-left": <path d="M15 5l-7 7 7 7" />,
  "chevron-right": <path d="M9 5l7 7-7 7" />,
  "chevron-down": <path d="M5 9l7 7 7-7" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></>,
  send: <><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></>,
  logout: <><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5" /><path d="M10 16l-4-4 4-4M6 12h10" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  alert: <><path d="M12 3.5L2.5 20h19z" /><path d="M12 10v4.5M12 17.5h.01" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  phone: <path d="M5 3.5h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.6 6.6l1.4-2.3 4.5 1.8V19a1.5 1.5 0 0 1-1.5 1.5A16.5 16.5 0 0 1 3.5 5 1.5 1.5 0 0 1 5 3.5z" />,
  bot: <><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M15 4v16" /></>,
  filter: <path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" />,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  download: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  "arrow-left": <path d="M19 12H5M11 6l-6 6 6 6" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  dots: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  "bell-off": <><path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8" /><path d="M10 20.5a2 2 0 0 0 4 0" /><path d="M3 3l18 18" /></>,
  hand: <><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11" /><path d="M11 10V4.5a1.5 1.5 0 0 1 3 0V11" /><path d="M14 10.5V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7.5-6.5 7.5-2.5 0-4-1.2-5.3-3.2L3.5 14a1.6 1.6 0 0 1 2.6-1.8L8 14" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="1.5" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10" /></>,
};

export type { Name as IconKey };

export function Icon({ name, size = 18, className }: { name: Name; size?: number; className?: string }) {
  return <svg className={className ? `icon ${className}` : "icon"} width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {PATHS[name]}
  </svg>;
}
