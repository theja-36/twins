import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAgentsRoutes } from "../../../apps/api/src/agentsApi";
import { registerLiveRoutes } from "../../../apps/api/src/liveApi";

const authorized = (h: string | undefined) => h === "Bearer ok";
const auth = { authorization: "Bearer ok" };
const db = {} as never;
const ID = "11111111-1111-4111-8111-111111111111";
function app(providersDir: string) {
  const a = Fastify();
  registerAgentsRoutes(a, { db, authorized }); registerLiveRoutes(a, { db, authorized, snapshotDir: "/nonexistent", providersDir, adminConfigured: false, readSafety: () => ({}) });
  return a;
}

describe("GET /market/sources (source health, read-only)", () => {
  it("needs the bearer token", async () => { expect((await app("/nonexistent").inject({ method: "GET", url: "/market/sources" })).statusCode).toBe(401); });
  it("an absent directory reports every source MISSING, never healthy", async () => {
    const r = await app(join(tmpdir(), "no-such-dir-sources")).inject({ method: "GET", url: "/market/sources", headers: auth });
    const b = r.json(); expect(r.statusCode).toBe(200);
    expect(b).toMatchObject({ overall: "MISSING", passLogAvailable: false, grantsApproval: false }); expect(b.providers.every((p: { usable: boolean }) => !p.usable)).toBe(true);
  });
  it("reads a fresh file as OK and returns no file content", async () => {
    const d = mkdtempSync(join(tmpdir(), "src-"));
    writeFileSync(join(d, "holiday-calendar.json"), JSON.stringify({ format: "twins-holiday-calendar-v1", source: "nse", as_of: new Date().toISOString(), markets: { NSE: { days: [] }, SECRET_MARKER: {} } }));
    const r = await app(d).inject({ method: "GET", url: "/market/sources", headers: auth });
    const h = r.json().providers.find((p: { provider: string }) => p.provider === "holidays");
    expect(h).toMatchObject({ status: "OK", usable: true, count: 2 }); expect(r.body).not.toContain("SECRET_MARKER");
  });
  it("rejects writes", async () => { expect((await app("/nonexistent").inject({ method: "POST", url: "/market/sources", headers: auth })).statusCode).toBe(404); });
});

describe("GET /risk/decisions/:id/decision-card (read-only)", () => {
  it("needs the bearer token and a UUID", async () => {
    const a = app("/nonexistent");
    expect((await a.inject({ method: "GET", url: `/risk/decisions/${ID}/decision-card` })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/risk/decisions/not-a-uuid/decision-card", headers: auth })).statusCode).toBe(400);
  });
  it("rejects writes", async () => { expect((await app("/nonexistent").inject({ method: "POST", url: `/risk/decisions/${ID}/decision-card`, headers: auth })).statusCode).toBe(404); });
});
