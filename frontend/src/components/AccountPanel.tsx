"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PublicUser } from "@twins/api-contracts";
import { signOut } from "@/api/hooks";
import { Button, PageHead, Panel } from "@/ui/primitives";
import { PlannedPanel } from "@/ui/state";
import { useTheme } from "./ThemeProvider";

export function AccountPanel({ user }: { user: PublicUser }) {
  const { theme, toggle } = useTheme(), qc = useQueryClient(), router = useRouter(), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  async function out() { setBusy(true); setErr(null); try { await signOut(); qc.clear(); router.replace("/login"); router.refresh(); } catch { setErr("Sign-out did not complete. You are still signed in; please try again."); setBusy(false); } }
  return (
    <>
      <PageHead eyebrow="Operate" title="Account"><p>Your sign-in, theme and session.</p></PageHead>
      <div className="grid g2">
        <Panel aria-labelledby="who-h">
          <h2 id="who-h" style={{ marginBottom: 10 }}>You</h2>
          <dl className="kv"><dt>Name</dt><dd>{user.displayName ?? "—"}</dd><dt>Email</dt><dd>{user.email}</dd><dt>Role</dt><dd data-testid="account-role">{user.role}</dd><dt>Status</dt><dd>{user.isActive ? "Active" : "Inactive"}</dd></dl>
        </Panel>
        <Panel aria-labelledby="pref-h">
          <h2 id="pref-h" style={{ marginBottom: 10 }}>Preferences and session</h2>
          <div style={{ display: "grid", gap: 12 }}>
            <div className="hrow"><span>Theme: <b>{theme === "dark" ? "Dark" : "Light"}</b></span><Button onClick={toggle}>Switch to {theme === "dark" ? "light" : "dark"}</Button></div>
            <div className="hrow"><span className="small muted">Ends this session on this device.</span><Button variant="danger" onClick={out} disabled={busy}>Sign out</Button></div>
            {err && <div role="alert" className="small" style={{ color: "var(--alert)" }}>{err}</div>}
          </div>
        </Panel>
      </div>
      <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
        <PlannedPanel title="Change password">The backend supports changing your password (and signs your other devices out), but the browser screen for it is not part of this stage.</PlannedPanel>
        <PlannedPanel title="Registration, password reset, email verification" kind="UNAVAILABLE">The backend offers none of these. Accounts are created by an administrator.</PlannedPanel>
      </div>
    </>
  );
}
