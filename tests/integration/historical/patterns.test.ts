/**
 * Pattern library and calibrated confidence against REAL PostgreSQL (Stage 4 / Task 4). Everything is SYNTHETIC: messages go through the real importer, outcome labels through the real
 * evaluator against deterministic bars, tiers through the real scorecard code. Each run uses its own market code, so patterns are isolated from every other test's data. No Telegram,
 * provider, broker, LLM or network is involved.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  estimateSignalConfidence, exportPatternReport, inspectInput, InputError, memoryProvider, rebuildPatternLibrary, rebuildPatternMetrics, rebuildScorecard, registerSources, resolveSource, runConfidenceEstimation, runEvaluation, runImport, showPattern, wilsonInterval,
  type SignalForConfidence,
} from "../../../packages/historical/src/index";
import { runCli } from "../../../scripts/ops/historical-patterns";
import { tempDir, writeJsonl } from "../../support/historicalFixtures";
import { dailyBars, datasetOf, equitySeries, type Ohlc } from "../../support/outcomeFixtures";
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
let handle: BoundedDbHandle;
const db = () => handle.db;
const sfx = () => randomUUID().slice(0, 8);
const NOW = new Date("2026-10-30T10:00:00Z");
const EVAL_AS_OF = new Date("2026-06-01T00:00:00Z");
const PATTERN_AS_OF = new Date("2024-09-01T00:00:00Z");
const START = Date.parse("2020-01-06T00:00:00Z"); // a Monday, aligned to the daily bars
const DAY = 86_400_000;
const BY = "operator:itest";
const CHAINS = ["historical_pattern_definitions", "historical_pattern_runs", "historical_pattern_snapshots", "historical_confidence_runs", "historical_confidence_estimates"];
const MKT = `ZT${randomLetters(6)}`; // unique market code: the patterns of this file are isolated from every other test's data
const SYM = randomLetters(6), SYM_B = randomLetters(6), SYM_NEW = randomLetters(6);
const LIVE = ["telegram_messages", "signals", "options_claims", "risk_decisions", "risk_approvals", "risk_approval_cards", "orders", "fills", "positions", "decisions", "claim_review_cards", "telegram_intake_outbox"];
const UPSTREAM = ["historical_import_batches", "historical_source_records", "historical_normalized_records", "historical_datasets", "historical_evaluation_runs", "historical_outcome_labels", "historical_scorecard_runs", "historical_trust_tiers", "historical_source_registry"];

beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const n = async (sql: string, params: unknown[] = []) => Number(must((await q(sql, params))[0])["n"]);
const counts = async (tables: string[]) => Promise.all(tables.map((t) => n(`select count(*)::int as n from ${t}`)));

type Kind = "w" | "l";
const mixed = (wins: number, losses: number): Kind[] => { const out: Kind[] = []; let w = 0, l = 0; while (w < wins || l < losses) { if (w < wins && (l >= losses || w / wins <= l / losses)) { out.push("w"); w++; } else { out.push("l"); l++; } } return out; };
const OUT: Record<Kind, Ohlc> = { w: [100, 111, 100, 110], l: [100, 100, 94, 95] };
const text = (sym: string, stop = 95) => `BUY ${sym} @ 100 SL ${stop} TGT 105 110 115`;

/** Imports one message per `kinds` entry, 31 days apart from `start`, and (when `bars`) labels them with the real evaluator against one daily series for the symbol. */
async function seed(channel: string, sym: string, kinds: Kind[], o: { start?: number; firstId?: number; bars?: boolean; stop?: number; label?: string } = {}) {
  const start = o.start ?? START, firstId = o.firstId ?? 1;
  const recs = kinds.map((_, i) => ({ channel, message_id: firstId + i, timestamp: new Date(start + 31 * i * DAY).toISOString(), text: text(sym, o.stop ?? 95), market: MKT }));
  const file = writeJsonl(tempDir(), "export.jsonl", recs);
  const imp = await runImport(db(), await inspectInput(file), { label: o.label ?? `pt-${sfx()}`, defaultMarket: MKT, createdBy: "service:itest", confirmedSource: file, now: NOW });
  let evalRunId: string | null = null;
  if (o.bars !== false) {
    const day0 = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate()));
    const at: Record<number, Ohlc> = {};
    kinds.forEach((k, i) => { at[31 * i + 3] = OUT[k]; });
    const series = equitySeries(sym, dailyBars({ start: day0, days: 31 * kinds.length + 2, base: 100, at }), { market: MKT });
    evalRunId = (await runEvaluation(db(), { scope: { kind: "BATCH", batchId: imp.batchId }, provider: memoryProvider([datasetOf([series], { dataset_id: `pt-${sfx()}` })]), createdBy: "service:itest", asOf: EVAL_AS_OF })).runId;
  }
  const ids = (await q("select n.id from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = $1 order by s.source_line", [imp.batchId])).map((r) => r["id"] as string);
  return { batchId: imp.batchId, ids, evalRunId };
}

const CH = `pt-${sfx()}`, CH_NO_TIER = `pt-nt-${sfx()}`;
let patternRunId = "";
let targets: { batchId: string; ids: string[] };

beforeAll(async () => {
  await seed(CH, SYM, mixed(30, 20)); // 50 evaluable outcomes on one symbol: sufficient at every level
  await seed(CH, SYM_B, mixed(8, 4), { firstId: 5000 }); // 12 on another symbol: insufficient below level 1
  await registerSources(db(), "service:itest");
  await rebuildScorecard(db(), must(await resolveSource(db(), CH)), { asOf: PATTERN_AS_OF, createdBy: "service:itest" });
  await rebuildPatternLibrary(db(), "service:itest");
  patternRunId = (await rebuildPatternMetrics(db(), { asOf: PATTERN_AS_OF, createdBy: "service:itest" })).runId;
  // new signals, sent after the pattern run: [known symbol, same shape], [unseen symbol], [known symbol, different stop distance]
  const t0 = Date.parse("2025-01-06T00:00:00Z");
  const recs = [text(SYM), text(SYM_NEW), text(SYM, 90)].map((t, i) => ({ channel: CH, message_id: 9000 + i, timestamp: new Date(t0 + i * DAY).toISOString(), text: t, market: MKT }));
  const imp = await runImport(db(), await inspectInput(writeJsonl(tempDir(), "t.jsonl", recs)), { label: `pt-t-${sfx()}`, defaultMarket: MKT, createdBy: "service:itest", confirmedSource: "t.jsonl", now: NOW });
  targets = { batchId: imp.batchId, ids: (await q("select n.id from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = $1 order by s.source_line", [imp.batchId])).map((r) => r["id"] as string) };
});

const snapshotOf = async (keyStart: string, runId = patternRunId) => (await q(
  "select d.key_text, d.level, s.* from historical_pattern_snapshots s join historical_pattern_definitions d on d.id = s.pattern_id where s.run_id = $1 and d.key_text like $2", [runId, `${keyStart}%`]))[0];

describe("pattern library and metrics from real evaluated outcomes", () => {
  it("registers deterministic definitions for levels 1-4 (idempotent) and never a generated name", async () => {
    const defs = await q("select key_text, level, features, definition_version from historical_pattern_definitions where key_text like $1 order by level", [`%market=${MKT}|%`]);
    expect(defs.map((d) => d["level"])).toEqual([1, 2, 2, 3, 3, 4, 4]); // L1, then one pattern per symbol at each deeper level
    expect(defs[0]!["key_text"]).toBe(`L1|market=${MKT}|instrumentType=EQUITY|side=BUY`);
    expect(defs.every((d) => d["definition_version"] === "pattern-features-v1" && /^L[1-4]\|/.test(d["key_text"]))).toBe(true);
    await rebuildPatternLibrary(db(), "service:itest"); // (also picks up the patterns of the later, new signals)
    const before = await n("select count(*)::int as n from historical_pattern_definitions");
    const again = await rebuildPatternLibrary(db(), "service:itest");
    expect(again.patterns).toBeGreaterThan(0);
    expect(await n("select count(*)::int as n from historical_pattern_definitions")).toBe(before);
  });

  it("stores snapshots with sample size, status, Wilson interval, expectancy bound, mixes and observed dates", async () => {
    const l1 = must(await snapshotOf(`L1|market=${MKT}|`));
    expect(l1).toMatchObject({ level: 1, evidence_status: "SUFFICIENT", sample_size: 62 });
    expect(l1["metrics"]).toMatchObject({ wins: 38, losses: 24, entered: 62, winRateEntered: 0.612903 });
    const l4 = must(await snapshotOf(`L4|market=${MKT}|instrumentType=EQUITY|side=BUY|underlying=${SYM}|`));
    expect(l4).toMatchObject({ level: 4, evidence_status: "SUFFICIENT", sample_size: 50 });
    const w = wilsonInterval(30, 50, 1.96) as { lower: number; upper: number };
    expect(l4["metrics"]).toMatchObject({ winRateEntered: 0.6, winRateEnteredWilsonLower: w.lower, winRateEnteredWilsonUpper: w.upper, totalR: 40 });
    expect(l4["metrics"].netExpectancyLowerBoundR).toBeLessThan(l4["metrics"].netExpectancyR);
    expect(l4["flags"]).toContain("HISTORICAL_ASSOCIATION_ONLY");
    expect(l4["mixes"].sourceTrustTier).toEqual({ A: 50 });
    expect(new Date(l4["first_observed"]).toISOString()).toBe("2020-01-06T00:00:00.000Z");
    expect(new Date(l4["last_observed"]).toISOString()).toBe(new Date(START + 31 * 49 * DAY).toISOString());
    const b = must(await snapshotOf(`L2|market=${MKT}|instrumentType=EQUITY|side=BUY|underlying=${SYM_B}`));
    expect(b).toMatchObject({ evidence_status: "INSUFFICIENT_EVIDENCE", sample_size: 12 });
    expect(b["flags"]).toContain("SAMPLE_BELOW_MINIMUM");
    const run = must((await q("select * from historical_pattern_runs where id = $1", [patternRunId]))[0]);
    expect(run).toMatchObject({ algorithm_version: "pattern-metrics-v1+pattern-features-v1", config_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(run["config"]).toMatchObject({ minSample: 30, embargoDays: 30, wilsonZ: 1.96, costPerTradeR: 0.05 });
    expect(run["input_summary"].datasetRefs.length).toBeGreaterThanOrEqual(2);
  });

  it("rebuilds idempotently; a different as-of (embargo) or configuration is a separate run with different training data", async () => {
    const same = await rebuildPatternMetrics(db(), { asOf: PATTERN_AS_OF, createdBy: "service:itest" });
    expect(same).toMatchObject({ created: false, runId: patternRunId });
    const early = await rebuildPatternMetrics(db(), { asOf: new Date("2022-01-01T00:00:00Z"), createdBy: "service:itest" });
    expect(early.created).toBe(true);
    const l4 = must(await snapshotOf(`L4|market=${MKT}|instrumentType=EQUITY|side=BUY|underlying=${SYM}|`, early.runId));
    expect(l4["sample_size"]).toBeLessThan(50); // the embargo (as-of minus 30 days) keeps later signals out
    const strict = await rebuildPatternMetrics(db(), { asOf: PATTERN_AS_OF, createdBy: "service:itest", config: { minSample: 60 } });
    expect(strict.created).toBe(true);
    expect(must(await snapshotOf(`L1|market=${MKT}|`, strict.runId))["evidence_status"]).toBe("SUFFICIENT"); // 62 >= 60
    expect(must(await snapshotOf(`L4|market=${MKT}|`, strict.runId))["evidence_status"]).toBe("INSUFFICIENT_EVIDENCE"); // 50 < 60
  });
});

describe("confidence for new signals (point in time, deterministic)", () => {
  it("estimates a batch: deepest sufficient pattern, trust-tier input, caps and UNKNOWN where nothing matches", async () => {
    const live = await counts(LIVE), upstream = await counts(UPSTREAM);
    const r = await runConfidenceEstimation(db(), { scope: { kind: "BATCH", batchId: targets.batchId }, patternRunId, createdBy: "service:itest" });
    expect(r).toMatchObject({ created: true, lookahead: false, counts: { evaluated: 3 } });
    expect(await counts(LIVE)).toEqual(live); // no live-pipeline write
    expect(await counts(UPSTREAM)).toEqual(upstream); // imported records, labels, scorecards untouched
    const rows = await q("select e.*, s.original_message_id as mid from historical_confidence_estimates e join historical_source_records s on s.id = e.source_record_id where e.run_id = $1 order by s.source_line", [r.runId]);
    const [a, newSym, shallow] = rows;
    // 1: same shape as the 50 observed -> level 4 pattern
    expect(a).toMatchObject({ tier: "MEDIUM", evidence_quality: "SUFFICIENT", sample_size: 50 });
    expect(a!["score"]).toBeGreaterThanOrEqual(40);
    expect(a!["score"]).toBeLessThanOrEqual(64);
    expect(a!["pattern_refs"].map((p: { level: number }) => p.level)).toEqual([1, 2, 3, 4]);
    expect(a!["inputs"]).toMatchObject({ sourceTrustTier: "A", marketContextAvailable: false, featureVersion: "pattern-features-v1" });
    expect(a!["explanation"].map((x: { rule: string }) => x.rule)).toEqual(expect.arrayContaining(["PRIMARY_PATTERN", "WIN_RATE_WILSON_LOWER_BOUND", "SCORE"]));
    expect(a!["limitations"]).toEqual(expect.arrayContaining(["HISTORICAL_ASSOCIATION_ONLY", "NO_CAUSAL_CLAIM", "MARKET_CONTEXT_UNAVAILABLE"]));
    expect(a!["evidence_references"]).toMatchObject({ patternRunId });
    expect(a!["evidence_references"].scorecardRunId).toMatch(/^[0-9a-f-]{36}$/);
    // 2: an unseen symbol only matches level 1 (n = 62)
    expect(newSym).toMatchObject({ evidence_quality: "SUFFICIENT", sample_size: 62 });
    expect(newSym!["pattern_refs"].map((p: { level: number }) => p.level)).toEqual([1]);
    // 3: a different stop distance matches levels 1-3 but not 4 -> uses level 3 (n = 50)
    expect(shallow).toMatchObject({ sample_size: 50 });
    expect(shallow!["pattern_refs"].map((p: { level: number }) => p.level)).toEqual([1, 2, 3]);
    expect(shallow!["explanation"][0].detail).toContain("L3|");
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });

  it("repeats exactly (idempotent run, identical estimates) and is refused for in-sample signals unless explicitly allowed", async () => {
    const first = await runConfidenceEstimation(db(), { scope: { kind: "BATCH", batchId: targets.batchId }, patternRunId, createdBy: "service:itest" });
    expect(first.created).toBe(false); // the previous test already built this exact run
    const rowsBefore = await counts(["historical_confidence_runs", "historical_confidence_estimates"]);
    const again = await runConfidenceEstimation(db(), { scope: { kind: "BATCH", batchId: targets.batchId }, patternRunId, createdBy: "service:itest" });
    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(await counts(["historical_confidence_runs", "historical_confidence_estimates"])).toEqual(rowsBefore);
    const dry = await runConfidenceEstimation(db(), { scope: { kind: "RECORD", normalizedRecordId: must(targets.ids[0]) }, patternRunId, createdBy: "service:itest", dryRun: true });
    expect(dry).toMatchObject({ runId: null, counts: { evaluated: 1, byTier: { MEDIUM: 1 } } });
    // the training messages pre-date the pattern run's as-of? No: they are the TRAINING data - an estimate for them is in-sample
    const training = (await q("select s.batch_id from historical_source_records s where s.channel_label = $1 and s.original_message_id = '1'", [CH]))[0];
    const scope = { kind: "BATCH" as const, batchId: training!["batch_id"] as string };
    // training signals date from 2020-2024, before the run's as-of (2024-09-01): they pre-date the run only if the run is OLDER; here the run is newer, so lookahead
    await expect(runConfidenceEstimation(db(), { scope, patternRunId, createdBy: "service:itest" })).rejects.toMatchObject({ code: "pattern_run_not_point_in_time" });
    const inSample = await runConfidenceEstimation(db(), { scope, patternRunId, createdBy: "service:itest", allowInSample: true });
    expect(inSample.lookahead).toBe(true);
    const row = must((await q("select limitations from historical_confidence_estimates where run_id = $1 limit 1", [inSample.runId]))[0]);
    expect(row["limitations"]).toContain("LOOKAHEAD_IN_SAMPLE");
    expect(must((await q("select lookahead from historical_confidence_runs where id = $1", [inSample.runId]))[0])["lookahead"]).toBe(true);
  });

  it("low source trust caps confidence: a source with no scorecard is UNKNOWN trust and capped at LOW", async () => {
    const t = await seed(CH_NO_TIER, SYM, ["w"], { start: Date.parse("2025-02-03T00:00:00Z"), bars: false });
    const r = await runConfidenceEstimation(db(), { scope: { kind: "BATCH", batchId: t.batchId }, patternRunId, createdBy: "service:itest" });
    const e = must((await q("select * from historical_confidence_estimates where run_id = $1", [r.runId]))[0]);
    expect(e).toMatchObject({ tier: "LOW", sample_size: 50 });
    expect(e["score"]).toBeLessThanOrEqual(39);
    expect(e["inputs"].sourceTrustTier).toBe("UNKNOWN");
    expect(e["explanation"].map((x: { rule: string }) => x.rule)).toContain("SOURCE_TRUST_CAP");
  });

  it("estimateSignalConfidence: read-only, deterministic, UNKNOWN without a library or a match", async () => {
    const sig = (o: Partial<SignalForConfidence> = {}): SignalForConfidence => ({
      market: MKT, instrumentType: "equity", underlying: SYM, optionType: null, side: "buy", entry: { type: "at", price: 100 }, stopLoss: 95, targets: [105, 110, 115], expiryDate: null, timestamp: new Date("2025-03-03T00:00:00Z"), stopLossValid: true, dataQuality: "GOOD", ...o,
    });
    const before = await counts([...LIVE, ...CHAINS]);
    const a = await estimateSignalConfidence(db(), sig(), "A", { available: true }, { patternRunId });
    expect(a).toMatchObject({ patternRunId, tier: "MEDIUM", sampleSize: 50, evidenceQuality: "SUFFICIENT" });
    expect(JSON.stringify(await estimateSignalConfidence(db(), sig(), "A", { available: true }, { patternRunId }))).toBe(JSON.stringify(a));
    expect((await estimateSignalConfidence(db(), sig(), "D", { available: true }, { patternRunId })).tier).toBe("LOW");
    expect((await estimateSignalConfidence(db(), sig({ underlying: randomLetters(7), instrumentType: "option", optionType: "CE" }), "A", { available: true }, { patternRunId })).evidenceQuality).toBe("NO_MATCH");
    expect(await estimateSignalConfidence(db(), sig({ timestamp: new Date("2010-01-01T00:00:00Z") }), "A", { available: true })).toMatchObject({ tier: "UNKNOWN", score: 0, evidenceQuality: "NO_LIBRARY", patternRunId: null });
    expect(await counts([...LIVE, ...CHAINS])).toEqual(before);
  });
});

describe("append-only chains", () => {
  it("refuses update, delete and truncate on every pattern / confidence table", async () => {
    const c = await pool.connect();
    try {
      for (const t of CHAINS) for (const sql of [`update ${t} set created_by = 'service:x'`, `delete from ${t}`, `truncate ${t}`]) {
        const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
        expect(["23001", "0A000"], `${sql} -> ${e?.code}`).toContain(e?.code);
      }
    } finally { c.release(); }
  });
});

describe("the CLI and the safe report", () => {
  it("rebuilds, estimates (dry-run and real), shows a pattern and exports without message content", async () => {
    const out: string[] = [], errs: string[] = [];
    const cli = (args: string[]) => { out.length = 0; return runCli(args, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }), now: () => NOW }); };
    expect(await cli(["rebuild-library", "--created-by", BY])).toBe(0);
    expect(out.join("\n")).toMatch(/library: \d+ patterns/);
    expect(await cli(["rebuild-metrics", "--created-by", BY, "--as-of", PATTERN_AS_OF.toISOString()])).toBe(0);
    expect(out.join("\n")).toContain(`unchanged pattern run ${patternRunId}`);
    expect(await cli(["estimate-batch", "--batch", targets.batchId, "--created-by", BY, "--pattern-run", patternRunId, "--dry-run"])).toBe(0);
    expect(out.join("\n")).toMatch(/dry-run \(nothing written\): 3 signals/);
    expect(await cli(["estimate-record", "--id", must(targets.ids[0]), "--created-by", BY, "--pattern-run", patternRunId])).toBe(0);
    expect(out.join("\n")).toMatch(/estimated run [0-9a-f-]{36}: 1 signals/);
    expect(out.join("\n")).toContain("MEDIUM=1");
    const key = `L4|market=${MKT}|instrumentType=EQUITY|side=BUY|underlying=${SYM}|timeOfDay=UNKNOWN_TZ|expiryProximity=NA|stopDistance=5_10PCT|rewardRisk=1_2`;
    expect(await cli(["show", "--pattern", key, "--run", patternRunId])).toBe(0);
    expect(out.join("\n")).toMatch(/\[SUFFICIENT\] n=50 \(historical association only\)/);
    expect(await cli(["show", "--pattern", "L1|market=NOPE|instrumentType=EQUITY|side=BUY"])).toBe(3);
    expect(await cli(["export", "--format", "csv", "--run", patternRunId])).toBe(0);
    const csv = out.join("\n");
    expect(csv.split("\n")[0]).toBe("keyText,level,evidenceStatus,sampleSize,winRateEntered,winRateWilsonLower,winRateWilsonUpper,grossExpectancyR,netExpectancyR,netExpectancyLowerBoundR,unverifiableRate,maxConsecutiveLosses,maxDrawdownR,firstObserved,lastObserved");
    expect(csv).toContain(key);
    const json = await exportPatternReport(db(), "json", patternRunId);
    expect(JSON.parse(json)).toMatchObject({ note: "HISTORICAL_ASSOCIATION_ONLY", patternRunId });
    expect(json + csv + errs.join("\n")).not.toMatch(/BUY [A-Z]+ @|SL 95|postgres(ql)?:\/\//);
    const detail = await showPattern(db(), key, patternRunId);
    expect(detail).toMatchObject({ level: 4, status: "SUFFICIENT", sampleSize: 50 });
    // usage and refusals
    expect(await cli(["estimate-batch", "--created-by", BY])).toBe(2);
    expect(await cli(["estimate-batch", "--batch", randomUUID(), "--created-by", BY, "--pattern-run", patternRunId])).toBe(3);
    expect(await cli(["estimate-batch", "--batch", targets.batchId, "--created-by", "someone"])).toBe(3);
    expect(await cli(["export", "--format", "xml"])).toBe(2);
    await expect(runConfidenceEstimation(db(), { scope: { kind: "BATCH", batchId: targets.batchId }, createdBy: "service:itest", patternRunId: randomUUID() })).rejects.toBeInstanceOf(InputError);
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
    void writeFileSync; void join;
  });
});
