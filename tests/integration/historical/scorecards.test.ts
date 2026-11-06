/**
 * Source scorecards and trust tiers against REAL PostgreSQL (Stage 4 / Task 3). Everything is SYNTHETIC: messages go through the real importer, outcome labels through the real evaluator
 * against deterministic bars, and scorecards are built from those labels. Channel labels carry a per-run suffix. No Telegram, provider, broker or network is involved.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import {
  attributionReport, canonicalSources, exportReport, getLatestSourceTrustTier, inspectInput, InputError, linkAlias, listSources, memoryProvider, rebuildAll, rebuildScorecard, registerSources, resolveSource, runEvaluation, runImport, showScorecard,
} from "../../../packages/historical/src/index";
import { runCli } from "../../../scripts/ops/historical-scorecard";
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
const AS_OF = new Date("2026-06-01T00:00:00Z");
const D0 = Date.parse("2024-03-04T00:00:00Z");
const DAY = 86_400_000;
const BY = "operator:itest";
const SCORE_CHAINS = ["historical_source_registry", "historical_scorecard_runs", "historical_scorecard_metrics", "historical_trust_tiers", "historical_scorecard_events"];

beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const n = async (sql: string, params: unknown[] = []) => Number(must((await q(sql, params))[0])["n"]);
const counts = async (tables: string[]) => Promise.all(tables.map((t) => n(`select count(*)::int as n from ${t}`)));
const LIVE = ["telegram_messages", "signals", "options_claims", "risk_decisions", "risk_approvals", "risk_approval_cards", "orders", "fills", "positions", "decisions", "claim_review_cards", "telegram_intake_outbox"];
const HIST = ["historical_import_batches", "historical_source_records", "historical_normalized_records", "historical_datasets", "historical_evaluation_runs", "historical_outcome_labels", "historical_evaluation_events"];
const letters = (i: number): string => String.fromCharCode(65 + Math.floor(i / 26) % 26) + String.fromCharCode(65 + (i % 26));

type Kind = "w1" | "w2" | "l" | "ne" | "unv" | "w2rev";
const BAR_AT: Partial<Record<Kind, Record<number, Ohlc>>> = { w1: { 3: [100, 106, 100, 105] }, w2: { 3: [100, 111, 100, 110] }, w2rev: { 3: [100, 111, 100, 110] }, l: { 3: [100, 100, 94, 95] } };

/** Imports `spec.length` daily messages into `channel` and labels them against synthetic bars with the real evaluator. */
async function seed(channel: string, spec: Kind[], startDay = 0) {
  const prefix = randomLetters(4);
  const records = spec.map((k, i) => {
    const sym = `${prefix}${letters(i)}`;
    const at = new Date(D0 + (startDay + i) * DAY);
    return { sym, k, at, rec: { channel, message_id: i + 1, timestamp: at.toISOString(), text: `BUY ${sym} @ 100 SL 95 TGT 105 110 115`, market: "NSE",
      ...(k === "w2rev" ? { edits: [{ edited_at: new Date(at.getTime() + 3_600_000).toISOString(), text: `BUY ${sym} @ 100 SL 90 TGT 105 110 115` }] } : {}) } };
  });
  const file = writeJsonl(tempDir(), "export.jsonl", records.map((r) => r.rec));
  const imp = await runImport(db(), await inspectInput(file), { label: `sc-${sfx()}`, defaultMarket: "NSE", createdBy: "service:itest", confirmedSource: file, now: NOW });
  const series = records.filter((r) => r.k !== "unv").map((r) => equitySeries(r.sym, r.k === "ne" ? dailyBars({ start: r.at, days: 30, base: 130 }) : dailyBars({ start: r.at, days: 30, base: 100, ...(BAR_AT[r.k] ? { at: BAR_AT[r.k] as Record<number, Ohlc> } : {}) })));
  const ev = await runEvaluation(db(), { scope: { kind: "BATCH", batchId: imp.batchId }, provider: memoryProvider([datasetOf(series, { dataset_id: `sc-${sfx()}` })]), createdBy: "service:itest", asOf: AS_OF });
  return { batchId: imp.batchId, evalRunId: ev.runId };
}
const rep = <T,>(x: T, k: number): T[] => Array.from({ length: k }, () => x);
const mixed = (wins: number, losses: number, win: Kind = "w2"): Kind[] => { const out: Kind[] = []; let w = 0, l = 0; while (w < wins || l < losses) { if (w < wins && (l >= losses || w / wins <= l / losses)) { out.push(win); w++; } else { out.push("l"); l++; } } return out; };
const build = async (channel: string, over: Parameters<typeof rebuildScorecard>[2] extends infer _ ? Partial<Parameters<typeof rebuildScorecard>[2]> : never = {}) => {
  await registerSources(db(), "service:itest");
  return rebuildScorecard(db(), must(await resolveSource(db(), channel)), { asOf: NOW, createdBy: "service:itest", ...over });
};

describe("tiers from real evaluated outcomes", () => {
  it("60 evaluable outcomes with positive expectancy build an A scorecard with the full snapshot, windows, configuration and evidence", async () => {
    const ch = `sc-a-${sfx()}`;
    const { evalRunId } = await seed(ch, mixed(36, 24));
    const live = await counts(LIVE), hist = await counts(HIST);
    const r = await build(ch);
    expect(r).toMatchObject({ created: true, tier: "A", evaluable: 60 });
    expect(await counts(LIVE)).toEqual(live); // no live pipeline write
    expect(await counts(HIST)).toEqual(hist); // imported records and labels untouched
    const d = must(await showScorecard(db(), ch));
    expect(d.tier).toMatchObject({ tier: "A", label: "HIGH_TRUST" });
    const all = must(d.windows.find((w) => w.windowType === "ALL_TIME"));
    expect(all.metrics).toMatchObject({ evaluable: 60, entered: 60, wins: 36, losses: 24, totalR: 48, winRateEntered: 0.6, maxConsecutiveLosses: 1, unverifiableRate: 0, dataQualityScore: 1, evaluationCoverageScore: 1 });
    expect(d.windows.map((w) => w.windowType).sort()).toEqual(["ALL_TIME", "CALENDAR_MONTH", "CALENDAR_MONTH", "CALENDAR_MONTH", "LAST_180D", "LAST_30D", "LAST_365D", "LAST_90D"]);
    expect(d.run).toMatchObject({ asOf: NOW.toISOString(), algorithmVersion: "source-scorecard-v1+trust-tier-v1" });
    expect(d.run.inputSummary).toMatchObject({ evaluationRunIds: [evalRunId], labelCount: 60 });
    expect((d.run.inputSummary as { datasetRefs: string[] }).datasetRefs).toHaveLength(1);
    expect(d.run.config).toMatchObject({ unknownBelow: 30, a: { minEvaluable: 50 } }); // the threshold configuration used
    expect(d.run.sourceSnapshot).toMatchObject({ memberLabels: [ch], markets: ["NSE"], importedMessages: 60, normalizedSignals: 60, evaluable: 60 });
    expect(d.tier.evidenceReferences).toMatchObject({ labelCount: 60, scorecardRunId: r.runId });
    expect((d.tier.explanation as Array<{ rule: string }>)[0]?.rule).toBe("MEETS_A_THRESHOLDS");
    expect(JSON.stringify(d)).not.toMatch(/BUY [A-Z]+ @ 100/); // no message text anywhere
    expect((await verifyAuditChainsWithPool(pool, { chains: SCORE_CHAINS })).ok).toBe(true);
  });

  it("an insufficient sample is UNKNOWN", async () => {
    const ch = `sc-u-${sfx()}`;
    await seed(ch, mixed(8, 4));
    expect(await build(ch)).toMatchObject({ tier: "UNKNOWN", evaluable: 12 });
    expect(await getLatestSourceTrustTier(db(), ch)).toMatchObject({ tier: "UNKNOWN", reason: "INSUFFICIENT_EVIDENCE" });
  });

  it("negative expectancy is D", async () => {
    const ch = `sc-d-${sfx()}`;
    await seed(ch, mixed(10, 30, "w1"));
    const r = await build(ch);
    expect(r.tier).toBe("D");
    expect(JSON.stringify(must(await showScorecard(db(), ch)).tier.explanation)).toContain("NEGATIVE_NET_EXPECTANCY");
  });

  it("a high unverifiable share blocks A (and B)", async () => {
    const ch = `sc-v-${sfx()}`;
    await seed(ch, [...mixed(36, 24), ...rep<Kind>("unv", 25)]); // 25 of 85 = 29% unverifiable
    const r = await build(ch);
    expect(r).toMatchObject({ evaluable: 60 });
    expect(r.tier).toBe("B");
    const ch2 = `sc-v2-${sfx()}`;
    await seed(ch2, [...mixed(36, 24), ...rep<Kind>("unv", 45)]); // 43% unverifiable
    expect((await build(ch2)).tier).toBe("C");
  });

  it("revision / conflict activity (adverse stop-loss revisions) downgrades", async () => {
    const ch = `sc-r-${sfx()}`;
    const spec = mixed(36, 24);
    let k = 0;
    const revised = spec.map((x) => (x === "w2" && k++ < 12 ? ("w2rev" as Kind) : x)); // 12 of 60 messages edited to a wider stop = 20%
    await seed(ch, revised);
    const r = await build(ch);
    const d = must(await showScorecard(db(), ch));
    const all = must(d.windows.find((w) => w.windowType === "ALL_TIME")).metrics as { adverseSlRevisionCount: number; revisionConflictRate: number; slDisciplineRate: number; editedMessageRate: number };
    expect(all).toMatchObject({ adverseSlRevisionCount: 12, revisionConflictRate: 0.2, slDisciplineRate: 0.8, editedMessageRate: 0.2 });
    expect(r.tier).toBe("C");
    expect(JSON.stringify(d.tier.explanation)).toContain("REVISION_ACTIVITY_DOWNGRADE");
  });
});

describe("determinism, idempotency and time windows", () => {
  it("rebuilding the same input is a no-op; a different as-of or configuration is a separate run; the latest as-of wins the tier lookup", async () => {
    const ch = `sc-i-${sfx()}`;
    await seed(ch, mixed(36, 24));
    const first = await build(ch);
    const rows = await counts(["historical_scorecard_runs", "historical_scorecard_metrics", "historical_trust_tiers", "historical_scorecard_events"]);
    const again = await build(ch);
    expect(again).toMatchObject({ created: false, runId: first.runId, tier: first.tier });
    expect(await counts(["historical_scorecard_runs", "historical_scorecard_metrics", "historical_trust_tiers", "historical_scorecard_events"])).toEqual(rows);
    const stricter = await build(ch, { tierConfig: { a: { minEvaluable: 80 } } });
    expect(stricter).toMatchObject({ created: true, tier: "B" });
    expect(stricter.runId).not.toBe(first.runId);
    const earlier = await build(ch, { asOf: new Date(NOW.getTime() - DAY) });
    expect(earlier.created).toBe(true);
    expect((await getLatestSourceTrustTier(db(), ch)).scorecardRunId).toBe(stricter.runId); // newest as-of, then newest creation: the earlier as-of does not displace it
  });

  it("time-window scorecards cover the right messages for an as-of inside the archive", async () => {
    const ch = `sc-w-${sfx()}`;
    await seed(ch, mixed(36, 24));
    await build(ch, { asOf: new Date(D0 + 49 * DAY) }); // 2024-04-22: messages on days 0..49 are known
    const d = must(await showScorecard(db(), ch));
    const w = (t: string) => d.windows.filter((x) => x.windowType === t);
    expect(must(w("ALL_TIME")[0]).sampleSize).toBe(50);
    expect(must(w("LAST_30D")[0]).sampleSize).toBe(30);
    expect(must(w("LAST_90D")[0]).sampleSize).toBe(50);
    expect(w("CALENDAR_MONTH").map((x) => x.windowStart.slice(0, 7))).toEqual(["2024-03", "2024-04"]);
    expect(must(w("LAST_30D")[0]).caveats).toEqual(expect.arrayContaining([{ code: "LATE_SIGNAL_RATE_NOT_MEASURABLE" }]));
  });
});

describe("source identity and aliases", () => {
  it("aliases are linked explicitly (never merged silently); the canonical scorecard includes the alias's signals and the alias resolves to it", async () => {
    const a = `sc-ca-${sfx()}`, b = `sc-cb-${sfx()}`;
    await seed(a, mixed(4, 2));
    await seed(b, mixed(3, 1));
    await registerSources(db(), "service:itest");
    const sources = (await canonicalSources(db())).map((s) => s.channelLabel);
    expect(sources).toEqual(expect.arrayContaining([a, b])); // two separate identities until linked
    const sep = await build(a);
    expect(sep.evaluable).toBe(6);
    await expect(linkAlias(db(), { alias: b, canonical: b, reason: "same", createdBy: "operator:itest" })).rejects.toMatchObject({ code: "alias_equals_canonical" });
    await expect(linkAlias(db(), { alias: b, canonical: "nope", reason: "x", createdBy: "operator:itest" })).rejects.toMatchObject({ code: "source_not_registered" });
    await expect(linkAlias(db(), { alias: b, canonical: a, reason: "  ", createdBy: "operator:itest" })).rejects.toBeInstanceOf(InputError);
    const link = await linkAlias(db(), { alias: b, canonical: a, reason: "operator-confirmed rename of the same channel", createdBy: "operator:itest" });
    expect(link.created).toBe(true);
    expect((await linkAlias(db(), { alias: b, canonical: a, reason: "again", createdBy: "operator:itest" })).created).toBe(false);
    const c = `sc-cc-${sfx()}`;
    await seed(c, mixed(1, 1));
    await registerSources(db(), "service:itest");
    await expect(linkAlias(db(), { alias: b, canonical: c, reason: "elsewhere", createdBy: "operator:itest" })).rejects.toMatchObject({ code: "alias_already_linked_elsewhere" });
    await expect(linkAlias(db(), { alias: c, canonical: b, reason: "chain", createdBy: "operator:itest" })).rejects.toMatchObject({ code: "canonical_is_itself_an_alias" });
    await expect(linkAlias(db(), { alias: a, canonical: c, reason: "chain", createdBy: "operator:itest" })).rejects.toMatchObject({ code: "alias_has_its_own_aliases" });
    expect((await canonicalSources(db())).map((s) => s.channelLabel)).not.toContain(b);
    const merged = await build(a);
    expect(merged).toMatchObject({ created: true, evaluable: 10 }); // 6 + 4: a new input, a new run
    expect(must(await showScorecard(db(), b)).source.members).toEqual([a, b].sort()); // asking by the alias shows the canonical source
    expect((await getLatestSourceTrustTier(db(), b)).scorecardRunId).toBe(merged.runId);
    expect((await listSources(db())).map((s) => s.channelLabel)).not.toContain(b);
    expect((await verifyAuditChainsWithPool(pool, { chains: SCORE_CHAINS })).ok).toBe(true);
  });
});

describe("getLatestSourceTrustTier (risk-integration readiness)", () => {
  it("returns UNKNOWN - never throws - for unregistered, unscored and empty identities, and the stored tier otherwise", async () => {
    expect(await getLatestSourceTrustTier(db(), `never-seen-${sfx()}`)).toMatchObject({ tier: "UNKNOWN", reason: "SOURCE_NOT_REGISTERED", scorecardRunId: null });
    expect(await getLatestSourceTrustTier(db(), "")).toMatchObject({ tier: "UNKNOWN", reason: "SOURCE_NOT_PROVIDED" });
    const ch = `sc-l-${sfx()}`;
    await seed(ch, mixed(36, 24));
    await registerSources(db(), "service:itest");
    expect(await getLatestSourceTrustTier(db(), { channelLabel: ch })).toMatchObject({ tier: "UNKNOWN", reason: "NO_SCORECARD" });
    await build(ch);
    expect(await getLatestSourceTrustTier(db(), ch)).toMatchObject({ tier: "A", label: "HIGH_TRUST", reason: "SCORECARD" });
  });
  it("modifies no risk decision, approval, order or position (read-only)", async () => {
    const before = await counts(LIVE);
    await getLatestSourceTrustTier(db(), "anything");
    await listSources(db());
    expect(await counts(LIVE)).toEqual(before);
  });
});

describe("append-only chains", () => {
  it("refuses update, delete and truncate on every scorecard table", async () => {
    const ch = `sc-t-${sfx()}`;
    await seed(ch, mixed(8, 4));
    await build(ch);
    const c = await pool.connect();
    try {
      for (const t of SCORE_CHAINS) {
        for (const sql of [`update ${t} set created_by = 'service:x'`, `delete from ${t}`, `truncate ${t}`]) {
          const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
          expect(["23001", "0A000"], `${sql} -> ${e?.code}`).toContain(e?.code);
        }
      }
    } finally { c.release(); }
  });
});

describe("the CLI and the safe report", () => {
  it("registers, rebuilds (one / all), lists, shows and exports without message content; an alias-free CSV formula guard protects labels", async () => {
    const ch = `@sc-x-${sfx()}`; // a leading '@' would be read as a formula by a spreadsheet
    await seed(ch, mixed(36, 24));
    const out: string[] = [], errs: string[] = [];
    const cli = (args: string[]) => { out.length = 0; return runCli(args, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }), now: () => NOW }); };
    expect(await cli(["register", "--created-by", BY])).toBe(0);
    expect(await cli(["rebuild", "--source", ch, "--created-by", BY])).toBe(0);
    expect(out.join("\n")).toMatch(/built .*: tier A \(60 evaluable\)/);
    expect(await cli(["rebuild", "--source", ch, "--created-by", BY])).toBe(0);
    expect(out.join("\n")).toMatch(/unchanged/);
    expect(await cli(["rebuild", "--all", "--created-by", BY])).toBe(0);
    expect(out.join("\n")).toMatch(/source\(s\), as of/);
    expect(await cli(["list"])).toBe(0);
    expect(out.join("\n")).toContain(ch);
    expect(await cli(["list", "--json"])).toBe(0);
    expect((JSON.parse(out.join("\n")) as Array<{ channelLabel: string; tier: string }>).find((r) => r.channelLabel === ch)?.tier).toBe("A");
    expect(await cli(["show", "--source", ch])).toBe(0);
    expect(out.join("\n")).toMatch(/tier A \(HIGH_TRUST\)/);
    expect(out.join("\n")).toContain("ALL_TIME");
    expect(await cli(["export", "--format", "csv"])).toBe(0);
    const csv = out.join("\n");
    expect(csv.split("\n")[0]).toBe("channelLabel,tier,tierLabel,asOf,evaluable,totalEvaluated,winRateEntered,netExpectancyR,grossExpectancyR,unverifiableRate,revisionConflictRate,maxDrawdownR");
    expect(csv).toContain(`'${ch}`); // formula-guarded
    expect(await cli(["export", "--format", "json"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toBeInstanceOf(Array);
    expect(await exportReport(db(), "json")).not.toMatch(/BUY [A-Z]+|author|SL 95/);
    expect(out.join("\n") + errs.join("\n")).not.toMatch(/BUY [A-Z]+ @|postgres(ql)?:\/\//);
    // usage and refusals
    expect(await cli(["rebuild", "--created-by", BY])).toBe(2);
    expect(await cli(["rebuild", "--source", "nope", "--created-by", BY])).toBe(3);
    expect(await cli(["show", "--source", "nope"])).toBe(3);
    expect(await cli(["export", "--format", "xml"])).toBe(2);
    expect(await cli(["rebuild", "--all", "--created-by", "someone"])).toBe(3);
    expect((await rebuildAll(db(), { asOf: NOW, createdBy: "service:itest" })).length).toBeGreaterThan(0);
    expect((await verifyAuditChainsWithPool(pool, { chains: SCORE_CHAINS })).ok).toBe(true);
  });
});

describe("outcome attribution (read-only report over real labels)", () => {
  it("attributes evaluated labels by source and market with sample sizes, and writes nothing", async () => {
    const ch = `sc-attr-${sfx()}`;
    await seed(ch, mixed(7, 3));
    const live = await counts(LIVE), hist = await counts(HIST);
    const r = await attributionReport(db(), { minSample: 5 });
    expect(await counts(LIVE)).toEqual(live);
    expect(await counts(HIST)).toEqual(hist);
    const mine = must(r.strata.find((x) => x.dimension === "source" && x.value === ch));
    expect(mine).toMatchObject({ evaluable: 10, wins: 7, losses: 3, thin: false, reading: "READABLE" });
    expect(r.strata.some((x) => x.dimension === "market" && x.value === "NSE")).toBe(true);
    expect(r.usedForDecisions).toBe(false);
    const thin = await attributionReport(db(), { minSample: 50, dimensions: ["source"] });
    expect(must(thin.strata.find((x) => x.value === ch)).thin).toBe(true);
  });
});
