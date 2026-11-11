/**
 * Stage 08 A2 / A3 against REAL PostgreSQL (migration 0046): immutable, owner-scoped, reproducible analytics snapshots built from ONE consistent database snapshot; one authoritative configuration for the API and the worker.
 * Synthetic data, FIXTURE prices. The connection is a superuser (it bypasses row-level security, not triggers or constraints), so isolation is checked through an unprivileged role session.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildUserOps } from "../../../apps/api/src/userOps";
import { advanceOpenOrders } from "../../../packages/execution/src/index";
import { evidenceFingerprint, findSnapshotByEvidence } from "../../../packages/database/src/index";
import { canonicalJson, captureSnapshot, currentAnalytics, currentHashes, DEFAULT_OUTCOME_LEARNING, loadOutcomeLearningConfig, readSnapshotInputs, reportOf, runLearningCycle, sha256 } from "../../../packages/outcomes/src/index";
import { NOW } from "../../support/executionFixtures";
import { makeOutcomeHarness } from "../../support/outcomeHarness";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl(), ROLE = "twins_rls_test";
const { db, fx, owner, close, learn, unsyncedClose } = makeOutcomeHarness(URL_);
const clients: pg.Client[] = [];
afterAll(async () => { await close(); await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
async function session(userId: string): Promise<pg.Client> { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c); await c.query(`set role ${ROLE}`); await c.query("select set_config('twins.user_id', $1, false)", [userId]); return c; }
const cfg = { ...DEFAULT_OUTCOME_LEARNING, enabled: true };
const deps = (config = cfg, now = NOW) => ({ db, config, now: () => now });
/** a user with one CLOSED position, its trade outcome and (after a learning cycle) a FINAL attribution */
async function userWithOutcome() { const a = await unsyncedClose(); await advanceOpenOrders(a.deps); await learn(a.userId); return a; }
const snapCount = async (userId: string): Promise<number> => (await (await owner()).query("select count(*)::int as n from analytics_snapshots where user_id = $1", [userId])).rows[0].n as number;

describe("migration 0046: analytics_snapshots is immutable, owner-only and constrained by the database itself", () => {
  it("append-only, paper-only, hash-shaped, one row per (user, input hash); another user sees nothing through row-level security", async () => {
    const a = await userWithOutcome(), b = await unsyncedClose(), c = await owner();
    const snap = (await captureSnapshot(deps(), a.userId, "API")).view.snapshot;
    expect((await c.query("select count(*)::int as n from analytics_snapshots where id = $1", [snap.id])).rows[0].n).toBe(1);
    await expect(c.query("update analytics_snapshots set report = '{}'::jsonb where id = $1", [snap.id])).rejects.toThrow();
    await expect(c.query("delete from analytics_snapshots where id = $1", [snap.id])).rejects.toThrow();
    await expect(c.query("truncate analytics_snapshots")).rejects.toThrow();
    const ins = (over: Record<string, string>) => c.query(`insert into analytics_snapshots (id, user_id, mode, as_of, evidence_hash, input_hash, algorithm_versions, config, config_hash, watermarks, report, report_sha256, created_by) values (gen_random_uuid(), $1, $2, now(), $3, $4, '{}', '{}', $5, '{}', '{}', $6, $7)`,
      [a.userId, over["mode"] ?? "PAPER", over["e"] ?? "a".repeat(64), over["i"] ?? sha256(randomUUID()), "b".repeat(64), "c".repeat(64), over["by"] ?? "API"]);
    await expect(ins({ mode: "LIVE" })).rejects.toThrow(); // paper only
    await expect(ins({ e: "NOT-A-HASH" })).rejects.toThrow(); // hash shape
    await expect(ins({ by: "SOMEONE" })).rejects.toThrow(); // known creators only
    const same = sha256("duplicate"); await ins({ i: same }); await expect(ins({ i: same })).rejects.toThrow(); // one row per (user, input hash)
    const mine = await session(a.userId), theirs = await session(b.userId);
    expect((await mine.query("select count(*)::int as n from analytics_snapshots")).rows[0].n).toBeGreaterThanOrEqual(2);
    expect((await theirs.query("select count(*)::int as n from analytics_snapshots where user_id = $1", [a.userId])).rows[0].n).toBe(0); // owner-only
    await expect(theirs.query("insert into analytics_snapshots (id, user_id, mode, as_of, evidence_hash, input_hash, algorithm_versions, config, config_hash, watermarks, report, report_sha256, created_by) values (gen_random_uuid(), $1, 'PAPER', now(), $2, $3, '{}', '{}', $2, '{}', '{}', $2, 'API')", [a.userId, "d".repeat(64), "e".repeat(64)])).rejects.toThrow(); // cannot write for someone else
  }, 120_000);
});

describe("reproducible snapshots (A2)", () => {
  it("the same evidence reproduces the same report byte for byte, whenever and however often it is built; identical inputs are one stored row", async () => {
    const a = await userWithOutcome();
    const i1 = await readSnapshotInputs(db, a.userId), i2 = await readSnapshotInputs(db, a.userId);
    const h1 = (await currentHashes(db, a.userId, cfg)), r1 = reportOf(i1, cfg, h1.asOf), r2 = reportOf(i2, cfg, h1.asOf);
    expect(canonicalJson(r1)).toBe(canonicalJson(r2)); expect(sha256(canonicalJson(r1))).toBe(sha256(canonicalJson(r2)));
    expect(r1.generatedAt).toBe(h1.asOf.toISOString()); // "as of" comes from the evidence, never the wall clock
    const first = await currentAnalytics(deps(cfg, new Date("2031-01-06T05:00:00Z")), a.userId), later = await currentAnalytics(deps(cfg, new Date("2031-01-06T05:20:00Z")), a.userId);
    expect(first.created === false || first.created === true).toBe(true);
    expect(later.created).toBe(false); expect(later.snapshot.id).toBe(first.snapshot.id); expect(later.snapshot.freshness).toBe("CURRENT");
    expect(canonicalJson(later.report)).toBe(canonicalJson(first.report));
    const row = (await (await owner()).query("select report, report_sha256, algorithm_versions, config, watermarks from analytics_snapshots where id = $1", [first.snapshot.id])).rows[0];
    expect(sha256(canonicalJson(row.report))).toBe(row.report_sha256); // the stored report still matches its recorded hash
    expect(row.algorithm_versions).toMatchObject({ snapshot: "analytics-snapshot-v1", metrics: expect.any(String) }); expect(row.config).toEqual({ minSample: 30, minDriftWindow: 30, holdoutFraction: 0.4 });
    expect(row.watermarks).toMatchObject({ complete: true, rows: { limit: 5000 }, evidence: { attributions: { count: 1 } } });
  }, 120_000);

  it("another user's activity does not change this user's evidence hash (the snapshot is per user)", async () => {
    const a = await userWithOutcome(), s1 = await currentAnalytics(deps(), a.userId), h1 = await currentHashes(db, a.userId, cfg);
    expect(h1.evidenceHash).toBe(s1.snapshot.evidenceHash);
    await userWithOutcome(); // a different user closes a position and is attributed
    expect((await currentHashes(db, a.userId, cfg)).evidenceHash).toBe(h1.evidenceHash);
    expect(await snapCount(a.userId)).toBe(1);
  }, 120_000);

  it("a new attribution for the user changes its evidence hash; the old snapshot remains and a new one is built", async () => {
    const a = await userWithOutcome(), s1 = await currentAnalytics(deps(), a.userId);
    const fpBefore = await evidenceFingerprint(db, a.userId);
    // correct the existing FINAL attribution (append-only new version) -> evidence changes
    const { buildCorrection } = await import("../../../packages/outcomes/src/index");
    const { loadAttributionFacts, latestAttributionForPosition, insertAttribution } = await import("../../../packages/database/src/index");
    const facts = (await loadAttributionFacts(db, a.userId, a.pos.id))!, prev = (await latestAttributionForPosition(db, a.userId, a.pos.id))!;
    const corr = buildCorrection({ ...facts, outcome: { ...facts.outcome!, pnl: (Number(facts.outcome!.pnl) + 0.5).toFixed(2) } as never }, prev, "snapshot test: evidence changes with a reasoned correction");
    expect(corr).not.toBeNull(); await insertAttribution(db, a.userId, corr!);
    const fpAfter = await evidenceFingerprint(db, a.userId);
    expect(fpAfter.attributions.count).toBe(fpBefore.attributions.count + 1);
    const s2 = await currentAnalytics(deps(), a.userId);
    expect(s2.snapshot.id).not.toBe(s1.snapshot.id); expect(s2.snapshot.evidenceHash).not.toBe(s1.snapshot.evidenceHash); expect(s2.snapshot.freshness).toBe("CURRENT");
    expect(await findSnapshotByEvidence(db, a.userId, s1.snapshot.evidenceHash)).toMatchObject({ id: s1.snapshot.id }); // the first snapshot is untouched
    expect(await snapCount(a.userId)).toBe(2);
  }, 120_000);

  it("eight concurrent requests for the same evidence create exactly one snapshot and all receive it", async () => {
    const a = await userWithOutcome();
    const views = await Promise.all(Array.from({ length: 8 }, () => currentAnalytics(deps(), a.userId)));
    expect(new Set(views.map((v) => v.snapshot.id)).size).toBe(1);
    expect(await snapCount(a.userId)).toBe(1);
    const caps = await Promise.all(Array.from({ length: 6 }, () => captureSnapshot(deps(), a.userId, "API"))); // direct builds racing each other
    expect(new Set(caps.map((x) => x.view.snapshot.id)).size).toBe(1); expect(caps.filter((x) => x.created).length).toBe(0); // the row already existed
    expect(await snapCount(a.userId)).toBe(1);
  }, 120_000);

  it("a concurrent build of the same evidence converges on one row even when no snapshot exists yet", async () => {
    const a = await unsyncedClose(); await advanceOpenOrders(a.deps); // closed with its outcome, nothing attributed or analysed yet
    const caps = await Promise.all(Array.from({ length: 8 }, () => captureSnapshot(deps(), a.userId, "API")));
    expect(new Set(caps.map((x) => x.view.snapshot.id)).size).toBe(1); expect(caps.filter((x) => x.created).length).toBe(1); // exactly one writer
    expect(await snapCount(a.userId)).toBe(1);
  }, 120_000);

  it("every input comes from ONE consistent database snapshot: a correction committed mid-read is invisible to the rest of that read, then visible to the next", async () => {
    const a = await userWithOutcome();
    const { buildCorrection } = await import("../../../packages/outcomes/src/index");
    const { loadAttributionFacts, latestAttributionForPosition, insertAttribution, latestAttributions } = await import("../../../packages/database/src/index");
    const facts = (await loadAttributionFacts(db, a.userId, a.pos.id))!, prev = (await latestAttributionForPosition(db, a.userId, a.pos.id))!;
    const corr = buildCorrection({ ...facts, outcome: { ...facts.outcome!, pnl: (Number(facts.outcome!.pnl) + 1).toFixed(2) } as never }, prev, "consistency test: a reasoned correction committed during a read");
    expect(corr).not.toBeNull();
    const seen = await db.transaction(async (tx) => {
      const t = tx as unknown as typeof db;
      const fp1 = await evidenceFingerprint(t, a.userId), rows1 = await latestAttributions(t, a.userId, { mode: "PAPER", limit: 5000 });
      const id = await insertAttribution(db, a.userId, corr!); // ANOTHER connection commits while this read is in progress
      expect(id).not.toBeNull();
      const fp2 = await evidenceFingerprint(t, a.userId), rows2 = await latestAttributions(t, a.userId, { mode: "PAPER", limit: 5000 });
      return { fp1, fp2, v1: rows1.map((r) => r.version), v2: rows2.map((r) => r.version) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(seen.fp2).toEqual(seen.fp1); expect(seen.v2).toEqual(seen.v1); // the snapshot did not move during the read
    const after = await evidenceFingerprint(db, a.userId);
    expect(after.attributions.count).toBe(seen.fp1.attributions.count + 1); // the committed correction is visible to the next read
  }, 120_000);

  it("if the current evidence cannot be analysed the newest stored snapshot is served marked STALE with the reason, never as current", async () => {
    const a = await userWithOutcome(), good = await currentAnalytics(deps(), a.userId);
    const broken = new Proxy(db, { get(t, p) { const v = Reflect.get(t, p, t) as unknown; if (p === "transaction") return async (fn: unknown, cfg2?: { isolationLevel?: string }) => { if (cfg2?.isolationLevel) throw new Error("simulated database fault"); return (v as (...x: unknown[]) => unknown).call(t, fn, cfg2); }; return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v; } }) as typeof db;
    const stale = await currentAnalytics({ db: broken, config: cfg, now: () => NOW }, a.userId);
    expect(stale.snapshot).toMatchObject({ id: good.snapshot.id, freshness: "STALE" }); expect(stale.snapshot.staleReason).toMatch(/could not be analysed/);
    const nobody = await fx.pipeline(async (t, q) => (await owner()).query(t, q as unknown[])); // a user with no snapshot and a broken database has nothing to fall back to
    await expect(currentAnalytics({ db: broken, config: cfg, now: () => NOW }, nobody.userId)).rejects.toThrow(/simulated database fault/);
  }, 120_000);
});

describe("one authoritative configuration for the API and the worker (A3)", () => {
  it("the API and the learning cycle share one snapshot and reach identical sufficiency verdicts; a different setting is a different snapshot", async () => {
    const a = await unsyncedClose(); await advanceOpenOrders(a.deps);
    const env = { TWINS_LEARNING_ENABLED: "true", TWINS_LEARNING_MIN_SAMPLE: "45", TWINS_LEARNING_MIN_DRIFT_WINDOW: "40" } as NodeJS.ProcessEnv;
    const workerCfg = loadOutcomeLearningConfig(env), ops = buildUserOps(db, env);
    const cycle = await runLearningCycle({ db, config: workerCfg, only: [a.userId], now: () => NOW });
    expect(cycle.snapshots.created).toBe(1);
    const api = await ops.analytics(a.userId, NOW);
    expect(api.snapshot).toMatchObject({ createdBy: "LEARNING_CYCLE", freshness: "CURRENT" }); // the API reuses the very snapshot the worker stored
    const row = (await (await owner()).query("select config from analytics_snapshots where id = $1", [api.snapshot.id])).rows[0];
    expect(row.config).toEqual({ minSample: 45, minDriftWindow: 40, holdoutFraction: 0.4 });
    expect(api.report.modes.PAPER.overview.status).toBe("INSUFFICIENT_DATA"); expect(api.report.modes.PAPER.overview.winRate.note).toMatch(/fewer than 45/);
    // the same evidence under the DEFAULT settings is a different snapshot with its own verdict basis
    const dflt = await currentAnalytics(deps(), a.userId);
    expect(dflt.snapshot.id).not.toBe(api.snapshot.id); expect(dflt.snapshot.configHash).not.toBe(api.snapshot.configHash);
    expect(dflt.report.modes.PAPER.overview.winRate.note).toMatch(/fewer than 30/);
  }, 120_000);

  it("invalid settings are rejected, the floors cannot be lowered, and the API refuses to start on a bad value", () => {
    for (const bad of [{ TWINS_LEARNING_MIN_SAMPLE: "29" }, { TWINS_LEARNING_MIN_SAMPLE: "abc" }, { TWINS_LEARNING_MIN_SAMPLE: "30.5" }, { TWINS_LEARNING_MIN_DRIFT_WINDOW: "10" }, { TWINS_LEARNING_HOLDOUT_FRACTION: "0.9" }, { TWINS_LEARNING_HOLDOUT_FRACTION: "0.1" }, { TWINS_LEARNING_ENABLED: "yes" }, { TWINS_LEARNING_SNAPSHOT_MAX_AGE_SECONDS: "5" }, { TWINS_LEARNING_INTERVAL_MS: "1" }]) {
      expect(() => loadOutcomeLearningConfig(bad as NodeJS.ProcessEnv), JSON.stringify(bad)).toThrow();
      expect(() => buildUserOps(db, bad as NodeJS.ProcessEnv), JSON.stringify(bad)).toThrow();
    }
    expect(loadOutcomeLearningConfig({}).minSample).toBe(30); expect(buildUserOps(db, {})).toBeTruthy();
  });
});
