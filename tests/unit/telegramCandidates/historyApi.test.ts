import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerHistoryIntelRoutes } from "../../../apps/api/src/intelligenceApi";
import { registerTelegramIntelRoutes, type TelegramIntelOps } from "../../../apps/api/src/telegramIntelApi";

const PW = "correct horse battery staple", ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = new Date("2024-06-03T00:00:00Z");
const claimView = (o: Record<string, unknown> = {}) => ({ claimId: ID(7), resultKind: "claim", parserVersion: "p", claim: { action: "buy", underlying: "NIFTY", strike: 24500, optionType: "CE", entry: { type: "at", price: 100 }, stopLoss: 80, targets: [120, 140], levelBasis: "premium", expiry: { status: "full", day: 20, month: 6, year: 2024, raw: "20 JUN 2024" }, raw: "RAW" }, messageTimestamp: T, receivedAt: T, sourceId: ID(1), captureMethod: "bot_webhook", classification: null, candidacy: null, candidate: null, ...o });
const row = (id: string, o: Record<string, unknown> = {}) => ({ caseId: id, messageTimestamp: new Date("2024-03-04T00:00:00Z"), channelLabel: "arch", originalMessageId: id, revisionNo: 0, underlying: "NIFTY", entry: { type: "at", price: 100 }, stopLoss: 80, targets: [120, 140], expiryDate: "2024-03-28", finalOutcome: "WIN_T1", slFirstTouchAt: null, targetEvaluations: [{ index: 1, status: "TARGET_HIT", firstTouchAt: "2024-03-06T00:00:00.000Z" }], labelledAt: new Date("2026-06-01T00:00:00Z"), ...o });
let rows: Array<ReturnType<typeof row>> = [], cv: Record<string, unknown> | null = claimView(), scorecards: unknown[] = [];
const calls: string[] = [];
const ops: TelegramIntelOps = {
  async channels(_n, o) { return o.id === ID(1) ? [{ id: ID(1), identifier: "-1001234567892544", name: "C", messages: 1, messages24h: 0, claims: { claim: 2, ambiguous: 0, unsupported: 0 }, candidates: {}, firstMessageAt: T, lastMessageAt: T, delayedShare24h: null, medianCaptureDelaySeconds24h: null }] : []; },
  async claims() { return []; }, async claim(id) { calls.push(`claim:${id}`); return id === ID(7) ? (cv as never) : null; }, async candidates() { return []; }, async pipeline() { return { claimsTotal: 0, claimsParsed: 0, byOutcome: {}, candidates: {}, oldestPendingMinutes: null }; },
  async playbooks(o) { calls.push(`playbooks:${o.limit}:${o.offset}`); return []; }, async playbook(id) { return id === ID(3) ? ({ playbook: { id: ID(3), sourceKind: "TELEGRAM_CHANNEL", telegramSourceId: ID(1), name: "p", createdAt: T, versions: 1, activeVersion: null, latestVersion: 1 }, versions: [], drift: [] } as never) : null; },
  async historicalRows(o) { calls.push(`rows:${o.before.toISOString()}:${o.limit}`); return rows.filter((r) => r.messageTimestamp.getTime() < o.before.getTime()) as never; },
  async archive() { return scorecards as never; }, async funnel() { return { claims: { claim: 2, ambiguous: 0, unsupported: 1 }, candidacy: { CREATED: 1 }, candidates: { NEW: 1 }, firstClaimAt: T, lastClaimAt: T }; },
};
async function build() {
  const store = memoryAuthStore(), auth = new AuthService({ store, audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerHistoryIntelRoutes(app, { auth, ops }); registerTelegramIntelRoutes(app, { auth, ops, now: () => T });
  await auth.register({ email: "t@example.com", password: PW }); const token = (await auth.login({ email: "t@example.com", password: PW })).token;
  return { token, get: (u: string, t?: string) => app.inject({ method: "GET", url: u, headers: t ? { authorization: `Bearer ${t}` } : {} }), app };
}
const URLS = [`/intelligence/claims/${ID(7)}/historical-matches`, `/intelligence/channels/${ID(1)}/performance`, "/intelligence/archive/channels", "/intelligence/playbooks", `/intelligence/playbooks/${ID(3)}`];

describe("history, performance, archive and playbook routes", () => {
  it("require a session; the service key and garbage are refused before any data is read", async () => {
    const b = await build(); calls.length = 0;
    for (const u of URLS) for (const t of [undefined, "test-api-key-default", "tws_short"]) expect((await b.get(u, t)).statusCode, `${u} ${t}`).toBe(401);
    expect(calls).toEqual([]); for (const u of URLS) expect((await b.get(u, b.token)).statusCode, u).toBe(200);
  });
  it("are read-only", async () => { const b = await build(); for (const u of URLS) expect((await b.app.inject({ method: "POST", url: u, headers: { authorization: `Bearer ${b.token}` } })).statusCode, u).toBe(404); });
  it("a later claim sees an archived win that was already known; the temporal counters and notes are returned", async () => {
    const b = await build(); rows = [row("k1")]; cv = claimView();
    const j = (await b.get(URLS[0]!, b.token)).json(); expect(j).toMatchObject({ source: "ARCHIVE_IMPORT", asOf: "2024-06-03T00:00:00.000Z", casesConsidered: 1 }); expect(j.result.aggregate).toMatchObject({ wins: 1, status: "INSUFFICIENT_EVIDENCE" });
    expect(j.result.temporal).toEqual({ sameGroup: 0, duplicateRevision: 0, outcomeNotYetKnown: 0, unknownResolutionTime: 0 }); expect(JSON.stringify(j)).not.toContain("RAW");
  });
  it("an outcome resolved after the claim is demoted to unresolved; a case with no resolution time is not trusted", async () => {
    const b = await build(); cv = claimView({ messageTimestamp: new Date("2024-03-05T00:00:00Z") }); rows = [row("k1"), row("k2", { originalMessageId: "k2", targetEvaluations: [] })];
    const j = (await b.get(URLS[0]!, b.token)).json(); expect(j.result.aggregate).toMatchObject({ wins: 0, unresolved: 2 }); expect(j.result.temporal).toMatchObject({ outcomeNotYetKnown: 1, unknownResolutionTime: 1 });
  });
  it("the store is asked only for cases BEFORE the claim's own message time, with a bound", async () => {
    const b = await build(); calls.length = 0; cv = claimView({ messageTimestamp: new Date("2024-03-01T00:00:00Z") }); rows = [row("k1")];
    const j = (await b.get(URLS[0]!, b.token)).json(); expect(j).toMatchObject({ state: "UNAVAILABLE", casesConsidered: 0, result: null }); expect(calls.find((c) => c.startsWith("rows:"))).toBe("rows:2024-03-01T00:00:00.000Z:2000");
  });
  it("ambiguous results are not applicable; unknown claims are 404", async () => {
    const b = await build(); cv = claimView({ resultKind: "ambiguous" }); expect((await b.get(URLS[0]!, b.token)).json()).toMatchObject({ state: "NOT_APPLICABLE", result: null });
    expect((await b.get(`/intelligence/claims/${ID(8)}/historical-matches`, b.token)).statusCode).toBe(404);
  });
  it("channel performance reports the funnel and never a reliability", async () => {
    const b = await build(), j = (await b.get(URLS[1]!, b.token)).json();
    expect(j).toMatchObject({ funnel: { claims: { claim: 2 }, candidacy: { CREATED: 1 } }, outcomes: { status: "NOT_AVAILABLE" }, reliability: "NOT_AVAILABLE", archive: { linked: false } });
    expect(j.channel.channel).toBe("***2544"); expect(JSON.stringify(j)).not.toContain("1001234567892544");
  });
  it("archive score tables: empty state, bounds, and numeric labels masked", async () => {
    const b = await build(); scorecards = [];
    expect((await b.get("/intelligence/archive/channels", b.token)).json()).toMatchObject({ state: "EMPTY", scorecards: [] });
    scorecards = [{ sourceId: ID(5), channelLabel: "-1001234567892544", asOf: T, algorithmVersion: "v", trustTier: null, metrics: [{ windowType: "ALL_TIME", windowStart: T, windowEnd: T, sampleSize: 3, metrics: {}, caveats: ["small sample"] }], sourceSnapshot: {} }];
    const j = (await b.get("/intelligence/archive/channels?limit=5", b.token)).json(); expect(j.state).toBe("OK"); expect(j.scorecards[0].channelLabel).toBe("***2544"); expect(j.scorecards[0].trustTier).toBeNull();
    for (const u of ["/intelligence/archive/channels?limit=0", "/intelligence/archive/channels?limit=101", "/intelligence/archive/channels?offset=-1", "/intelligence/archive/channels?offset=100001", "/intelligence/archive/channels?x=1"]) expect((await b.get(u, b.token)).statusCode, u).toBe(422);
  });
  it("playbook lists are bounded and validated; the version history is read-only text", async () => {
    const b = await build(); calls.length = 0;
    await b.get("/intelligence/playbooks?limit=7&offset=14", b.token); expect(calls).toContain("playbooks:7:14");
    for (const u of ["/intelligence/playbooks?limit=0", "/intelligence/playbooks?limit=201", "/intelligence/playbooks?offset=-1", "/intelligence/playbooks?channelId=nope", "/intelligence/playbooks/nope"]) expect((await b.get(u, b.token)).statusCode, u).toBe(422);
    expect((await b.get(`/intelligence/playbooks/${ID(4)}`, b.token)).statusCode).toBe(404);
  });
});
