"use client";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export interface Toast { id: number; tone: "info" | "error"; text: string }
const Ctx = createContext<{ push: (t: Omit<Toast, "id">) => void }>({ push: () => undefined });
export const useToast = () => useContext(Ctx);

/** Notification PRESENTATION shell: transient messages in a polite live region (errors in an assertive one). There is no per-user notification inbox in the backend (UNAVAILABLE). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]), seq = useRef(0);
  const push = useCallback((t: Omit<Toast, "id">) => { const id = ++seq.current; setItems((x) => [...x.slice(-3), { ...t, id }]); setTimeout(() => setItems((x) => x.filter((y) => y.id !== id)), 6000); }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite" role="status">{items.filter((i) => i.tone === "info").map((i) => <div key={i.id} className="toast">{i.text}</div>)}</div>
      <div className="toasts err" aria-live="assertive" role="alert">{items.filter((i) => i.tone === "error").map((i) => <div key={i.id} className="toast error">{i.text}</div>)}</div>
    </Ctx.Provider>
  );
}
