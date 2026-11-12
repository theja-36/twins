"use client";
/**
 * The application shell: desktop rail, mobile bottom navigation, topbar (breadcrumbs, account selector, notifications, theme, role), safety strip and page container.
 * Navigation comes from the role registry; the role is shown, never trusted for access (the backend authorises every request).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import type { PublicUser } from "@twins/api-contracts";
import { useSession } from "@/api/hooks";
import { breadcrumbFor, mobileNavFor, navFor } from "@/nav/registry";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icons";
import { IconButton } from "@/ui/primitives";
import { PlannedPanel } from "@/ui/state";
import { AccountSelector } from "./AccountSelector";
import { UserCacheGuard } from "./Providers";
import { useTheme } from "./ThemeProvider";

const isCurrent = (path: string, href: string): boolean => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

export function Shell({ initialUser, children }: { initialUser: PublicUser; children: ReactNode }) {
  const user = useSession(initialUser), path = usePathname(), { theme, toggle } = useTheme(), [bell, setBell] = useState(false);
  const admin = user.role === "ADMIN", crumbs = breadcrumbFor(path, user.role);
  useEffect(() => { document.documentElement.dataset["role"] = admin ? "admin" : "trader"; return () => { delete document.documentElement.dataset["role"]; }; }, [admin]);
  return (
    <>
      <UserCacheGuard userId={user.id} />
      <a className="skip" href="#main">Skip to content</a>
      <div className="app">
        <aside className="rail" aria-label="Primary">
          <div className="brand"><i aria-hidden="true">T</i><div><b>TWINS</b>{admin && <small>Administration console</small>}</div></div>
          {navFor(user.role).map((g) => (
            <div className="ws" key={g.workspace ?? "home"}>
              {g.workspace && <span className="up" id={`ws-${g.workspace}`}>{g.workspace}</span>}
              <nav className="nav" aria-label={g.workspace ? g.workspace[0] + g.workspace.slice(1).toLowerCase() : "Home"}>
                {g.items.map((s) => <Link key={s.path} href={s.path} title={s.title} aria-current={isCurrent(path, s.path) ? "page" : undefined}><Icon name={s.icon} /><span>{s.title}</span></Link>)}
              </nav>
            </div>
          ))}
          <div className="foot"><div>{user.displayName ?? user.email}</div><div className="xs">{admin ? "ADMIN" : "TRADER"}</div></div>
        </aside>
        <div className="main">
          <header className="top">
            <nav aria-label="Breadcrumb"><ol className="crumbs crumb">{crumbs.map((c, i) => <li key={c.label} aria-current={i === crumbs.length - 1 ? "page" : undefined}>{i === crumbs.length - 1 ? <b>{c.label}</b> : c.label}</li>)}</ol></nav>
            <span className="sp" />
            {!admin && <Suspense fallback={null}><AccountSelector /></Suspense>}
            <span className="rolechip" data-testid="role-chip">{admin ? "Administrator" : "Trader"}</span>
            <IconButton label="Notifications" onClick={() => setBell(true)}><Icon name="bell" /></IconButton>
            <IconButton label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={toggle}><Icon name="sun" /></IconButton>
            <Link className="iconbtn" href="/account" aria-label="Account"><Icon name="operate" /></Link>
          </header>
          <div className="safety" role="status"><span className="dot" aria-hidden="true" /><span><b>Paper trading only.</b> No live broker is connected and live trading is disabled. Data shown here is labelled FIXTURE when it is synthetic.</span></div>
          <main id="main" className="page" tabIndex={-1}>{children}</main>
        </div>
      </div>
      <nav className="mobnav" aria-label="Workspaces">
        {mobileNavFor(user.role).map((m) => <Link key={m.label} href={m.href} aria-current={isCurrent(path, m.href) ? "page" : undefined}><Icon name={m.icon} />{m.label}</Link>)}
      </nav>
      <Dialog open={bell} onClose={() => setBell(false)} title="Notifications">
        <PlannedPanel title="Notification inbox" kind="UNAVAILABLE">There is no per-user notification inbox in the backend yet. Messages from actions you take appear briefly at the bottom of the screen.</PlannedPanel>
      </Dialog>
    </>
  );
}
