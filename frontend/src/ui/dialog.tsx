"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./primitives";

/**
 * Modal dialog on the native <dialog> element: the browser traps focus, closes on Escape, makes the page behind inert and restores focus to the opener.
 * `onClose` fires for Escape and the close button alike.
 */
export function Dialog({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: string; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} className="panel dlg" aria-labelledby="dlg-title" onClose={onClose} onCancel={onClose}>
      <h2 id="dlg-title" style={{ marginBottom: 10 }}>{title}</h2>
      <div className="small tx2" style={{ marginBottom: 16 }}>{children}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>{actions}<Button onClick={onClose}>Close</Button></div>
    </dialog>
  );
}
