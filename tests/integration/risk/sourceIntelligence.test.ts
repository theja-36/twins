/**
 * Source intelligence in the live risk flow against REAL PostgreSQL (Stage 4 / Task 5). Synthetic history goes through the real importer, evaluator, scorecard and pattern code;
 * synthetic LIVE signals (no real Telegram channel) go through the real risk-decision chain: pending -> intelligence -> sizing -> portfolio -> market gates -> eligibility.
 * No order, fill, position, approval card or broker call is created by anything under test. Each run uses its own symbol and channel labels (market BSE: the market-risk gates need a real session market).
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  getSignalIntelligence, inspectInput, linkAlias, memoryProvider, rebuildPatternLibrary, rebuildPatternMetrics, rebuildScorecard, registerSources, resolveSource, runEvaluation, runImport,
} from "../../../packages/historical/src/index";
import {
  assessApprovalEligibility, createPendingRiskDecisionForSignal, createRiskDecision, getRiskDecision, intelligenceOf, listRiskDecisions, loadPortfolioConfig, recordIntelligenceForSignal, recordRiskApproval,
  recordSourceIntelligence, RiskDecisionError, sizeLatestRiskDecisionForSignal, sizeRiskDecision, type IntelligenceResolver, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { registerIntelligenceRoutes } from "../../../apps/api/src/intelligenceApi";
import { runCli } from "../../../scripts/ops/source-intelligence";
import { tempDir, writeJsonl } from "../../support/historicalFixtures";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { dailyBars, datasetOf, equitySeries, type Ohlc } from "../../support/outcomeFixtures";
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";
import { healthy, OPEN_NOW, syntheticProvider } from "./gates";
import { evaluateMarketRisk, evaluatePortfolioRisk } from "../../../packages/risk/src/index";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
let state: InMemoryStateSource;
const db = () => handle.db;
const sfx = () => randomUUID().slice(0, 8);
const NOW = new Date("2026-10-30T10:00:00Z");
const EVAL_AS_OF = new Date("2026-06-01T00:00:00Z");
const KNOWLEDGE_AS_OF = new Date("2024-09-01T00:00:00Z");
const START = Date.parse("2020-01-06T00:00:00Z");
const DAY = 86_400_000;
const SIGNAL_TIME = new Date("2025-01-06T00:00:00Z"); // after every scorecard and pattern run
const MKT = "BSE", SYM = randomLetters(6); // a real session market (the market gates need one); the symbol is unique per run, so the level 2-4 patterns are isolated
const CAPITAL = 1_000_000;
const CH = `tg_chat_-100${Math.floor(Math.random() * 1e9)}`; // a LIVE-style channel identifier, used as the archive label so the identities match
const LIVE_TABLES = ["orders", "fills", "positions", "risk_approvals", "risk_approval_cards", "decisions", "claim_review_cards", "telegram_intake_outbox"];

beforeAll(async () => {
  handle = createBoundedDb(DATABASE_URL, { max: 6, idleTimeoutMillis: 10_000 });
  state = inMemoryStateSource();
  configureRuntimeState({ source: state, ttlMs: 0, failureTtlMs: 0 });
  await seedKnowledge();
});
afterEach(() => { state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const counts = async (tables: string[]) => Promise.all(tables.map(async (t) => Number(must((await q(`select count(*)::int as n from ${t}`))[0])["n"])));

type Kind = "w" | "l";
const mixed = (wins: number, losses: number): Kind[] => { const out: Kind[] = []; let w = 0, l = 0; while (w < wins || l < losses) { if (w < wins && (l >= losses || w / wins <= l / losses)) { out.push("w"); w++; } else { out.push("l"); l++; } } return out; };
const OUT: Record<Kind, Ohlc> = { w: [100, 111, 100, 110], l: [100, 100, 94, 95] };
const text = (sym: string) => `BUY ${sym} @ 100 SL 95 TGT 105 110 115`;

/** Imports 50 daily-aligned history messages for `channel`, labels them with the real evaluator, builds the scorecard and the pattern library (as of 2024-09-01). */
async function seedChannelHistory(channel: string, sym: string, kinds: Kind[], firstId = 1) {
  const recs = kinds.map((_, i) => ({ channel, message_id: firstId + i, timestamp: new Date(START + 31 * i * DAY).toISOString(), text: text(sym), market: MKT }));
  const file = writeJsonl(tempDir(), "export.jsonl", recs);
  const imp = await runImport(db(), await inspectInput(file), { label: `si-${sfx()}`, defaultMarket: MKT, createdBy: "service:itest", confirmedSource: file, now: NOW });
  const at: Record<number, Ohlc> = {};
  kinds.forEach((k, i) => { at[31 * i + 3] = OUT[k]; });
  const series = equitySeries(sym, dailyBars({ start: new Date(START), days: 31 * kinds.length + 2, base: 100, at }), { market: MKT });
  await runEvaluation(db(), { scope: { kind: "BATCH", batchId: imp.batchId }, provider: memoryProvider([datasetOf([series], { dataset_id: `si-${sfx()}` })]), createdBy: "service:itest", asOf: EVAL_AS_OF });
}
async function seedKnowledge() {
  await seedChannelHistory(CH, SYM, mixed(30, 20));
  await registerSources(db(), "service:itest");
  await rebuildScorecard(db(), must(await resolveSource(db(), CH)), { asOf: KNOWLEDGE_AS_OF, createdBy: "service:itest" });
  await rebuildPatternLibrary(db(), "service:itest");
  await rebuildPatternMetrics(db(), { asOf: KNOWLEDGE_AS_OF, createdBy: "service:itest" });
}

let instrumentId: string | null = null;
/** A synthetic LIVE signal (a telegram_sources / telegram_messages pair named by `channel`, no real channel) with VALID stop-loss evidence; `pending` also creates its PENDING risk decision. */
async function makeSignal(channel: string, ts: Date = SIGNAL_TIME) {
  if (!instrumentId) instrumentId = must((await db().insert(schema.instruments).values({ symbol: SYM, exchange: MKT, instrumentType: "equity" }).returning())[0]).id;
  await db().insert(schema.telegramSources).values({ channelIdentifier: channel }).onConflictDoNothing();
  const sid = must((await q("select id from telegram_sources where channel_identifier = $1", [channel]))[0])["id"] as string;
  const [msg] = await db().insert(schema.telegramMessages).values({ telegramSourceId: sid, externalMessageId: sfx(), messageTimestamp: ts, rawText: "SYNTHETIC live fixture", rawPayload: {} }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", telegramMessageId: must(msg).id, instrumentId, parserVersion: "si-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [105, 110, 115], signalTimestamp: ts }).returning();
  const [stop] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  return { signalId: must(signal).id, stopLossValidationId: must(stop).id };
}
async function makeLive(channel: string, ts: Date = SIGNAL_TIME) {
  const s = await makeSignal(channel, ts);
  const pending = await createPendingRiskDecisionForSignal(db(), s.signalId);
  if (pending.skipped) throw new Error("no pending decision");
  return { signalId: s.signalId, pendingId: pending.id };
}
const openLimits = () => loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" });
const BIG = 1_000_000_000;
async function throughGates(sizedId: string) {
  const pf = await evaluatePortfolioRisk(db(), sizedId, { config: openLimits(), capital: BIG });
  if (pf.status !== "PENDING") return { pf, mk: null };
  return { pf, mk: await evaluateMarketRisk(db(), pf.id, { provider: syntheticProvider(healthy(OPEN_NOW)), now: OPEN_NOW, capital: BIG }) };
}
const synthetic = (over: Parameters<typeof validIntelligence>[0]): IntelligenceResolver => async (req) => ({ ...(validIntelligence(over) as never as Awaited<ReturnType<IntelligenceResolver>>), asOf: req.asOf?.toISOString() ?? req.signal.timestamp.toISOString(), inputHash: createHash("sha256").update(JSON.stringify(over)).digest("hex") });

describe("the full chain for a source with real history", () => {
  it("resolves point-in-time intelligence, records it as a new version, sizes with the resolved tiers, passes the gates and becomes approval-eligible", async () => {
    const live = await makeLive(CH);
    const before = await counts(LIVE_TABLES);
    const out = await recordSourceIntelligence(db(), live.pendingId);
    expect(out).toMatchObject({ created: true, decisionVersion: 2, status: "PENDING", intelligenceStatus: "VALID", reasonCode: "OK", trustTier: "A", confidenceTier: "MEDIUM" });
    const v2 = must(await getRiskDecision(db(), out.id));
    expect(v2).toMatchObject({ supersedesId: live.pendingId, createdBy: "service:source-intelligence", decisionReasonCode: "source_intelligence_recorded", sourceTrustTier: "HIGH" });
    expect(v2.confidenceScore).not.toBeNull();
    const i = must(intelligenceOf(v2));
    expect(i).toMatchObject({ status: "VALID", engineVersion: "source-intelligence-v1", asOf: SIGNAL_TIME.toISOString(), dataSufficiency: "SUFFICIENT", sizingTrustTier: "HIGH" });
    expect(i.sourceIdentity).toMatchObject({ label: CH, registered: true });
    expect(i.trust).toMatchObject({ tier: "A", dataSufficiency: "SUFFICIENT", reason: "SCORECARD" });
    expect(new Date(i.trust.asOf as string).getTime()).toBeLessThanOrEqual(SIGNAL_TIME.getTime()); // point in time
    expect(i.confidence).toMatchObject({ tier: "MEDIUM", evidenceQuality: "SUFFICIENT", sampleSize: 50 });
    expect(new Date(i.confidence.patternRunAsOf as string).getTime()).toBeLessThanOrEqual(SIGNAL_TIME.getTime());
    expect(i.confidence.patternRefs.map((p) => p.level)).toEqual([1, 2, 3, 4]);
    expect(i.explanation.length).toBeGreaterThan(0);
    expect(i.limitations).toEqual(expect.arrayContaining(["HISTORICAL_ASSOCIATION_ONLY", "NO_CAUSAL_CLAIM"]));
    expect(JSON.stringify(i)).not.toMatch(/SYNTHETIC live fixture|BUY .* @ 100/); // no message text
    expect(v2.evidenceReferences).toMatchObject({ scorecardRunId: i.trust.scorecardRunId, patternRunId: i.confidence.patternRunId, intelligenceInputHash: i.inputHash });

    // sizing receives MEDIUM confidence and HIGH trust (A): lower-of = MEDIUM -> 50% of the 1% cap = 5,000 / 5 = 1,000 shares
    const sized = await sizeLatestRiskDecisionForSignal(db(), live.signalId, { capital: CAPITAL, requireIntelligence: true });
    if ("skipped" in sized) throw new Error("skipped");
    expect(sized).toMatchObject({ created: true, sizingStatus: "SIZED", quantity: 1000, maxLossAmount: 5000, decisionVersion: 3 });
    const v3 = must(await getRiskDecision(db(), sized.id));
    expect(v3.outputSnapshot).toMatchObject({ sizing: { status: "SIZED", appliedTier: "MEDIUM" }, intelligence: { status: "VALID", inputHash: i.inputHash } }); // carried forward
    expect((v3.inputSnapshot as { sizing: { input: { confidenceTier: string; sourceTrustTier: string } } }).sizing.input).toMatchObject({ confidenceTier: "MEDIUM", sourceTrustTier: "HIGH" });
    expect(Number(v3.plannedMaxLossPercent)).toBe(0.5);

    // every existing gate still runs; the final version is approval-eligible and the database function agrees
    const { mk } = await throughGates(sized.id);
    expect(mk).toMatchObject({ status: "APPROVED_FOR_REVIEW", marketOutcome: "PASSED" });
    const approved = must(mk).id;
    expect(must(intelligenceOf(must(await getRiskDecision(db(), approved)))).status).toBe("VALID");
    expect(await assessApprovalEligibility(db(), approved)).toMatchObject({ eligible: true, reasons: [] });
    expect(await counts(LIVE_TABLES)).toEqual(before); // no order, fill, position, card, approval or legacy decision
    expect((await recordRiskApproval(db(), { decisionId: approved, action: "APPROVE", actor: "operator:itest", reason: "itest" })).outcome).toBe("recorded"); // the database function accepts valid intelligence
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
    expect(await listRiskDecisions(db(), { signalId: live.signalId })).toHaveLength(5); // pending, intelligence, sizing, portfolio, market: versioned, nothing updated
  });

  it("is idempotent: recording again (also from the worker's retry path) returns the same version and writes nothing", async () => {
    const live = await makeLive(CH);
    const first = await recordSourceIntelligence(db(), live.pendingId);
    const again = await recordSourceIntelligence(db(), live.pendingId); // against the version it superseded
    expect(again).toMatchObject({ created: false, id: first.id });
    expect(await recordSourceIntelligence(db(), first.id)).toMatchObject({ created: false, id: first.id });
    const sized = await sizeLatestRiskDecisionForSignal(db(), live.signalId, { capital: CAPITAL, requireIntelligence: true });
    if ("skipped" in sized) throw new Error("skipped");
    const retry = await recordIntelligenceForSignal(db(), live.signalId); // after sizing exists: a no-op, never a second intelligence version
    if ("skipped" in retry) throw new Error("skipped");
    expect(retry).toMatchObject({ created: false });
    expect(await listRiskDecisions(db(), { signalId: live.signalId })).toHaveLength(3);
  });

  it("concurrent workers record exactly one intelligence version", async () => {
    const live = await makeLive(CH);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => recordSourceIntelligence(db(), live.pendingId)));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await listRiskDecisions(db(), { signalId: live.signalId })).toHaveLength(2);
  });
});

describe("UNKNOWN intelligence never sizes and can never become approval-eligible", () => {
  it("an unregistered source: UNAVAILABLE / SOURCE_INTELLIGENCE_UNAVAILABLE, the decision stays PENDING and unsized, sizing REJECTS with the explicit reason", async () => {
    const live = await makeLive(`tg_chat_-100${Math.floor(Math.random() * 1e9)}`);
    const out = await recordSourceIntelligence(db(), live.pendingId);
    expect(out).toMatchObject({ intelligenceStatus: "UNAVAILABLE", reasonCode: "SOURCE_INTELLIGENCE_UNAVAILABLE", trustTier: "UNKNOWN", status: "PENDING" });
    const v2 = must(await getRiskDecision(db(), out.id));
    expect(v2).toMatchObject({ decisionReasonCode: "source_intelligence_unavailable", sourceTrustTier: "UNKNOWN", confidenceScore: null, plannedQuantity: null });
    const sized = await sizeLatestRiskDecisionForSignal(db(), live.signalId, { capital: CAPITAL, requireIntelligence: true });
    if ("skipped" in sized) throw new Error("skipped");
    expect(sized).toMatchObject({ sizingStatus: "REJECTED", quantity: 0, status: "REJECTED" });
    expect(must(await getRiskDecision(db(), sized.id))).toMatchObject({ decisionReasonCode: "source_intelligence_unavailable", plannedQuantity: null, plannedNotional: null });
    expect(await assessApprovalEligibility(db(), sized.id)).toMatchObject({ eligible: false });
  });

  it.each<[string, Parameters<typeof validIntelligence>[0], string, string]>([
    ["trust D", { trustTier: "D", confidenceTier: "HIGH", status: "UNAVAILABLE", reasonCode: "UNTRUSTED_SOURCE" }, "untrusted_source", "confidence_unknown"],
    ["trust UNKNOWN", { trustTier: "UNKNOWN", confidenceTier: "HIGH", status: "UNAVAILABLE", reasonCode: "UNKNOWN_SOURCE_TRUST" }, "unknown_source_trust", "confidence_unknown"],
    ["confidence UNKNOWN (insufficient evidence)", { trustTier: "A", confidenceTier: "UNKNOWN", score: 0, status: "UNAVAILABLE", reasonCode: "INSUFFICIENT_EVIDENCE" }, "insufficient_evidence", "confidence_unknown"],
    ["confidence UNKNOWN (no pattern match)", { trustTier: "B", confidenceTier: "UNKNOWN", score: 0, status: "UNAVAILABLE", reasonCode: "UNKNOWN_CONFIDENCE" }, "unknown_confidence", "confidence_unknown"],
  ])("%s => explicit reason, no size", async (_n, over, decisionReason, engineReason) => {
    const live = await makeLive(CH);
    const out = await recordSourceIntelligence(db(), live.pendingId, { resolve: synthetic(over) });
    expect(out.intelligenceStatus).toBe("UNAVAILABLE");
    expect(must(await getRiskDecision(db(), out.id)).decisionReasonCode).toBe(decisionReason);
    const sized = await sizeLatestRiskDecisionForSignal(db(), live.signalId, { capital: CAPITAL, requireIntelligence: true });
    if ("skipped" in sized) throw new Error("skipped");
    expect(sized).toMatchObject({ sizingStatus: "REJECTED", quantity: 0 });
    const v = must(await getRiskDecision(db(), sized.id));
    expect(v).toMatchObject({ status: "REJECTED", decisionReasonCode: decisionReason, plannedQuantity: null });
    expect((v.outputSnapshot as { sizing: { reasonCode: string } }).sizing.reasonCode).toBe(engineReason);
  });

  it("a decision sized WITHOUT intelligence (legacy path) can reach review but is never approval-eligible, and the database function refuses the approval too", async () => {
    const s = await makeSignal(CH);
    const v1 = await createRiskDecision(db(), {
      subject: { kind: "signal", signalId: s.signalId }, stopLossValidationId: s.stopLossValidationId, status: "PENDING", idempotencyKey: `si-legacy:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: MKT, symbol: SYM, side: "BUY",
      entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { synthetic: true, signalValidation: { decisionConfidence: 0.9 } }, outputSnapshot: { stage: "risk_decision_foundation" },
    });
    const sized = await sizeRiskDecision(db(), v1.id, { capital: CAPITAL }); // legacy: not requiring intelligence
    expect(sized).toMatchObject({ sizingStatus: "SIZED" });
    const { mk } = await throughGates(sized.id);
    const approvedId = must(mk).id;
    expect(must(await getRiskDecision(db(), approvedId)).status).toBe("APPROVED_FOR_REVIEW");
    const a = await assessApprovalEligibility(db(), approvedId);
    expect(a.eligible).toBe(false);
    expect(a.reasons).toContain("source_intelligence_not_valid");
    expect(await recordRiskApproval(db(), { decisionId: approvedId, action: "APPROVE", actor: "operator:itest", reason: "itest" })).toMatchObject({ outcome: "refused" });
    expect(Number(must((await q("select count(*)::int as n from risk_approvals where risk_decision_id = $1", [approvedId]))[0])["n"])).toBe(0);
  });
});

describe("tier caps reach sizing", () => {
  it.each<[string, Parameters<typeof validIntelligence>[0], number, string]>([
    ["trust B (MODERATE) caps HIGH confidence at MEDIUM", { trustTier: "B", confidenceTier: "HIGH" }, 1000, "MEDIUM"],
    ["trust C (LOW) caps HIGH confidence at LOW", { trustTier: "C", confidenceTier: "HIGH" }, 500, "LOW"],
    ["LOW confidence caps trust A at LOW", { trustTier: "A", confidenceTier: "LOW", score: 20 }, 500, "LOW"],
    ["trust A with HIGH confidence sizes at the full per-trade cap (unchanged limit)", { trustTier: "A", confidenceTier: "HIGH" }, 2000, "HIGH"],
  ])("%s", async (_n, over, qty, applied) => {
    const live = await makeLive(CH);
    await recordSourceIntelligence(db(), live.pendingId, { resolve: synthetic(over) });
    const sized = await sizeLatestRiskDecisionForSignal(db(), live.signalId, { capital: CAPITAL, requireIntelligence: true });
    if ("skipped" in sized) throw new Error("skipped");
    expect(sized).toMatchObject({ sizingStatus: "SIZED", quantity: qty });
    expect((must(await getRiskDecision(db(), sized.id)).outputSnapshot as { sizing: { appliedTier: string } }).sizing.appliedTier).toBe(applied);
    expect(sized.maxLossAmount).toBeLessThanOrEqual(10_000); // 1% of capital: never raised by intelligence
  });
  it("requireIntelligence rejects a decision that has none recorded (never sized from the legacy confidence)", async () => {
    const live = await makeLive(CH);
    const sized = await sizeLatestRiskDecisionForSignal(db(), live.signalId, { capital: CAPITAL, requireIntelligence: true });
    if ("skipped" in sized) throw new Error("skipped");
    expect(sized).toMatchObject({ sizingStatus: "REJECTED", quantity: 0 });
    expect(must(await getRiskDecision(db(), sized.id)).decisionReasonCode).toBe("source_intelligence_missing");
  });
});

describe("point-in-time integrity and source identity", () => {
  const sig = (ts: string) => ({ market: MKT, instrumentType: "equity", underlying: SYM, optionType: null, side: "buy", entry: { type: "at", price: 100 }, stopLoss: 95, targets: [105, 110, 115], expiryDate: null, timestamp: new Date(ts), stopLossValid: true, dataQuality: "GOOD" as const });
  it("a scorecard or pattern run that post-dates the signal is never used", async () => {
    const early = await getSignalIntelligence(db(), { sourceLabel: CH, signal: sig("2024-02-01T00:00:00Z"), marketContext: { available: false } }); // knowledge was built as of 2024-09-01
    expect(early).toMatchObject({ status: "UNAVAILABLE", reasonCode: "SOURCE_INTELLIGENCE_UNAVAILABLE", trust: { tier: "UNKNOWN", reason: "NO_SCORECARD_AT_SIGNAL_TIME", scorecardRunId: null }, confidence: { tier: "UNKNOWN" } });
    if (early.confidence.patternRunAsOf) expect(new Date(early.confidence.patternRunAsOf).getTime()).toBeLessThanOrEqual(new Date("2024-02-01T00:00:00Z").getTime()); // never a later pattern run
    expect(early.asOf).toBe("2024-02-01T00:00:00.000Z");
    const later = await getSignalIntelligence(db(), { sourceLabel: CH, signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: false } });
    expect(later).toMatchObject({ status: "VALID", trust: { tier: "A" } });
    const explicit = await getSignalIntelligence(db(), { sourceLabel: CH, signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: false }, asOf: new Date("2024-02-01T00:00:00Z") }); // an explicit earlier instant wins
    expect(explicit.status).toBe("UNAVAILABLE");
  });
  it("the same inputs always give the same result (deterministic, no clock)", async () => {
    const a = await getSignalIntelligence(db(), { sourceLabel: CH, signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: true } });
    const b = await getSignalIntelligence(db(), { sourceLabel: CH, signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: true } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("source identity: a live channel that is an explicitly linked ALIAS of a scored source resolves to the canonical source; an unlinked one does not", async () => {
    const aliasLabel = `tg_chat_-100${Math.floor(Math.random() * 1e9)}`;
    await seedChannelHistory(aliasLabel, SYM, ["w"], 5000); // the archive also contains the alias label
    await registerSources(db(), "service:itest");
    const before = await getSignalIntelligence(db(), { sourceLabel: aliasLabel, signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: false } });
    expect(before.trust.tier).toBe("UNKNOWN"); // its own identity has no scorecard
    await linkAlias(db(), { alias: aliasLabel, canonical: CH, reason: "operator-confirmed: same channel, renamed", createdBy: "operator:itest" });
    const after = await getSignalIntelligence(db(), { sourceLabel: aliasLabel, signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: false } });
    expect(after.trust).toMatchObject({ tier: "A" });
    expect(after.sourceIdentity.members).toEqual(expect.arrayContaining([CH, aliasLabel]));
  });
  it("missing intelligence never throws: no label, unknown label", async () => {
    expect(await getSignalIntelligence(db(), { sourceLabel: "", signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: false } })).toMatchObject({ status: "UNAVAILABLE", trust: { reason: "SOURCE_NOT_PROVIDED" } });
    expect(await getSignalIntelligence(db(), { sourceLabel: `nobody-${sfx()}`, signal: sig("2025-02-01T00:00:00Z"), marketContext: { available: false } })).toMatchObject({ status: "UNAVAILABLE", trust: { reason: "SOURCE_NOT_REGISTERED" } });
  });
});

describe("fail closed", () => {
  it("the kill switch, disabled intake or an unreadable runtime state refuse before anything is read or written", async () => {
    const live = await makeLive(CH);
    const before = await counts(["risk_decisions"]);
    for (const set of [() => state.set({ KILL_SWITCH_ACTIVE: true }), () => state.set({ INTAKE_ENABLED: false }), () => state.failWith(new Error("down"))]) {
      set();
      await expect(recordSourceIntelligence(db(), live.pendingId)).rejects.toMatchObject({ code: "safety_refused" });
      state.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); state.failWith(null);
    }
    expect(await counts(["risk_decisions"])).toEqual(before);
  });
  it("an error while resolving intelligence propagates (it is never turned into a default) and writes nothing", async () => {
    const live = await makeLive(CH);
    const before = await counts(["risk_decisions"]);
    await expect(recordSourceIntelligence(db(), live.pendingId, { resolve: async () => { throw new Error("database unavailable"); } })).rejects.toThrow("database unavailable");
    expect(await counts(["risk_decisions"])).toEqual(before);
    expect(must(await getRiskDecision(db(), live.pendingId)).effectiveStatus).toBe("PENDING");
  });
  it("a decision that is already sized (or whose successor carries intelligence) takes no second intelligence version", async () => {
    const live = await makeLive(CH);
    await recordSourceIntelligence(db(), live.pendingId, { resolve: synthetic({}) });
    const sized = await sizeLatestRiskDecisionForSignal(db(), live.signalId, { capital: CAPITAL, requireIntelligence: true });
    if ("skipped" in sized) throw new Error("skipped");
    await expect(recordSourceIntelligence(db(), randomUUID())).rejects.toMatchObject({ code: "not_found" });
    for (const id of [live.pendingId, sized.id]) expect(await recordSourceIntelligence(db(), id, { resolve: synthetic({ trustTier: "B" }) })).toMatchObject({ created: false });
    expect(await listRiskDecisions(db(), { signalId: live.signalId })).toHaveLength(3);
  });
});

describe("the read-only API", () => {
  it("returns the source summary, a point-in-time estimate and a decision's recorded intelligence, all bearer-protected and writing nothing", async () => {
    const app = Fastify();
    registerIntelligenceRoutes(app, { db: db(), authorized: (h) => h === "Bearer itest-key" });
    const h = { authorization: "Bearer itest-key" };
    const live = await makeLive(CH);
    const rec = await recordSourceIntelligence(db(), live.pendingId);
    const before = await counts([...LIVE_TABLES, "risk_decisions"]);

    const summary = await app.inject({ method: "GET", url: `/intelligence/source?label=${encodeURIComponent(CH)}&asOf=2025-01-06T00:00:00Z`, headers: h });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ identity: { registered: true }, trust: { tier: "A", dataSufficiency: "SUFFICIENT" }, patternLibrary: { available: true } });
    const unknown = await app.inject({ method: "GET", url: `/intelligence/source?label=nobody-${sfx()}`, headers: h });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({ trust: { tier: "UNKNOWN", reason: "SOURCE_NOT_REGISTERED" } });

    const estimate = await app.inject({ method: "POST", url: "/intelligence/estimate", headers: h, payload: { sourceLabel: CH, marketContextAvailable: false, signal: { market: MKT, instrumentType: "equity", underlying: SYM, side: "buy", entry: { type: "at", price: 100 }, stopLoss: 95, targets: [105, 110, 115], timestamp: "2025-02-01T00:00:00Z", stopLossValid: true, dataQuality: "GOOD" } } });
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json()).toMatchObject({ status: "VALID", trust: { tier: "A" }, confidence: { tier: "MEDIUM", sampleSize: 50 } });

    const snap = await app.inject({ method: "GET", url: `/risk/decisions/${rec.id}/intelligence`, headers: h });
    expect(snap.json()).toMatchObject({ decisionId: rec.id, decisionVersion: 2, valid: true, current: true, intelligence: { status: "VALID" } });
    expect((await app.inject({ method: "GET", url: `/risk/decisions/${randomUUID()}/intelligence`, headers: h })).statusCode).toBe(404);
    const dump = JSON.stringify([summary.json(), estimate.json(), snap.json()]);
    expect(dump).not.toMatch(/SYNTHETIC live fixture|inputSnapshot|rawText|itest-key/);
    expect(await counts([...LIVE_TABLES, "risk_decisions"])).toEqual(before);
    expect((await app.inject({ method: "GET", url: `/intelligence/source?label=${CH}` })).statusCode).toBe(401);
  });
});

describe("the CLI", () => {
  it("resolves (without recording), shows a recorded snapshot, lists and exports a safe report", async () => {
    const out: string[] = [], errs: string[] = [];
    const cli = (args: string[]) => { out.length = 0; return runCli(args, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }) }); };
    const live = await makeLive(CH);
    const before = await counts(["risk_decisions"]);
    expect(await cli(["resolve", "--signal", live.signalId])).toBe(0);
    expect(out.join("\n")).toMatch(/intelligence VALID \(OK\)/);
    expect(await counts(["risk_decisions"])).toEqual(before); // resolve records nothing
    const rec = await recordSourceIntelligence(db(), live.pendingId);
    expect(await cli(["show", "--decision", rec.id])).toBe(0);
    expect(out.join("\n")).toMatch(/intelligence VALID \(OK\), valid=true/);
    expect(await cli(["show", "--decision", live.pendingId, "--json"])).toBe(3); // v1 carries no intelligence
    expect(await cli(["list"])).toBe(0);
    expect(out.join("\n")).toContain(CH);
    expect(await cli(["export", "--format", "csv"])).toBe(0);
    expect(out.join("\n").split("\n")[0]).toBe("label,tier,tierLabel,scorecardAsOf,evaluable,confidenceAvailable");
    expect(await cli(["export", "--format", "json"])).toBe(0);
    expect(out.join("\n") + errs.join("\n")).not.toMatch(/SYNTHETIC live fixture|BUY [A-Z]+ @|postgres(ql)?:\/\//);
    expect(await cli(["resolve", "--signal", randomUUID()])).toBe(3);
    expect(await cli(["resolve"])).toBe(2);
    expect(await cli(["export", "--format", "xml"])).toBe(2);
    expect((await verifyAuditChainsWithPool(pool, { chains: ["risk_decisions"] })).ok).toBe(true);
  });
});
