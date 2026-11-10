import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerOpportunityRoutes, type OpportunityOps } from "../../../apps/api/src/opportunityApi";

/** Opportunity read API: session-protected, read-only, shared data, both sources distinguishable. Fake operations; the research-status derivation is the real code. */
const PW = "correct horse battery staple", ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = new Date("2026-11-09T04:30:00Z");
const cand = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), source: "INDEPENDENT" as const, state: "READY_FOR_DECISION", stateReason: null, supersededBy: null, underlying: "AAA", exchange: "NSE", strike: null, optionType: null, expiry: null, side: "BUY" as const, entryKind: "at" as const, entryLow: 100, entryHigh: 100, stopLoss: 98, targets: [102, 104, 106], dataSource: "FIXTURE" as const, createdAt: T, expiresAt: new Date(T.getTime() + 3_600_000), attempts: 1, invalidation: { price: 98 }, lastValidatedAt: null, rankScore: 62, setup: "BREAKOUT", ...o });
let list = [cand(1), cand(2, { source: "TELEGRAM", setup: null, rankScore: null })], pkg: { id: string; version: number; assessment: string } | null = { id: ID(9), version: 1, assessment: "RESEARCH_CAUTION" };
const calls: string[] = [];
const ops: OpportunityOps = {
  async candidates(o) { calls.push(`candidates:${o.source ?? "-"}:${o.states?.[0] ?? "-"}:${o.limit}:${o.offset}`); return list.filter((c) => (!o.source || c.source === o.source) && (!o.states || o.states.includes(c.state))).slice(o.offset, o.offset + o.limit) as never; },
  async candidate(id) { calls.push(`candidate:${id}`); return (list.find((c) => c.id === id) ?? null) as never; },
  async events(id) { return [{ fromState: "IN_RESEARCH", toState: "READY_FOR_DECISION", reason: null, occurredAt: T }, { fromState: null, toState: "NEW", reason: null, occurredAt: new Date(T.getTime() - 60_000) }].filter(() => id !== ID(99)); },
  async evidence() { return [{ kind: "setup", setupClass: "BREAKOUT_LONG" }, { kind: "reward_risk_screen", passed: true }, { kind: "provenance", configSha256: "a".repeat(64) }]; },
  async latestPackage() { return pkg; },
  async scans(o) { calls.push(`scans:${o.limit}:${o.offset}`); return [{ id: ID(50), scanKind: "TECHNICAL_UNIVERSE", slotKey: "slot", status: "COMPLETED", dataSource: "FIXTURE", detectorVersion: "opportunity-setups-v1", universeSize: 2, candidateCount: 1, errorKind: null, skipped: [{ underlying: "BBB", reason: "NO_DATA" }], parameters: { minRewardRisk: 1.5 }, startedAt: T, completedAt: T }]; },
};
async function build() {
  const store = memoryAuthStore(), auth = new AuthService({ store, audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerOpportunityRoutes(app, { auth, ops });
  await auth.register({ email: "t@example.com", password: PW }); const token = (await auth.login({ email: "t@example.com", password: PW })).token;
  return { token, app, get: (u: string, t?: string) => app.inject({ method: "GET", url: u, headers: t ? { authorization: `Bearer ${t}` } : {} }) };
}
const URLS = ["/opportunities/candidates", `/opportunities/candidates/${ID(1)}`, "/opportunities/scans"];

describe("opportunity routes: access", () => {
  it("require a session; the service key and garbage are refused before any data is read", async () => {
    const b = await build(); calls.length = 0;
    for (const u of URLS) for (const t of [undefined, "test-api-key-default", "tws_short"]) expect((await b.get(u, t)).statusCode, `${u} ${t}`).toBe(401);
    expect(calls).toEqual([]); for (const u of URLS) expect((await b.get(u, b.token)).statusCode, u).toBe(200);
  });
  it("are read-only: nothing but GET exists", async () => { const b = await build(); for (const u of URLS) for (const m of ["POST", "PUT", "PATCH", "DELETE"] as const) expect((await b.app.inject({ method: m, url: u, headers: { authorization: `Bearer ${b.token}` } })).statusCode, `${m} ${u}`).toBe(404); });
  it("validate every parameter: unknown source or state, bad ids, out-of-range limit and offset, unknown parameters", async () => {
    const b = await build();
    for (const u of ["/opportunities/candidates?source=BROKER", "/opportunities/candidates?state=DONE", "/opportunities/candidates?limit=0", "/opportunities/candidates?limit=201", "/opportunities/candidates?offset=-1", "/opportunities/candidates?bogus=1", "/opportunities/candidates/not-a-uuid", `/opportunities/candidates/${ID(1)}?x=1`, "/opportunities/scans?limit=500"]) expect((await b.get(u, b.token)).statusCode, u).toBe(422);
    expect((await b.get(`/opportunities/candidates/${ID(77)}`, b.token)).statusCode).toBe(404);
  });
});
describe("candidates", () => {
  it("lists both sources, always labelled, and filters by source and state; no order, approval or size field exists", async () => {
    const b = await build(), all = (await b.get("/opportunities/candidates", b.token)).json();
    expect(all.candidates.map((c: { source: string }) => c.source)).toEqual(["INDEPENDENT", "TELEGRAM"]); expect(all.note).toMatch(/proposals for research/);
    expect((await b.get("/opportunities/candidates?source=INDEPENDENT", b.token)).json().candidates).toHaveLength(1);
    expect((await b.get("/opportunities/candidates?source=TELEGRAM", b.token)).json().candidates[0]).toMatchObject({ source: "TELEGRAM", rankScore: null, setup: null }); // missing values are null, never defaulted
    for (const c of all.candidates) { expect(Object.keys(c)).not.toEqual(expect.arrayContaining(["quantity"])); expect(JSON.stringify(c)).not.toMatch(/"(orderId|approved|lots|quantity)"/); }
  });
  it("is deterministic and paginates: limit and offset reach the store; an empty page says EMPTY", async () => {
    const b = await build(); calls.length = 0;
    expect((await b.get("/opportunities/candidates?limit=1&offset=1", b.token)).json().candidates.map((c: { id: string }) => c.id)).toEqual([ID(2)]);
    expect(calls).toContain("candidates:-:-:1:1"); expect((await b.get("/opportunities/candidates?offset=5", b.token)).json()).toMatchObject({ state: "EMPTY", candidates: [] });
  });
  it("detail: lifecycle history, recorded evidence (screen and provenance), and the derived research status with the package it used", async () => {
    const b = await build(), j = (await b.get(`/opportunities/candidates/${ID(1)}`, b.token)).json();
    expect(j.candidate).toMatchObject({ id: ID(1), source: "INDEPENDENT", state: "READY_FOR_DECISION" }); expect(j.lifecycle.map((e: { to: string }) => e.to)).toEqual(["READY_FOR_DECISION", "NEW"]);
    expect(j.evidence.map((e: { kind: string }) => e.kind)).toEqual(["setup", "reward_risk_screen", "provenance"]); expect(j.research).toEqual({ status: "COMPLETED", packageId: ID(9), packageVersion: 1, assessment: "RESEARCH_CAUTION" });
  });
  it("a candidate with no package reports its pending status; an incomplete package is PARTIAL, never COMPLETED", async () => {
    const b = await build(); const save = pkg;
    pkg = null; list = [cand(1, { state: "NEW" })]; expect((await b.get(`/opportunities/candidates/${ID(1)}`, b.token)).json().research).toMatchObject({ status: "PENDING", packageId: null });
    pkg = { id: ID(9), version: 2, assessment: "RESEARCH_INCOMPLETE" }; list = [cand(1)]; expect((await b.get(`/opportunities/candidates/${ID(1)}`, b.token)).json().research.status).toBe("PARTIAL");
    pkg = save; list = [cand(1), cand(2, { source: "TELEGRAM", setup: null, rankScore: null })];
  });
});
describe("scans", () => {
  it("lists recent scans with the recorded skip reasons and parameters", async () => {
    const b = await build(), j = (await b.get("/opportunities/scans?limit=5", b.token)).json();
    expect(j.scans[0]).toMatchObject({ slot: "slot", status: "COMPLETED", skipped: [{ underlying: "BBB", reason: "NO_DATA" }], parameters: { minRewardRisk: 1.5 } });
  });
});
describe("the opportunity API can create nothing", () => {
  const src = readFileSync(join(__dirname, "../../../apps/api/src/opportunityApi.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("registers only GET routes and imports no execution, paper, planning, decision, risk-sizing or broker code", () => {
    expect(src).not.toMatch(/app\.(post|put|patch|delete)\b/); expect(src).not.toMatch(/@twins\/(execution|paper|planning|decision|adapter|providers)/);
    expect(src).not.toMatch(/\b(insert|update|delete)\(|storeResearchPackage|beginScan|insertScanCandidates|withdrawCandidate|applyRevalidation/);
  });
});

