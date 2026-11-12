"use client";
/**
 * Theme preference: dark (default), light, or the system setting. It is a per-viewer convenience kept in localStorage inside try/catch; the page renders correctly without it.
 * localStorage is used for THIS ONLY (never a token, never data): the ESLint rule that forbids browser storage is switched off for this file alone.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";
const KEY = "twins-theme";
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "dark", toggle: () => undefined });
export const useTheme = () => useContext(Ctx);

export function readStoredTheme(): Theme | null { try { const v = window.localStorage.getItem(KEY); return v === "dark" || v === "light" ? v : null; } catch { return null; } }
function apply(t: Theme): void { document.documentElement.dataset["theme"] = t; }

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => { const stored = readStoredTheme(); const t = stored ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); setTheme(t); apply(t); }, []);
  const toggle = useCallback(() => { setTheme((cur) => { const next: Theme = cur === "dark" ? "light" : "dark"; apply(next); try { window.localStorage.setItem(KEY, next); } catch { /* storage blocked: the choice lasts for this page only */ } return next; }); }, []);
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}
/** Runs before first paint (served with the CSP nonce) so the chosen theme does not flash. Reads one fixed key and nothing else. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;
