/** The route catalogue equals the live Fastify route table, the committed OpenAPI session document, ANALYTICS_ENDPOINTS and the permission strings written in the route source. */
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerHistoryIntelRoutes } from "../../../apps/api/src/intelligenceApi";
import { sessionOpenApiDocument } from "../../../apps/api/src/openapiSession";
import { registerOpportunityRoutes } from "../../../apps/api/src/opportunityApi";
import { registerResearchRoutes } from "../../../apps/api/src/researchApi";
import { registerTelegramIntelRoutes } from "../../../apps/api/src/telegramIntelApi";
import { registerUserRoutes } from "../../../apps/api/src/userApi";
import { ANALYTICS_ENDPOINTS } from "../../../packages/outcomes/src/index";
import { ADMIN_ROUTES, ALL_PERMISSIONS, ANALYTICS_ROUTES, AUTH_ROUTES, BROWSER_ROUTES, EXCLUDED_PLATFORM_PREFIXES, EXCLUDED_PLATFORM_ROUTES, PRIVATE_ROUTES, SESSION_ROUTE_CATALOGUE, SHARED_ROUTES, isPrivatePermission, type RouteEntry } from "../../../packages/api-contracts/src/index";

const SRC = (p: string): string => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const key = (m: string, p: string): string => `${m} ${p}`;

function liveRouteTable(): Set<string> {
  const app = Fastify(), seen = new Set<string>();
  app.addHook("onRoute", (r) => { for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") seen.add(key(m, r.url)); });
  const deps = { auth: {} as never, ops: {} as never };
  registerAuthRoutes(app, deps); registerUserRoutes(app, deps); registerTelegramIntelRoutes(app, deps); registerHistoryIntelRoutes(app, deps); registerResearchRoutes(app, deps); registerOpportunityRoutes(app, deps);
  return seen;
}

describe("route catalogue parity", () => {
  it("equals the live route table of the session modules, in both directions", () => {
    const live = liveRouteTable(), cat = new Set(SESSION_ROUTE_CATALOGUE.map((e) => key(e.method, e.path)));
    for (const r of live) expect(cat.has(r), `registered but not in the catalogue: ${r}`).toBe(true);
    for (const r of cat) expect(live.has(r), `in the catalogue but not registered: ${r}`).toBe(true);
    expect(cat.size).toBe(SESSION_ROUTE_CATALOGUE.length); // no duplicate method+path
    expect(new Set(SESSION_ROUTE_CATALOGUE.map((e) => e.id)).size).toBe(SESSION_ROUTE_CATALOGUE.length); // ids unique
  });
  it("counts: 5 auth, 3 admin, 18 private, 11 analytics, 17 shared", () => {
    expect([AUTH_ROUTES.length, ADMIN_ROUTES.length, PRIVATE_ROUTES.length, ANALYTICS_ROUTES.length, SHARED_ROUTES.length]).toEqual([5, 3, 18, 11, 17]);
  });
  it("permission strings equal the ones written in apps/api/src/userApi.ts for every private route", () => {
    const src = SRC("apps/api/src/userApi.ts"), found = new Map<string, string>();
    for (const m of src.matchAll(/\b(get|post)(?:<[^>]*>)?\("(\/[^"]+)", "([a-z-]+:[a-z]+)"/g)) found.set(key((m[1] as string).toUpperCase(), m[2] as string), m[3] as string);
    for (const verb of ["approve", "reject"]) { const p = /const act = [^\n]*?`\/decisions\/:id\/\$\{verb\}`, "([a-z:]+)"/.exec(src)?.[1]; expect(p, "act() permission").toBeDefined(); found.set(key("POST", `/decisions/:id/${verb}`), p as string); }
    for (const verb of ["watch", "unwatch"]) { const p = /const watchRoute = [^\n]*?`\/decisions\/:id\/\$\{verb\}`, "([a-z:]+)"/.exec(src)?.[1]; expect(p, "watchRoute() permission").toBeDefined(); found.set(key("POST", `/decisions/:id/${verb}`), p as string); }
    for (const ep of ANALYTICS_ENDPOINTS) found.set(key("GET", ep.path), ep.permission);
    for (const e of [...PRIVATE_ROUTES, ...ANALYTICS_ROUTES]) expect(found.get(key(e.method, e.path)), `${e.method} ${e.path}`).toBe(e.permission);
  });
  it("every catalogue permission is a real permission and its scope agrees with the permission group", () => {
    for (const e of SESSION_ROUTE_CATALOGUE) {
      if (e.permission) expect(ALL_PERMISSIONS, e.id).toContain(e.permission);
      if (e.scope === "PRIVATE") expect(e.permission !== null && isPrivatePermission(e.permission), e.id).toBe(true);
      if (e.scope === "SHARED") expect(e.permission !== null && !isPrivatePermission(e.permission), e.id).toBe(true);
      if (e.scope === "PUBLIC" || e.scope === "SESSION" || e.scope === "ADMIN_ROLE") expect(e.permission, e.id).toBeNull();
    }
  });
});

describe("OpenAPI session document parity (shared intelligence routes)", () => {
  const paths = sessionOpenApiDocument["paths"] as Record<string, Record<string, { "x-required-permission"?: string; parameters?: Array<{ name: string; in: string; required?: boolean }> }>>;
  it("every documented route is in the catalogue with the same permission and the same query parameters, and nothing else is", () => {
    const documented = Object.keys(paths).map((p) => p.replace(/\{([A-Za-z]+)\}/g, ":$1"));
    expect(new Set(documented)).toEqual(new Set(SHARED_ROUTES.map((e) => e.path)));
    for (const e of SHARED_ROUTES) {
      const op = paths[e.path.replace(/:([A-Za-z]+)/g, "{$1}")]?.["get"]; expect(op, e.path).toBeDefined();
      expect(op?.["x-required-permission"], e.path).toBe(e.permission);
      const params = (op?.parameters ?? []).filter((x) => x.in === "query").map((x) => x.name).sort();
      expect(params, e.path).toEqual([...e.query.optional, ...e.query.required].sort());
      for (const x of (op?.parameters ?? []).filter((y) => y.in === "query")) expect(x.required === true, `${e.path} ${x.name}`).toBe(e.query.required.includes(x.name));
    }
  });
});

describe("analytics endpoint parity with ANALYTICS_ENDPOINTS", () => {
  it("same 11 paths, all analytics:read, session-required and owner-scoped", () => {
    expect(new Set(ANALYTICS_ENDPOINTS.map((e) => e.path))).toEqual(new Set(ANALYTICS_ROUTES.map((e) => e.path)));
    expect(ANALYTICS_ENDPOINTS.length).toBe(11);
    for (const ep of ANALYTICS_ENDPOINTS) { expect(ep.permission).toBe("analytics:read"); expect(ep.auth).toBe("SESSION_REQUIRED"); expect(ep.ownerScoped).toBe(true); expect(ep.method).toBe("GET"); }
  });
  it("every query parameter the backend declares is accepted by the catalogue entry", () => {
    const name = (s: string): string => s.replace(/[?=<].*$/, "");
    for (const ep of ANALYTICS_ENDPOINTS) { const mine: RouteEntry | undefined = ANALYTICS_ROUTES.find((e) => e.path === ep.path); const have = new Set([...(mine?.query.optional ?? []), ...(mine?.query.required ?? [])]); for (const q of ep.query) expect(have.has(name(q)), `${ep.path} ${q}`).toBe(true); }
  });
});

describe("platform (shared service key) routes are not browser routes", () => {
  it("none of them, and no excluded prefix, appears in the catalogue; register is not browser-callable", () => {
    for (const e of SESSION_ROUTE_CATALOGUE) {
      expect(EXCLUDED_PLATFORM_ROUTES, e.path).not.toContain(e.path);
      for (const pre of EXCLUDED_PLATFORM_PREFIXES) expect(e.path.startsWith(pre) || e.path === pre.replace(/\/$/, ""), e.path).toBe(false);
    }
    expect(BROWSER_ROUTES.some((e) => e.path === "/auth/register" || e.path.startsWith("/admin/"))).toBe(false);
  });
  it("the three shared-key routes the intelligence module registers are really outside the session modules", () => {
    const live = liveRouteTable();
    for (const p of ["/intelligence/source", "/intelligence/estimate", "/risk/decisions/:id/intelligence"]) { expect(live.has(key("GET", p)) || live.has(key("POST", p)), p).toBe(false); expect(EXCLUDED_PLATFORM_ROUTES).toContain(p); }
  });
});
