import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHistoryIntelRoutes } from "../../../apps/api/src/intelligenceApi";
import { documentedSessionRoutes, sessionOpenApiDocument } from "../../../apps/api/src/openapiSession";
import { registerTelegramIntelRoutes } from "../../../apps/api/src/telegramIntelApi";

describe("session OpenAPI document (Telegram intelligence read API)", () => {
  it("describes exactly the routes the session intelligence modules register", () => {
    const app = Fastify(), seen = new Set<string>();
    app.addHook("onRoute", (r) => { for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") seen.add(`${m} ${r.url.replace(/:([A-Za-z]+)/g, "{$1}")}`); });
    const deps = { auth: {} as never, ops: {} as never };
    registerTelegramIntelRoutes(app, deps); registerHistoryIntelRoutes(app, deps);
    const documented = documentedSessionRoutes();
    for (const r of seen) expect(documented.has(r), `registered but not documented: ${r}`).toBe(true);
    for (const r of documented) expect(seen.has(r), `documented but not registered: ${r}`).toBe(true);
    expect(seen.size).toBe(11);
  });
  it("is read-only, session-protected, names its permission and its error codes on every operation", () => {
    const paths = sessionOpenApiDocument["paths"] as Record<string, Record<string, { security?: unknown; ["x-required-permission"]?: string; responses?: Record<string, unknown> }>>;
    for (const [p, item] of Object.entries(paths)) {
      expect(Object.keys(item), p).toEqual(["get"]);
      const op = item["get"]!;
      expect(op.security, p).toEqual([{ sessionBearer: [] }]);
      expect(op["x-required-permission"], p).toMatch(/^(channels|signals|opportunities|strategies):read$/);
      for (const code of ["200", "401", "403", "404", "422"]) expect(op.responses, `${p} ${code}`).toHaveProperty(code);
    }
  });
  it("the committed docs/api/openapi-session.json is current (regenerate with npx tsx scripts/ops/export-openapi.ts)", () => {
    expect(JSON.parse(readFileSync(new URL("../../../docs/api/openapi-session.json", import.meta.url), "utf8"))).toEqual(JSON.parse(JSON.stringify(sessionOpenApiDocument)));
  });
});
