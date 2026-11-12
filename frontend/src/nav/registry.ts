/**
 * The navigation and screen registry: the single source for what each role sees (docs/frontend/permissions-and-navigation.md, screen-map.md).
 * USER EXPERIENCE ONLY: it decides what to RENDER. The backend authorises every request; an ADMIN holds no private permission, so no private screen is ever offered to an ADMIN.
 */
import { roleHasPermission, type Role, type Permission } from "@twins/api-contracts";

export const WORKSPACES = ["DECIDE", "UNDERSTAND", "CONTROL", "REVIEW", "OPERATE"] as const;
export type Workspace = (typeof WORKSPACES)[number];
/** private = owner-scoped (TRADER only); shared = shared intelligence (both roles); admin = ADMIN only; account = any signed-in user. */
export type ScreenKind = "private" | "shared" | "admin" | "account";
export interface Screen {
  id: number; title: string; path: string; workspace: Workspace | null; kind: ScreenKind;
  /** The permission that gates the screen's main data (display logic only). */
  permission: Permission | null;
  /** What the screen is for, in one sentence (from docs/frontend/screen-map.md). */
  purpose: string;
  /** The stage in which the real screen is built. */
  arrivesIn: "09.3" | "09.3A" | "09.4" | "09.5" | "foundation";
  /** A backend capability that does not exist, shown as UNAVAILABLE on the screen. */
  gap?: string;
  /** For ADMIN the shared screens are grouped under UNDERSTAND (an administrator has no DECIDE workspace). */
  adminWorkspace?: Workspace;
  /** The icon key used by the shell. */
  icon: "desk" | "decide" | "understand" | "control" | "review" | "operate";
}
export const SCREENS: readonly Screen[] = [
  { id: 1, title: "Overview", path: "/", workspace: null, kind: "private", permission: "decisions:read", purpose: "One-glance desk state: what needs a decision, open paper positions, and how far each number can be trusted.", arrivesIn: "09.3A", icon: "desk" },
  { id: 2, title: "Approval Center", path: "/approvals", workspace: "DECIDE", kind: "private", permission: "decisions:read", purpose: "The decision queue: read each proposal and approve, reject or cancel it (paper only).", arrivesIn: "09.3", gap: "Requesting the paper order after an approval has no HTTP route; the operator does it today.", icon: "decide" },
  { id: 3, title: "Opportunities", path: "/opportunities", workspace: "DECIDE", adminWorkspace: "UNDERSTAND", kind: "shared", permission: "opportunities:read", purpose: "Scanner candidates from the latest scans, with their evidence and skip reasons.", arrivesIn: "09.3A", icon: "decide" },
  { id: 5, title: "Research", path: "/research", workspace: "UNDERSTAND", kind: "shared", permission: "research:read", purpose: "Research packages: agent verdicts, contradictions, evidence and coverage.", arrivesIn: "09.4", icon: "understand" },
  { id: 6, title: "Market Intelligence", path: "/market", workspace: "UNDERSTAND", kind: "shared", permission: "market:read", purpose: "Channel, claim and playbook intelligence from the archive.", arrivesIn: "09.3A", gap: "Market regime and live quotes have no backend route (G-16, G-20).", icon: "understand" },
  { id: 7, title: "Learning Insights", path: "/insights", workspace: "UNDERSTAND", kind: "private", permission: "analytics:read", purpose: "What the recorded evidence supports, with sample sizes, freshness and drift. Advisory only.", arrivesIn: "09.4", icon: "understand" },
  { id: 8, title: "Capital & Risk", path: "/capital-risk", workspace: "CONTROL", kind: "private", permission: "capital:read", purpose: "Your capital profile, risk policy and active controls (read-only).", arrivesIn: "09.3", gap: "Capital and risk-policy changes have no write routes; the operator changes them.", icon: "control" },
  { id: 9, title: "Paper Trading", path: "/paper", workspace: "CONTROL", kind: "private", permission: "orders:read", purpose: "Simulated orders, fills and positions with their status history.", arrivesIn: "09.3", gap: "There is no browser route to request execution or to exit or move a stop.", icon: "control" },
  { id: 10, title: "Portfolio", path: "/portfolio", workspace: "CONTROL", kind: "private", permission: "positions:read", purpose: "Allocated notional, open positions, realised result and capital facts for the selected account.", arrivesIn: "09.3", gap: "No unrealised P&L, mark price or live balance exists in the backend.", icon: "control" },
  { id: 11, title: "Decision History", path: "/decisions", workspace: "REVIEW", kind: "private", permission: "decisions:read", purpose: "Past decisions and how each ended.", arrivesIn: "09.4", icon: "review" },
  { id: 12, title: "Outcomes & Performance", path: "/performance", workspace: "REVIEW", kind: "private", permission: "analytics:read", purpose: "Recorded outcomes and performance. All outcome data is fixture-backed today.", arrivesIn: "09.4", icon: "review" },
  { id: 15, title: "Account", path: "/account", workspace: "OPERATE", kind: "account", permission: null, purpose: "Your sign-in, theme and session.", arrivesIn: "foundation", icon: "operate" },
  { id: 13, title: "Platform overview", path: "/admin/system", workspace: null, kind: "admin", permission: "system:read", purpose: "Platform health and safety posture (administrators only; no private trader data).", arrivesIn: "09.5", gap: "Platform status routes use the shared service key; they are served only through an administrator-checked server module (accepted residual risk).", icon: "desk" },
  { id: 14, title: "Users & Access", path: "/admin/users", workspace: "OPERATE", kind: "admin", permission: "users:manage", purpose: "User administration: accounts, roles and access for the people who use the platform.", arrivesIn: "09.5", gap: "Account creation and role changes exist as backend operations by user id, but there is no user list or audit route, and browser writes are not authorised in Stage 09.", icon: "operate" },
];

/** The role-based gate for DISPLAY. ADMIN never sees a private screen; TRADER never sees an admin screen. */
export function canView(role: Role, s: Screen): boolean {
  if (s.kind === "account") return true;
  if (s.kind === "admin") return role === "ADMIN";
  if (s.kind === "private") return role === "TRADER" && (s.permission === null || roleHasPermission(role, s.permission));
  return s.permission === null || roleHasPermission(role, s.permission); // shared
}
export const screensFor = (role: Role): Screen[] => SCREENS.filter((s) => canView(role, s));
export const landingFor = (role: Role): string => (role === "ADMIN" ? "/admin/system" : "/");
/** Screen 4 (Opportunity Detail) is a dynamic route under Opportunities: it has no navigation entry of its own and shares that screen's gate. */
export const OPPORTUNITY_DETAIL = /^\/opportunities\/[0-9a-fA-F-]{36}$/;
export const findScreen = (path: string): Screen | undefined => SCREENS.find((s) => s.path === path);

export interface NavGroup { workspace: Workspace | null; items: Screen[] }
export const workspaceFor = (role: Role, s: Screen): Workspace | null => (role === "ADMIN" && s.adminWorkspace ? s.adminWorkspace : s.workspace);
export function navFor(role: Role): NavGroup[] {
  const mine = screensFor(role), groups: NavGroup[] = [{ workspace: null, items: mine.filter((s) => workspaceFor(role, s) === null) }];
  for (const w of WORKSPACES) { const items = mine.filter((s) => workspaceFor(role, s) === w); if (items.length) groups.push({ workspace: w, items }); }
  return groups.filter((g) => g.items.length > 0);
}
/** Mobile bottom navigation: TRADER = Desk plus the four working workspaces; ADMIN = Platform, Understand, Operate. */
export function mobileNavFor(role: Role): Array<{ label: string; href: string; icon: Screen["icon"]; workspace: Workspace | null }> {
  const first = (w: Workspace): Screen | undefined => screensFor(role).find((s) => workspaceFor(role, s) === w);
  if (role === "ADMIN") return [{ label: "Platform", href: "/admin/system", icon: "desk", workspace: null }, ...(["UNDERSTAND", "OPERATE"] as const).flatMap((w) => { const s = first(w); return s ? [{ label: w[0] + w.slice(1).toLowerCase(), href: s.path, icon: s.icon, workspace: w }] : []; })];
  // Account (OPERATE) is reached from the topbar on phones, keeping the bar at five items.
  return [{ label: "Desk", href: "/", icon: "desk", workspace: null }, ...WORKSPACES.filter((w) => w !== "OPERATE").flatMap((w) => { const s = first(w); return s ? [{ label: w[0] + w.slice(1).toLowerCase(), href: s.path, icon: s.icon, workspace: w }] : []; })];
}
export function breadcrumbFor(path: string, role: Role = "TRADER"): Array<{ label: string; href?: string }> {
  const detail = OPPORTUNITY_DETAIL.test(path);
  if (detail) { const w = workspaceFor(role, findScreen("/opportunities") as Screen); return [...(w ? [{ label: w[0] + w.slice(1).toLowerCase() }] : []), { label: "Opportunities", href: "/opportunities" }, { label: "Opportunity detail" }]; }
  if (path === "/design-system") return [{ label: "Design system" }]; // the development/CI gallery is not a product screen
  const s = findScreen(path); if (!s) return [{ label: "Not found" }];
  const crumbs: Array<{ label: string; href?: string }> = [], w = workspaceFor(role, s);
  if (w) crumbs.push({ label: w[0] + w.slice(1).toLowerCase() });
  crumbs.push({ label: s.title }); return crumbs;
}
