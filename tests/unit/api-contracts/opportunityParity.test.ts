/** Stage 09.3A: the shared-intelligence view keys in @twins/api-contracts equal what the REAL routes return (candidates, detail, scans, research package, channels). Fake data layer; real handlers. */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { CANDIDATE_DETAIL_KEYS, CANDIDATE_LIFECYCLE_STATES, CANDIDATE_RESEARCH_KEYS, CANDIDATE_SOURCES, CANDIDATE_VIEW_KEYS, CHANNEL_HEALTH_KEYS, CHANNEL_VIEW_KEYS, RESEARCH_PACKAGE_ABSENT_KEYS, RESEARCH_PACKAGE_KEYS, SCAN_VIEW_KEYS } from "../../../packages/api-contracts/src/index";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerOpportunityRoutes, type OpportunityOps } from "../../../apps/api/src/opportunityApi";
import { registerResearchRoutes, type ResearchOps } from "../../../apps/api/src/researchApi";
import { registerTelegramIntelRoutes, type TelegramIntelOps } from "../../../apps/api/src/telegramIntelApi";

const PW = "correct horse battery staple", ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = new Date("2031-01-06T04:30:00Z");
const cand = (n: number, source: "TELEGRAM" | "INDEPENDENT") => ({
  id: ID(n), source, state: "READY_FOR_DECISION", stateReason: null, supersededBy: null, underlying: "AAA", exchange: "NSE", strike: null, optionType: null, expiry: null, side: "BUY", entryKind: "above", entryLow: 100, entryHigh: 101.5, stopLoss: 95, targets: [110, 120],
  dataSource: "FIXTURE", createdAt: T, expiresAt: new Date(T.getTime() + 3_600_000), attempts: 1, invalidation: null, lastValidatedAt: null, rankScore: 7.5, setup: "BREAKOUT_LONG",
});
const list = [cand(1, "INDEPENDENT"), cand(2, "TELEGRAM")];
const oppOps: OpportunityOps = {
  async candidates() { return list as never; }, async candidate(id) { return (list.find((c) => c.id === id) ?? null) as never; },
  async events() { return [{ fromState: null, toState: "NEW", reason: null, occurredAt: T }]; }, async evidence() { return [{ kind: "setup", setupClass: "BREAKOUT_LONG" }]; },
  async latestPackage() { return { id: ID(9), version: 1, assessment: "RESEARCH_CAUTION" }; },
  async scans() { return [{ id: ID(50), scanKind: "TECHNICAL_UNIVERSE", slotKey: "slot", status: "COMPLETED", dataSource: "FIXTURE", detectorVersion: "v1", universeSize: 2, candidateCount: 1, errorKind: null, skipped: [], parameters: {}, startedAt: T, completedAt: T }]; },
};
let withPackage = true;
const resOps: ResearchOps = {
  async latest() { return withPackage ? { id: ID(9), version: 1, assessment: "RESEARCH_CAUTION", haltReason: null, agentResults: { candidateId: ID(1), grantsApproval: false, reports: [] }, createdAt: T } : null; },
  async byId() { return null; }, async candidate() { return { state: withPackage ? "READY_FOR_DECISION" : "IN_RESEARCH", attempts: 1 }; },
};
const channelRow = { id: ID(70), identifier: "-1001234567890", name: "Desk", messages: 5, messages24h: 2, claims: { claim: 1, ambiguous: 0, unsupported: 1 }, candidates: { NEW: 1 }, firstMessageAt: T, lastMessageAt: T, delayedShare24h: 0, medianCaptureDelaySeconds24h: 3 };
const tgOps = { channels: async () => [channelRow] } as unknown as TelegramIntelOps;

async function build() {
  const auth = new AuthService({ store: memoryAuthStore(), audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerOpportunityRoutes(app, { auth, ops: oppOps }); registerResearchRoutes(app, { auth, ops: resOps }); registerTelegramIntelRoutes(app, { auth, ops: tgOps, now: () => T });
  await auth.register({ email: "t@example.com", password: PW }); const token = (await auth.login({ email: "t@example.com", password: PW })).token;
  return (u: string) => app.inject({ method: "GET", url: u, headers: { authorization: `Bearer ${token}` } }).then((r) => ({ status: r.statusCode, body: r.json() as Record<string, unknown> }));
}
const SHARED_URLS = ["/opportunities/candidates", `/opportunities/candidates/${ID(1)}`, "/opportunities/scans", `/research/candidates/${ID(1)}/package`, "/intelligence/channels"];
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
const sorted = (a: readonly string[]): string[] => [...a].sort();

describe("shared-intelligence contracts equal the real routes", () => {
  it("candidate list and detail", async () => {
    const get = await build(), l = await get("/opportunities/candidates"), d = await get(`/opportunities/candidates/${ID(1)}`);
    expect(l.status).toBe(200); expect(keys(l.body)).toEqual(["candidates", "note", "state"]);
    for (const c of l.body["candidates"] as unknown[]) expect(keys(c)).toEqual(sorted(CANDIDATE_VIEW_KEYS));
    expect((l.body["candidates"] as Array<{ source: string }>).map((c) => c.source).sort()).toEqual(sorted(CANDIDATE_SOURCES));
    expect(keys(d.body)).toEqual(sorted(CANDIDATE_DETAIL_KEYS)); expect(keys(d.body["candidate"])).toEqual(sorted(CANDIDATE_VIEW_KEYS)); expect(keys(d.body["research"])).toEqual(sorted(CANDIDATE_RESEARCH_KEYS));
    expect(CANDIDATE_LIFECYCLE_STATES).toContain((d.body["candidate"] as { state: string }).state);
    expect(keys((d.body["lifecycle"] as unknown[])[0])).toEqual(["at", "from", "reason", "to"]);
  });
  it("scans", async () => { const get = await build(), s = await get("/opportunities/scans"); expect(keys(s.body)).toEqual(["scans", "state"]); expect(keys((s.body["scans"] as unknown[])[0])).toEqual(sorted(SCAN_VIEW_KEYS)); });
  it("research package for a candidate, present and absent", async () => {
    const get = await build(); withPackage = true; expect(keys((await get(`/research/candidates/${ID(1)}/package`)).body)).toEqual(sorted(RESEARCH_PACKAGE_KEYS));
    withPackage = false; expect(keys((await get(`/research/candidates/${ID(1)}/package`)).body)).toEqual(sorted(RESEARCH_PACKAGE_ABSENT_KEYS)); withPackage = true;
  });
  it("channels, with health and a masked identifier", async () => {
    const get = await build(), c = await get("/intelligence/channels");
    expect(keys(c.body)).toEqual(["channels", "reliabilityNote"]); const row = (c.body["channels"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(keys(row)).toEqual(sorted(CHANNEL_VIEW_KEYS)); expect(keys(row["health"])).toEqual(sorted(CHANNEL_HEALTH_KEYS)); expect(row["channel"]).toBe("***7890");
  });
});

describe("ADMIN access to the shared routes is granted by the BACKEND, not by the navigation", () => {
  it("an ADMIN session gets 200 on every shared route the Stage 09.3A screens use; no session or the service key gets 401", async () => {
    const auth = new AuthService({ store: memoryAuthStore(), audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: false } });
    const app = Fastify(); registerAuthRoutes(app, { auth }); registerOpportunityRoutes(app, { auth, ops: oppOps }); registerResearchRoutes(app, { auth, ops: resOps }); registerTelegramIntelRoutes(app, { auth, ops: tgOps, now: () => T });
    await auth.bootstrapAdmin({ email: "a@example.com", password: PW }); const token = (await auth.login({ email: "a@example.com", password: PW })).token;
    for (const u of SHARED_URLS) {
      expect((await app.inject({ method: "GET", url: u, headers: { authorization: `Bearer ${token}` } })).statusCode, u).toBe(200);
      for (const t of [undefined, "test-api-key-default"]) expect((await app.inject({ method: "GET", url: u, headers: t ? { authorization: `Bearer ${t}` } : {} })).statusCode, `${u} ${t}`).toBe(401);
    }
  });
});
