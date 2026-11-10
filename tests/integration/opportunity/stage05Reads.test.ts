/**
 * Stage 05 additions against REAL PostgreSQL: the reward:risk screen and the provenance (engine version, config hash, calendar status) are stored on independent candidates; the calendar gate and the screen leave an explicit,
 * recorded no-op; concurrent deliveries of one slot create one scan and one candidate; paging is deterministic; an independent candidate has no claim. Synthetic fixture data only; every test uses fresh instrument names.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, memoryLastPrice, memoryOhlcProvider } from "../../../packages/agents/src/index";
import { createDb, getCandidate, getCandidateEvidence, listCandidateEvents, listCandidates, listScans } from "../../../packages/database/src/index";
import { opportunityConfigSha256, runOpportunityCycle, type ScanCalendar } from "../../../packages/opportunity/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import { NOW, breakoutUp, cfg } from "../../unit/opportunity/fixtures";

const URL_ = requireTestDatabaseUrl(), db = createDb(URL_), clients: pg.Client[] = [];
async function owner(): Promise<pg.Client> { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c); return c; }
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
const sym = (): string => `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const registry = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), agentConfig = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
function deps(u: string, over: Record<string, unknown> = {}, config = cfg({ universe: [u], minRankScore: 20 })) {
  const series = breakoutUp(u), ohlc = memoryOhlcProvider({ name: "fixture-ohlc", asOf: NOW.toISOString(), series: { [`NSE:${u}`]: series } });
  const lastClose = series.bars[series.bars.length - 1]!.close;
  return { db, config, ohlc, lastPrice: memoryLastPrice({ name: "fixture-price", prices: { [`NSE:${u}`]: { price: lastClose, asOf: NOW.toISOString() } } }), regime: null, registry, agentConfig, now: () => NOW, scope: { underlyings: [u] }, refuse: async () => undefined, ...over };
}
const cal = (market: "OPEN" | "CLOSED", ev: number | null = null): ScanCalendar => ({ name: "memory-calendar", async stateAt() { return { market, minutesToHighImpactEvent: ev }; } });
const scanOf = async (slot: string) => { const a = await owner(); const r = (await a.query("select status, scan_kind, skipped, parameters from opportunity_scans where slot_key = $1", [slot])).rows[0]; return r ? { status: r.status as string, scanKind: r.scan_kind as string, skipped: r.skipped as unknown, parameters: r.parameters as unknown } : undefined; };

describe("the screen and the provenance are stored with the candidate", () => {
  it("an independent candidate carries its reward:risk screen, engine version, config hash and calendar status; the scan records the parameters", async () => {
    const u = sym(), config = cfg({ universe: [u], minRankScore: 20 }), slot = `s5-${u}`;
    const r = await runOpportunityCycle(slot, deps(u, { calendar: cal("OPEN") }, config));
    expect(r.scan).toMatchObject({ status: "COMPLETED", created: expect.any(Number) }); expect(r.scan!.created).toBeGreaterThanOrEqual(1);
    const [c] = await listCandidates(db, { limit: 5, scope: { underlyings: [u] } }); expect(c).toMatchObject({ source: "INDEPENDENT", dataSource: "FIXTURE" });
    const ev = (await getCandidateEvidence(db, c!.id)) as Array<Record<string, unknown>>;
    expect(ev.find((e) => e["kind"] === "reward_risk_screen")).toMatchObject({ passed: true, version: "reward-risk-screen-v1" });
    expect(ev.find((e) => e["kind"] === "provenance")).toMatchObject({ engineVersion: "opportunity-scan-v1", configSha256: opportunityConfigSha256(config), calendar: "PROCEED", calibrated: false, confidence: null });
    const scan = await scanOf(slot); expect(scan).toMatchObject({ status: "COMPLETED", scanKind: "TECHNICAL_UNIVERSE" }); expect(scan!.parameters).toMatchObject({ minRewardRisk: 1.5, configSha256: opportunityConfigSha256(config) });
    const admin = await owner(); const row = (await admin.query("select source, claim_id from opportunity_candidates where id = $1", [c!.id])).rows[0];
    expect(row.source).toBe("INDEPENDENT"); expect(row.claim_id).toBeNull(); // independent discovery needs no Telegram claim
  });
  it("a screen minimum above what the setup offers creates nothing and records REWARD_RISK_BELOW_MIN on the scan", async () => {
    const u = sym(), slot = `s5r-${u}`, r = await runOpportunityCycle(slot, deps(u, {}, cfg({ universe: [u], minRankScore: 20, minRewardRisk: 9 })));
    expect(r.scan).toMatchObject({ status: "COMPLETED", created: 0 }); expect(await listCandidates(db, { limit: 5, scope: { underlyings: [u] } })).toEqual([]);
    expect(JSON.stringify((await scanOf(slot))!.skipped)).toContain("REWARD_RISK_BELOW_MIN");
  });
});
describe("the calendar gate leaves an explicit, recorded no-op", () => {
  it("a closed market completes the scan with no candidates and records MARKET_CLOSED for every instrument; no research runs", async () => {
    const u = sym(), slot = `s5c-${u}`, r = await runOpportunityCycle(slot, deps(u, { calendar: cal("CLOSED") }));
    expect(r.scan).toMatchObject({ status: "COMPLETED", created: 0, errorKind: null }); expect(r.research?.researched).toBe(0);
    expect(await listCandidates(db, { limit: 5, scope: { underlyings: [u] } })).toEqual([]); expect(JSON.stringify((await scanOf(slot))!.skipped)).toContain("MARKET_CLOSED");
  });
  it("an imminent high-impact event records EVENT_WINDOW", async () => {
    const u = sym(), slot = `s5e-${u}`; await runOpportunityCycle(slot, deps(u, { calendar: cal("OPEN", 10) }));
    expect(JSON.stringify((await scanOf(slot))!.skipped)).toContain("EVENT_WINDOW");
  });
});
describe("concurrency and paging", () => {
  it("concurrent deliveries of one slot produce one scan and one set of candidates", async () => {
    const u = sym(), slot = `s5x-${u}`, d = deps(u);
    const reports = await Promise.all(Array.from({ length: 5 }, () => runOpportunityCycle(slot, d)));
    expect(reports.filter((r) => r.scan?.state === "STARTED").length).toBe(1);
    const admin = await owner(); expect((await admin.query("select count(*)::int as n from opportunity_scans where slot_key = $1", [slot])).rows[0].n).toBe(1);
    const cands = await listCandidates(db, { limit: 50, scope: { underlyings: [u] } }); expect(new Set(cands.map((c) => c.id)).size).toBe(cands.length); expect(cands.length).toBeGreaterThanOrEqual(1);
    for (const c of cands) expect((await listCandidateEvents(db, c.id)).map((e) => e.toState)).toContain("NEW");
  });
  it("candidate paging is deterministic: offset pages do not overlap or skip (scoped to this test's instruments)", async () => {
    const us = [sym(), sym(), sym()]; for (const u of us) await runOpportunityCycle(`s5p-${u}`, deps(u));
    const scope = { underlyings: us }, all = (await listCandidates(db, { limit: 200, scope })).map((c) => c.id);
    expect(all.length).toBeGreaterThanOrEqual(3); expect(new Set(all).size).toBe(all.length);
    const pages: string[] = []; for (let off = 0; off < all.length; off++) pages.push(...(await listCandidates(db, { limit: 1, offset: off, scope })).map((c) => c.id));
    expect(pages).toEqual(all); // one at a time, in the same order, nothing repeated or skipped
    expect(await listCandidates(db, { limit: 5, offset: all.length, scope })).toEqual([]);
    expect((await getCandidate(db, all[0]!))?.id).toBe(all[0]);
  });
  it("scans are listed newest first (started_at then id), bounded, and the limit and offset are clamped", async () => {
    const u = sym(); await runOpportunityCycle(`s5l-${u}`, deps(u));
    const rows = await listScans(db, { limit: 50 }); expect(rows.length).toBeGreaterThanOrEqual(1); expect(rows.length).toBeLessThanOrEqual(50);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.startedAt.getTime() >= rows[i]!.startedAt.getTime()).toBe(true);
    expect((await listScans(db, { limit: 0 })).length).toBe(1); expect((await listScans(db, { limit: 1, offset: -5 })).length).toBe(1);
  });
});
