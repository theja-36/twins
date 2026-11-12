import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type BtnVariant = "default" | "primary" | "ghost" | "danger";
export function Button({ variant = "default", className = "", type = "button", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return <button type={type} className={`btn ${variant === "default" ? "" : variant} ${className}`.trim()} {...p} />;
}
export function IconButton({ label, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className="iconbtn" aria-label={label} title={label} {...p}>{children}</button>;
}
/** A labelled input. The label is always real text bound to the control; the error is announced and linked with aria-describedby. */
export function Field({ id, label, hint, error, ...p }: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string; error?: string | null }) {
  const desc = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={desc} {...p} />
      {hint && <div id={`${id}-hint`} className="xs muted">{hint}</div>}
      {error && <div id={`${id}-err`} className="xs" role="alert" style={{ color: "var(--alert)" }}>{error}</div>}
    </div>
  );
}
export function Panel({ children, flat = false, className = "", ...p }: { children: ReactNode; flat?: boolean; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return <section className={`panel ${flat ? "flat" : ""} ${className}`.trim()} {...p}>{children}</section>;
}
export function Banner({ tone = "warn", label, children }: { tone?: "warn" | "info"; label: string; children: ReactNode }) {
  return <div className={`banner ${tone === "info" ? "info" : ""}`} role="note"><b>{label}</b><span>{children}</span></div>;
}
export function PageHead({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return <div className="pagehead"><div>{eyebrow && <span className="up">{eyebrow}</span>}<h1 id="page-title">{title}</h1>{children}</div></div>;
}
