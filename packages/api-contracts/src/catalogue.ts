/**
 * The route catalogue: every backend route a browser-facing client may use, in two groups, plus the routes it must NEVER use.
 *
 *  - SESSION routes: authenticated by the user's session token (the BFF adds it from the HttpOnly cookie).
 *  - Platform routes: authenticated by the shared service key. They are NOT in this catalogue and are excluded below.
 *
 * Seeds (all read, none imported): apps/api/src/{authApi,userApi}.ts (route definitions), docs/api/openapi-session.json (the shared-intelligence routes),
 * ANALYTICS_ENDPOINTS in packages/outcomes/src/contracts.ts. Parity: tests/unit/api-contracts/catalogueParity.test.ts compares this file with the live Fastify route table,
 * the OpenAPI document, ANALYTICS_ENDPOINTS and the permission strings written in the route source.
 */
import type { Permission } from "./roles";

export type RouteScope = "PUBLIC" | "SESSION" | "PRIVATE" | "SHARED" | "ADMIN_ROLE";
export interface QuerySpec { required: readonly string[]; optional: readonly string[] }
export interface BodySpec { required: readonly string[]; optional: readonly string[] }
export interface RouteEntry {
  id: string;
  method: "GET" | "POST";
  /** Backend path syntax (`:id`). */
  path: string;
  /** PRIVATE: owner-scoped, TRADER only. SHARED: shared intelligence, any role holding the shared permission. SESSION: any valid session. ADMIN_ROLE: ADMIN role check (no permission string). PUBLIC: no session. */
  scope: RouteScope;
  permission: Permission | null;
  query: QuerySpec;
  body?: BodySpec;
  /** The wire type (see wire.ts / analytics.ts). `unverified` means the response shape is NOT guaranteed by a contract test. */
  response: string;
  unverified?: true;
  /** false: the route exists but must never be called from the browser. */
  browser: boolean;
}
const none: QuerySpec = { required: [], optional: [] };
const q = (required: readonly string[], optional: readonly string[] = []): QuerySpec => ({ required, optional });
const r = (e: Omit<RouteEntry, "browser"> & { browser?: boolean }): RouteEntry => ({ browser: true, ...e });

export const AUTH_ROUTES: readonly RouteEntry[] = [
  r({ id: "auth.login", method: "POST", path: "/auth/login", scope: "PUBLIC", permission: null, query: none, body: { required: ["email", "password"], optional: [] }, response: "LoginResponse" }),
  r({ id: "auth.logout", method: "POST", path: "/auth/logout", scope: "SESSION", permission: null, query: none, response: "204" }),
  r({ id: "auth.me", method: "GET", path: "/auth/me", scope: "SESSION", permission: null, query: none, response: "MeResponse" }),
  r({ id: "auth.changePassword", method: "POST", path: "/auth/change-password", scope: "SESSION", permission: null, query: none, body: { required: ["currentPassword", "newPassword"], optional: [] }, response: "204" }),
  // Registration is closed unless TWINS_REGISTRATION_OPEN=true; a private platform never exposes it to the browser.
  r({ id: "auth.register", method: "POST", path: "/auth/register", scope: "PUBLIC", permission: null, query: none, body: { required: ["email", "password"], optional: ["displayName"] }, response: "201", browser: false }),
];
/** ADMIN-role routes exist in the backend; Stage 09 builds NO browser UI for them (no list or audit route exists), so they are listed but not browser-callable. */
export const ADMIN_ROUTES: readonly RouteEntry[] = [
  r({ id: "admin.users.create", method: "POST", path: "/admin/users", scope: "ADMIN_ROLE", permission: null, query: none, body: { required: ["email", "password"], optional: ["displayName", "role"] }, response: "201", browser: false }),
  r({ id: "admin.users.role", method: "POST", path: "/admin/users/:id/role", scope: "ADMIN_ROLE", permission: null, query: none, body: { required: ["role"], optional: [] }, response: "204", browser: false }),
  r({ id: "admin.users.active", method: "POST", path: "/admin/users/:id/active", scope: "ADMIN_ROLE", permission: null, query: none, body: { required: ["active"], optional: [] }, response: "204", browser: false }),
];

export const PRIVATE_ROUTES: readonly RouteEntry[] = [
  r({ id: "accounts.list", method: "GET", path: "/accounts", scope: "PRIVATE", permission: "capital:read", query: none, response: "AccountsResponse" }),
  r({ id: "capital.profile", method: "GET", path: "/capital/profile", scope: "PRIVATE", permission: "capital:read", query: q(["accountId"]), response: "CapitalProfileResponse" }),
  r({ id: "risk.policy", method: "GET", path: "/risk/policy", scope: "PRIVATE", permission: "risk:read", query: q(["accountId"]), response: "RiskPolicyResponse" }),
  r({ id: "portfolio.get", method: "GET", path: "/portfolio", scope: "PRIVATE", permission: "positions:read", query: q(["accountId"]), response: "PortfolioResponse" }),
  r({ id: "risk.controls", method: "GET", path: "/risk/controls", scope: "PRIVATE", permission: "risk:read", query: none, response: "RiskControlsResponse" }),
  r({ id: "decisions.list", method: "GET", path: "/decisions", scope: "PRIVATE", permission: "decisions:read", query: q([], ["state", "accountId", "limit"]), response: "DecisionsResponse" }),
  r({ id: "decisions.get", method: "GET", path: "/decisions/:id", scope: "PRIVATE", permission: "decisions:read", query: none, response: "DecisionDetailResponse" }),
  r({ id: "approvals.list", method: "GET", path: "/approvals", scope: "PRIVATE", permission: "decisions:read", query: none, response: "ApprovalsResponse" }),
  r({ id: "decisions.approve", method: "POST", path: "/decisions/:id/approve", scope: "PRIVATE", permission: "decisions:approve", query: none, body: { required: ["idempotencyKey"], optional: ["reason"] }, response: "ApprovalActionResponse" }),
  r({ id: "decisions.reject", method: "POST", path: "/decisions/:id/reject", scope: "PRIVATE", permission: "decisions:approve", query: none, body: { required: ["idempotencyKey"], optional: ["reason"] }, response: "ApprovalActionResponse" }),
  r({ id: "decisions.cancel", method: "POST", path: "/decisions/:id/cancel", scope: "PRIVATE", permission: "decisions:approve", query: none, body: { required: ["reason"], optional: [] }, response: "CancelResponse" }),
  r({ id: "decisions.comparables", method: "GET", path: "/decisions/:id/comparables", scope: "PRIVATE", permission: "decisions:read", query: none, response: "ComparablesResponse", unverified: true }),
  r({ id: "decisions.watch", method: "POST", path: "/decisions/:id/watch", scope: "PRIVATE", permission: "decisions:watch", query: none, body: { required: ["idempotencyKey"], optional: ["reason"] }, response: "WatchResponse" }),
  r({ id: "decisions.unwatch", method: "POST", path: "/decisions/:id/unwatch", scope: "PRIVATE", permission: "decisions:watch", query: none, body: { required: ["idempotencyKey"], optional: ["reason"] }, response: "WatchResponse" }),
  r({ id: "orders.list", method: "GET", path: "/execution/orders", scope: "PRIVATE", permission: "orders:read", query: q([], ["decisionId", "status", "limit"]), response: "OrdersResponse" }),
  r({ id: "orders.fills", method: "GET", path: "/execution/orders/:id/fills", scope: "PRIVATE", permission: "orders:read", query: none, response: "FillsResponse" }),
  r({ id: "positions.list", method: "GET", path: "/execution/positions", scope: "PRIVATE", permission: "positions:read", query: q([], ["status", "limit"]), response: "PositionsResponse" }),
  r({ id: "positions.events", method: "GET", path: "/execution/positions/:id/events", scope: "PRIVATE", permission: "positions:read", query: none, response: "PositionEventsResponse" }),
];

/** The 11 analytics endpoints (all `analytics:read`, owner-scoped). Seeded from ANALYTICS_ENDPOINTS; every route accepts `accountId` in the query allow-list but ignores it (userApi.ts:168). */
const analytics = (id: string, path: string, optional: readonly string[], response: string): RouteEntry => r({ id: `analytics.${id}`, method: "GET", path, scope: "PRIVATE", permission: "analytics:read", query: q([], optional), response });
export const ANALYTICS_ROUTES: readonly RouteEntry[] = [
  analytics("overview", "/analytics/overview", ["accountId", "dataset"], "AnalyticsResponse"),
  analytics("strategies", "/analytics/strategies", ["accountId", "dimension"], "AnalyticsResponse"),
  analytics("channels", "/analytics/channels", ["accountId"], "AnalyticsResponse"),
  analytics("independent", "/analytics/independent", ["accountId"], "AnalyticsResponse"),
  analytics("agents", "/analytics/agents", ["accountId"], "AnalyticsResponse"),
  analytics("decisions", "/analytics/decisions", ["accountId"], "AnalyticsResponse"),
  analytics("outcomes", "/analytics/outcomes", ["finality", "limit", "cursor"], "AnalyticsResponse<OutcomeRowView[]>"),
  analytics("insights", "/analytics/insights", ["kind", "limit"], "AnalyticsResponse<InsightRowView[]>"),
  analytics("drift", "/analytics/drift", ["accountId"], "AnalyticsResponse"),
  analytics("data-quality", "/analytics/data-quality", ["accountId"], "AnalyticsResponse"),
  analytics("calibration", "/analytics/calibration", ["accountId"], "AnalyticsResponse"),
];

/** Shared-intelligence routes (session-authenticated, no owner). Response bodies are NOT typed: docs/api/openapi-session.json describes them and no wire type is asserted here. */
const shared = (id: string, path: string, permission: Permission, optional: readonly string[] = []): RouteEntry => r({ id, method: "GET", path, scope: "SHARED", permission, query: q([], optional), response: "unverified", unverified: true });
export const SHARED_ROUTES: readonly RouteEntry[] = [
  shared("intelligence.channels", "/intelligence/channels", "channels:read", ["limit"]),
  shared("intelligence.channel", "/intelligence/channels/:id", "channels:read"),
  shared("intelligence.claims", "/intelligence/claims", "signals:read", ["channelId", "kind", "limit"]),
  shared("intelligence.claim", "/intelligence/claims/:id", "signals:read"),
  shared("intelligence.candidates", "/intelligence/candidates", "opportunities:read", ["state", "limit"]),
  shared("intelligence.pipeline", "/intelligence/pipeline", "opportunities:read"),
  shared("intelligence.historicalMatches", "/intelligence/claims/:id/historical-matches", "signals:read"),
  shared("intelligence.channelPerformance", "/intelligence/channels/:id/performance", "strategies:read"),
  shared("intelligence.playbooks", "/intelligence/playbooks", "strategies:read", ["channelId", "limit", "offset"]),
  shared("intelligence.playbook", "/intelligence/playbooks/:id", "strategies:read"),
  shared("research.package", "/research/candidates/:id/package", "research:read"),
  shared("research.packageById", "/research/packages/:id", "research:read"),
  shared("research.agents", "/research/agents", "research:read"),
  shared("opportunities.candidates", "/opportunities/candidates", "opportunities:read", ["source", "state", "limit", "offset"]),
  shared("opportunities.candidate", "/opportunities/candidates/:id", "opportunities:read"),
  shared("opportunities.scans", "/opportunities/scans", "opportunities:read", ["limit", "offset"]),
  shared("intelligence.archiveChannels", "/intelligence/archive/channels", "strategies:read", ["limit", "offset"]),
];

export const SESSION_ROUTE_CATALOGUE: readonly RouteEntry[] = [...AUTH_ROUTES, ...ADMIN_ROUTES, ...PRIVATE_ROUTES, ...ANALYTICS_ROUTES, ...SHARED_ROUTES];
/** Routes a browser-facing client may call. */
export const BROWSER_ROUTES: readonly RouteEntry[] = SESSION_ROUTE_CATALOGUE.filter((e) => e.browser);

/**
 * Platform (shared service key) routes that MUST NEVER be reachable from a TRADER browser and are deliberately absent from the catalogue.
 * Verified in the backend: they are registered with the shared key, not a session (apps/api/src/index.ts, intelligenceApi.ts `registerIntelligenceRoutes`).
 * The list is documentation plus a test fixture; it is not exhaustive of every legacy path.
 */
export const EXCLUDED_PLATFORM_ROUTES: readonly string[] = ["/health", "/health/status", "/system/config", "/agents/status", "/intake/status", "/intelligence/source", "/intelligence/estimate", "/risk/decisions/:id/intelligence", "/admin/paper/switch"];
export const EXCLUDED_PLATFORM_PREFIXES: readonly string[] = ["/paper/", "/notifications", "/market/", "/news/telegram", "/telegram/"];
