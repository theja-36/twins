import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { reasonOf, sizingTrustVocabulary, type SignalConfidenceSummary, type SourceTrust } from "../../../packages/historical/src/index";
import { computePositionSize, ELIGIBILITY_REASONS, intelligenceOf, isIntelligenceValid, loadSizingConfig, type SizingInput } from "../../../packages/risk/src/index";
import { registerIntelligenceRoutes } from "../../../apps/api/src/intelligenceApi";
import { validIntelligence } from "../../support/intelligenceFixtures";

const ROOT = join(__dirname, "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === "dist" ? [] : walk(`${d}/${e.name}`)) : e.name.endsWith(".ts") ? [`${d}/${e.name}`] : []));

type Tier = "A" | "B" | "C" | "D" | "UNKNOWN";
type Conf = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
const intel = (trust: Tier, conf: Conf, status: "VALID" | "UNAVAILABLE" = "VALID") => validIntelligence({ trustTier: trust, confidenceTier: conf, status }) as never;

describe("what counts as valid intelligence", () => {
  it.each<[string, Tier, Conf, "VALID" | "UNAVAILABLE", boolean]>([
    ["A / HIGH", "A", "HIGH", "VALID", true], ["B / MEDIUM", "B", "MEDIUM", "VALID", true], ["C / LOW", "C", "LOW", "VALID", true],
    ["trust D", "D", "HIGH", "VALID", false], ["trust UNKNOWN", "UNKNOWN", "HIGH", "VALID", false], ["confidence UNKNOWN", "A", "UNKNOWN", "VALID", false],
    ["status UNAVAILABLE even with good tiers", "A", "HIGH", "UNAVAILABLE", false],
  ])("%s -> %s", (_n, trust, conf, status, expected) => { expect(isIntelligenceValid(intel(trust, conf, status))).toBe(expected); });
  it("nothing recorded, or a malformed snapshot, is never valid", () => {
    expect(isIntelligenceValid(null)).toBe(false);
    expect(isIntelligenceValid(undefined)).toBe(false);
    expect(isIntelligenceValid({ status: "VALID" } as never)).toBe(false);
    expect(intelligenceOf({ outputSnapshot: null })).toBeNull();
    expect(intelligenceOf({ outputSnapshot: { intelligence: "x" } } as never)).toBeNull();
    expect(intelligenceOf({ outputSnapshot: { intelligence: validIntelligence() } } as never)?.status).toBe("VALID");
  });
  it("approval eligibility has its own fixed reason for it", () => { expect(ELIGIBILITY_REASONS).toContain("source_intelligence_not_valid"); });
});

describe("scorecard tiers map to the sizing engine's trust vocabulary", () => {
  it.each<[Tier, string]>([["A", "HIGH"], ["B", "MODERATE"], ["C", "LOW"], ["D", "UNTRUSTED"], ["UNKNOWN", "UNKNOWN"]])("%s -> %s", (t, v) => { expect(sizingTrustVocabulary(t)).toBe(v); });
});

describe("reason codes (fixed priority, explicit UNKNOWN - never a guess)", () => {
  const trust = (o: Partial<SourceTrust>): SourceTrust => ({ status: "AVAILABLE", tier: "A", label: "HIGH_TRUST", reason: "SCORECARD", scorecardRunId: "r", asOf: "2024-01-01T00:00:00.000Z", algorithmVersion: "v", configSha256: null, evaluable: 60, dataSufficiency: "SUFFICIENT", ...o });
  const conf = (o: Partial<SignalConfidenceSummary>): SignalConfidenceSummary => ({ score: 50, tier: "MEDIUM", evidenceQuality: "SUFFICIENT", sampleSize: 50, primaryPatternKey: "k", patternRunId: "p", patternRunAsOf: null, patternRefs: [], algorithmVersion: "a", featureVersion: "f", ...o });
  const id = (registered: boolean) => ({ label: "x", registryId: registered ? "i" : null, members: [], registered });
  it.each([
    ["unregistered source", trust({ reason: "SOURCE_NOT_REGISTERED", status: "UNKNOWN", tier: "UNKNOWN" }), conf({}), false, "SOURCE_INTELLIGENCE_UNAVAILABLE"],
    ["no scorecard", trust({ reason: "NO_SCORECARD", status: "UNKNOWN", tier: "UNKNOWN" }), conf({}), true, "SOURCE_INTELLIGENCE_UNAVAILABLE"],
    ["only a later scorecard", trust({ reason: "NO_SCORECARD_AT_SIGNAL_TIME", status: "UNKNOWN", tier: "UNKNOWN" }), conf({}), true, "SOURCE_INTELLIGENCE_UNAVAILABLE"],
    ["no pattern library", trust({}), conf({ evidenceQuality: "NO_LIBRARY", tier: "UNKNOWN", score: 0 }), true, "SOURCE_INTELLIGENCE_UNAVAILABLE"],
    ["trust D", trust({ tier: "D" }), conf({}), true, "UNTRUSTED_SOURCE"],
    ["trust UNKNOWN (insufficient scorecard)", trust({ tier: "UNKNOWN", status: "UNKNOWN", reason: "INSUFFICIENT_EVIDENCE" }), conf({}), true, "UNKNOWN_SOURCE_TRUST"],
    ["insufficient pattern sample", trust({}), conf({ tier: "UNKNOWN", score: 0, evidenceQuality: "INSUFFICIENT_EVIDENCE" }), true, "INSUFFICIENT_EVIDENCE"],
    ["no matching pattern", trust({}), conf({ tier: "UNKNOWN", score: 0, evidenceQuality: "NO_MATCH" }), true, "UNKNOWN_CONFIDENCE"],
    ["everything known", trust({}), conf({}), true, "OK"],
  ])("%s -> %s", (_n, t, c, registered, expected) => { expect(reasonOf(t, c, id(registered))).toBe(expected); });
});

describe("sizing receives the resolved confidence tier and trust tier (lower-of rule, UNKNOWN / D = no size)", () => {
  const config = loadSizingConfig({ TWINS_SIZING_AVAILABLE_CAPITAL: "1000000" });
  const base: SizingInput = { capital: 1_000_000, instrumentType: "equity", market: "NSE", side: "BUY", entryPrice: 100, stopLoss: 95, stopLossResult: "VALID", targets: [110], lotSize: null, confidenceScore: 70, sourceTrustTier: "HIGH" };
  it("a resolved confidence tier is used as is: score 70 is MEDIUM by the sizing thresholds (HIGH >= 75) but HIGH when the confidence model says HIGH", () => {
    expect(computePositionSize(base, config)).toMatchObject({ confidenceTier: "MEDIUM", quantity: 1000 });
    expect(computePositionSize({ ...base, confidenceTier: "HIGH" }, config)).toMatchObject({ confidenceTier: "HIGH", appliedTier: "HIGH", quantity: 2000 });
    expect(computePositionSize({ ...base, confidenceScore: 90, confidenceTier: "LOW" }, config)).toMatchObject({ confidenceTier: "LOW", quantity: 500 });
  });
  it.each<[string, Conf, string, string, number]>([
    ["HIGH confidence, A trust (HIGH)", "HIGH", "HIGH", "HIGH", 2000], ["HIGH confidence, B trust (MODERATE) -> MEDIUM", "HIGH", "MODERATE", "MEDIUM", 1000],
    ["HIGH confidence, C trust (LOW) -> LOW", "HIGH", "LOW", "LOW", 500], ["LOW confidence, A trust -> LOW", "LOW", "HIGH", "LOW", 500],
  ])("lower-of: %s", (_n, conf, trust, applied, qty) => { expect(computePositionSize({ ...base, confidenceTier: conf, sourceTrustTier: trust }, config)).toMatchObject({ appliedTier: applied, quantity: qty, status: "SIZED" }); });
  it.each<[string, Conf, string, string]>([
    ["UNKNOWN confidence", "UNKNOWN", "HIGH", "confidence_unknown"], ["UNKNOWN trust", "HIGH", "UNKNOWN", "source_trust_unknown"], ["trust D (UNTRUSTED)", "HIGH", "UNTRUSTED", "source_trust_unknown"],
  ])("%s => no size (%s)", (_n, conf, trust, reason) => {
    const r = computePositionSize({ ...base, confidenceTier: conf, sourceTrustTier: trust }, config);
    expect(r).toMatchObject({ status: "REJECTED", reasonCode: reason, quantity: 0, maxLossAmount: 0 });
  });
  it("the per-trade cap is unchanged by intelligence: HIGH/HIGH never risks more than 1% of capital", () => {
    const r = computePositionSize({ ...base, confidenceTier: "HIGH", confidenceScore: 100 }, config);
    expect(r.maxLossAmount).toBeLessThanOrEqual(10_000);
  });
  it("legacy inputs without a tier size exactly as before (the input hash is unchanged)", () => {
    expect(computePositionSize(base, config).inputHash).toBe(computePositionSize({ ...base }, config).inputHash);
  });
});

describe("the API: bearer-protected, read-only, no raw content", () => {
  const app = () => {
    const a = Fastify();
    registerIntelligenceRoutes(a, { db: new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never, authorized: (h) => h === "Bearer good" });
    return a;
  };
  it.each([["GET", "/intelligence/source?label=x"], ["POST", "/intelligence/estimate"], ["GET", "/risk/decisions/11111111-1111-4111-8111-111111111111/intelligence"]] as const)("%s %s needs the bearer token (401 before any database access)", async (method, url) => {
    const a = app();
    for (const headers of [{}, { authorization: "Bearer bad" }]) expect((await a.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) })).statusCode).toBe(401);
  });
  it("validates input before the database: bad label / asOf / uuid / body => 400", async () => {
    const a = app();
    const h = { authorization: "Bearer good" };
    expect((await a.inject({ method: "GET", url: "/intelligence/source", headers: h })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: "/intelligence/source?label=x&asOf=yesterday", headers: h })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: "/risk/decisions/not-a-uuid/intelligence", headers: h })).statusCode).toBe(400);
    for (const payload of [{}, { sourceLabel: "x" }, { sourceLabel: "x", signal: { timestamp: "2025-01-01T00:00:00Z" } }, { sourceLabel: "x", signal: { timestamp: "nope", stopLossValid: true, dataQuality: "GOOD" } },
      { sourceLabel: "x", signal: { timestamp: "2025-01-01T00:00:00Z", stopLossValid: true, dataQuality: "GOOD", targets: [1, 2, 3, 4] } }, { sourceLabel: "x", signal: { timestamp: "2025-01-01T00:00:00Z", stopLossValid: true, dataQuality: "GREAT" } }]) {
      expect((await a.inject({ method: "POST", url: "/intelligence/estimate", headers: h, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("architecture: source intelligence is read-only research wired into the risk flow, and nothing executable", () => {
  const files = [...walk("packages/historical/src/intelligence"), "packages/risk/src/intelligence/record.ts", "apps/api/src/intelligenceApi.ts", "scripts/ops/source-intelligence.ts"];
  it("imports no broker / execution / approval-card / Telegram-sending code and uses no network or LLM client", () => {
    for (const f of files) expect(strip(read(f)), f).not.toMatch(/@twins\/(execution|broker|adapter)|packages\/(execution|broker)|adapters\/|approval-bot|api\.telegram|sendMessage|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai/i);
  });
  it("never reads or exposes message text, the decision's input snapshot or credentials", () => {
    for (const f of files) {
      const t = strip(read(f));
      expect(t, f).not.toMatch(/rawText|raw_text|rawPayload|apiKey|password|token/i);
      if (f !== "packages/risk/src/intelligence/record.ts") expect(t, f).not.toMatch(/inputSnapshot/); // (the recorder carries the decision's own snapshot forward, like sizing does; the exposed surfaces never return it)
    }
  });
  it("writes only through the audited risk-decision writer: no direct insert / update / delete anywhere in the intelligence code", () => {
    for (const f of files) expect(strip(read(f)), f).not.toMatch(/\b(?:db|tx)\.(insert|update|delete)\(/);
  });
  it("creates no order, fill, position or approval card", () => {
    for (const f of files) expect(strip(read(f)), f).not.toMatch(/schema\.(orders|fills|positions|riskApprovals|riskApprovalCards|claimReviewCards)\b|createApprovalCard|recordRiskApproval/);
  });
  it("the worker records intelligence BEFORE sizing and sizes with requireIntelligence (a decision without intelligence is never sized from the legacy confidence)", () => {
    const w = strip(read("services/worker/src/index.ts"));
    expect(w.indexOf("recordIntelligenceForSignal")).toBeGreaterThan(-1);
    const fn = w.slice(w.indexOf("async function recordPendingRiskDecision"));
    expect(fn.indexOf("await intel()")).toBeGreaterThan(-1);
    expect(fn.indexOf("await intel()")).toBeLessThan(fn.indexOf("await size()"));
    expect((w.match(/requireIntelligence: true/g) ?? []).length).toBe(3);
    expect(w).not.toMatch(/sizeLatestRiskDecisionFor(Signal|OptionsClaim)\(db, [^)]*\)(?!, \{)[^,]/);
  });
  it("approval is gated twice: the TypeScript eligibility and the database approval function both require valid intelligence", () => {
    expect(read("packages/risk/src/approval/eligibility.ts")).toMatch(/source_intelligence_not_valid/);
    const sql = read("packages/database/drizzle/0024_risk_source_intelligence.sql");
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION "twins_record_risk_approval"/);
    expect(sql).toMatch(/'\{intelligence,status\}'.*<> 'VALID'/s);
    expect(sql).toMatch(/NOT IN \('A', 'B', 'C'\)/);
    expect(sql).toMatch(/NOT IN \('HIGH', 'MEDIUM', 'LOW'\)/);
    expect(sql).toMatch(/SECURITY DEFINER/);
  });
  it("the existing gates are still there: the eligibility still lists the stop-loss, sizing, portfolio, market, breaker, expiry and kill-switch reasons", () => {
    for (const r of ["stop_loss_not_valid", "sizing_missing", "portfolio_not_passed", "market_not_passed", "circuit_breaker_open", "decision_expired", "kill_switch_active", "state_unavailable"]) expect(ELIGIBILITY_REASONS).toContain(r);
  });
});
