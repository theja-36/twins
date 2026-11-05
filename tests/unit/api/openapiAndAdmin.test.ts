import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../../../apps/api/src/adminApi";
import { registerAgentsRoutes } from "../../../apps/api/src/agentsApi";
import { registerIntelligenceRoutes } from "../../../apps/api/src/intelligenceApi";
import { registerNotificationsRoutes } from "../../../apps/api/src/notificationsApi";
import { documentedRoutes, openApiDocument, registerOpenApiRoute } from "../../../apps/api/src/openapi";
import { registerPaperRoutes } from "../../../apps/api/src/paperApi";
import { registerRiskRoutes } from "../../../apps/api/src/riskApi";
import { registerSystemRoutes } from "../../../apps/api/src/systemApi";

const fakeDb = {} as never;
const authorized = (h: string | undefined) => h === "Bearer ok";
const adminAuthorized = (h: string | undefined) => h === "Bearer admin-ok";

function appWithAllRoutes() {
  const app = Fastify();
  const seen = new Set<string>();
  app.addHook("onRoute", (r) => { for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") seen.add(`${m} ${r.url.replace(/:([A-Za-z]+)/g, "{$1}")}`); });
  registerRiskRoutes(app, { db: fakeDb, authorized }); registerIntelligenceRoutes(app, { db: fakeDb, authorized } as never); registerPaperRoutes(app, { db: fakeDb, authorized });
  registerAgentsRoutes(app, { db: fakeDb, authorized }); registerNotificationsRoutes(app, { db: fakeDb, authorized }); registerSystemRoutes(app, { db: fakeDb, authorized, readSafety: () => ({}) });
  registerAdminRoutes(app, { db: fakeDb, adminAuthorized }); registerOpenApiRoute(app, { authorized });
  return { app, seen };
}

describe("OpenAPI document", () => {
  it("describes exactly the routes that the operator route modules register (no undocumented route, no phantom route)", () => {
    const { seen } = appWithAllRoutes();
    const documented = documentedRoutes();
    for (const r of documented) if (!r.endsWith(" /health") && !r.endsWith(" /health/status")) expect(seen.has(r), `documented but not registered: ${r}`).toBe(true);
    for (const r of seen) expect(documented.has(r), `registered but not documented: ${r}`).toBe(true);
  });
  it("never documents an order route, and marks every operation with a security scheme except /health", () => {
    const paths = openApiDocument["paths"] as Record<string, Record<string, { security?: unknown }>>;
    for (const [p, item] of Object.entries(paths)) {
      expect(p).not.toMatch(/^\/(orders|fills|positions|gtt|portfolio|margins)|\/place|\/cancel|\/modify/); // `/paper/positions` is the SIMULATION; there is no broker position, order or fill route
      for (const op of Object.values(item)) if (p !== "/health") expect(op.security, p).toBeTruthy();
    }
  });
  it("is served only with the bearer token", async () => {
    const { app } = appWithAllRoutes();
    expect((await app.inject({ method: "GET", url: "/openapi.json" })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/openapi.json", headers: { authorization: "Bearer ok" } });
    expect(ok.statusCode).toBe(200); expect(ok.json().openapi).toBe("3.0.3");
  });
});

describe("new read routes", () => {
  it("are bearer-protected and validate input before touching the database", async () => {
    const { app } = appWithAllRoutes(); const h = { authorization: "Bearer ok" };
    for (const url of ["/agents/status", "/notifications", "/system/config"]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    for (const url of ["/agents/status?limit=0", "/agents/status?limit=101", "/notifications?limit=0", "/notifications?limit=999", "/notifications?limit=x"]) expect((await app.inject({ method: "GET", url, headers: h })).statusCode, url).toBe(400);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) for (const url of ["/agents/status", "/notifications", "/system/config"]) expect((await app.inject({ method, url, headers: h })).statusCode, `${method} ${url}`).toBe(404);
  });
});

describe("admin paper switch route", () => {
  const body = { enabled: true, actor: "operator:sara", reason: "start of the paper period" };
  it("needs the admin token; the read token is not enough", async () => {
    const { app } = appWithAllRoutes();
    expect((await app.inject({ method: "POST", url: "/admin/paper/switch", payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/admin/paper/switch", payload: body, headers: { authorization: "Bearer ok" } })).statusCode).toBe(401);
  });
  it("rejects malformed bodies before touching the database", async () => {
    const { app } = appWithAllRoutes(); const headers = { authorization: "Bearer admin-ok" };
    for (const payload of [{}, { ...body, enabled: "true" }, { ...body, actor: "sara" }, { ...body, actor: "telegram:123" }, { ...body, reason: "no" }, { ...body, reason: "x".repeat(501) }, { enabled: true, actor: "operator:sara" }]) expect((await app.inject({ method: "POST", url: "/admin/paper/switch", payload, headers })).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
  });
  it("is not registered by the API entry point unless a long, distinct admin token is configured (static check)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("apps/api/src/index.ts", "utf8");
    expect(src).toMatch(/adminKey\.length >= 32 && adminKey !== apiKey/);
  });
});

describe("committed OpenAPI file", () => {
  it("docs/api/openapi.json equals the in-code document (regenerate with: npx tsx scripts/ops/export-openapi.ts)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync("docs/api/openapi.json", "utf8"))).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
  });
});

describe("the API stays inside what the runtime database role may read", () => {
  it("no API route file names a table the runtime role is barred from (none_for_runtime in app-role.sql)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const sql = readFileSync("infrastructure/staging/app-role.sql", "utf8");
    const m = /none_for_runtime text\[\] := ARRAY\[([^\]]+)\]/.exec(sql);
    expect(m, "none_for_runtime list not found").toBeTruthy();
    const barred = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(barred.length).toBeGreaterThan(3); expect(barred).toContain("system_control_events");
    for (const f of readdirSync("apps/api/src").filter((x) => /\.ts$/.test(x))) {
      const code = readFileSync(`apps/api/src/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const t of barred) expect(code, `${f} must not read ${t}`).not.toMatch(new RegExp(`\\b${t}\\b`));
    }
  });
});
