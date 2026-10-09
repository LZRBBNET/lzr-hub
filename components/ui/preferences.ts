"use client";

/**
 * Preferências que moram fora do React: tema (no elemento raiz, aplicado pelo
 * script do `layout` antes da primeira pintura), menu recolhido e a tela
 * aberta (no endereço). As três são lidas com `useSyncExternalStore`, que
 * existe para isso: um valor de fora que precisa disparar renderização — e
 * que no servidor tem um padrão fixo, para a hidratação não divergir.
 */
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
export const THEME_KEY = "lzr-theme";
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

function subscribe(callback: () => void) {
  listeners.add(callback);
  // Trocar o tema numa aba passa a valer nas outras: o evento `storage` só
  // chega nas abas que não fizeram a alteração, então elas aplicam aqui.
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY) {
      if (event.newValue === "light" || event.newValue === "dark") document.documentElement.dataset.theme = event.newValue;
      else delete document.documentElement.dataset.theme;
    }
    callback();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(callback); window.removeEventListener("storage", onStorage); };
}

function readTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * "Sistema" é o padrão e é uma opção de verdade, não a ausência de escolha:
 * quem trabalha de dia e de noite quer acompanhar o sistema operacional. Ele é
 * representado pela **ausência** de `data-theme` — aí o `color-scheme: light dark`
 * do CSS decide sozinho.
 */
export function setTheme(next: Theme) {
  try {
    if (next === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, next);
  } catch { /* armazenamento bloqueado: vale nesta aba, só não persiste */ }
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  notify();
}
export const useTheme = () => useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);

const NAV_KEY = "lzr-nav-collapsed";
function readCollapsed() { try { return window.localStorage.getItem(NAV_KEY) === "1"; } catch { return false; } }
export function setNavCollapsed(value: boolean) {
  try { if (value) window.localStorage.setItem(NAV_KEY, "1"); else window.localStorage.removeItem(NAV_KEY); } catch { /* idem */ }
  notify();
}
export const useNavCollapsed = () => useSyncExternalStore(subscribe, readCollapsed, () => false);

/** A tela aberta vai no endereço (`#/funil`): recarregar, voltar e mandar o link funcionam. */
function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}
export const useHash = () => useSyncExternalStore(subscribeHash, () => window.location.hash, () => "");

/** Largura da tela como estado: decide entre painel ao lado e gaveta por cima. No servidor, a resposta é "larga". */
export function useMediaQuery(query: string) {
  const subscribeQuery = useCallback((callback: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", callback);
    return () => list.removeEventListener("change", callback);
  }, [query]);
  return useSyncExternalStore(subscribeQuery,
    () => window.matchMedia(query).matches,
    () => true,
  );
}
