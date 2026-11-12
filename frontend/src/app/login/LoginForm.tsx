"use client";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { apiFetch } from "@/api/client";
import { ApiError } from "@/state/dataState";
import { Banner, Button, Field, Panel } from "@/ui/primitives";

// The browser bundle runs under a strict CSP: without `jitless`, Zod probes `new Function` and the browser reports a (caught) script-src violation.
z.config({ jitless: true });
const Form = z.object({ email: z.string().trim().min(3, "Enter your email address").max(254), password: z.string().min(1, "Enter your password").max(1024) });

/**
 * Sign-in. The backend supports sign-in only: no self-registration (closed by default), no password reset, no email verification: none is offered here.
 * Accounts are created by an administrator. Wrong credentials and a lockout look identical to the browser on purpose.
 */
export function LoginForm({ expired }: { expired: boolean }) {
  const router = useRouter(), qc = useQueryClient();
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({}), [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMessage(null);
    const data = new FormData(e.currentTarget), parsed = Form.safeParse({ email: data.get("email"), password: data.get("password") });
    if (!parsed.success) { const f = parsed.error.flatten().fieldErrors; setErrors({ ...(f.email?.[0] ? { email: f.email[0] } : {}), ...(f.password?.[0] ? { password: f.password[0] } : {}) }); return; }
    setErrors({}); setBusy(true);
    try { await apiFetch("/api/auth/login", { method: "POST", body: parsed.data }); qc.clear(); router.replace("/"); router.refresh(); }
    catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setMessage(status === 429 ? "Too many attempts. Please wait a few minutes and try again." : status === 503 ? "The service is temporarily unavailable. Please try again shortly." : "Sign-in failed. Check your details, or try again later.");
    } finally { setBusy(false); }
  }
  return (
    <main className="login" id="main">
      <Panel aria-labelledby="signin-title">
        <div className="brand" style={{ paddingBottom: 12 }}><i aria-hidden="true">T</i><div><b>TWINS</b></div></div>
        <h1 id="signin-title" style={{ marginBottom: 6 }}>Sign in</h1>
        <p className="small muted" style={{ margin: "0 0 16px" }}>Private research desk. Accounts are created by an administrator.</p>
        {expired && <div style={{ marginBottom: 12 }}><Banner tone="info" label="Session ended">Please sign in again.</Banner></div>}
        <form onSubmit={submit} noValidate style={{ display: "grid", gap: 14 }}>
          <Field id="email" name="email" label="Email" type="email" autoComplete="username" error={errors.email ?? null} />
          <Field id="password" name="password" label="Password" type="password" autoComplete="current-password" error={errors.password ?? null} />
          {message && <div role="alert" data-testid="login-error" className="small" style={{ color: "var(--alert)" }}>{message}</div>}
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
        </form>
        <p className="xs muted" style={{ margin: "16px 0 0" }}>Paper trading only. No live trading is available.</p>
      </Panel>
    </main>
  );
}
