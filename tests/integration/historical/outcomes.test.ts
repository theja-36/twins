/**
 * Historical outcome evaluation against REAL PostgreSQL (Stage 4 / Task 2). Synthetic messages and synthetic, deterministic bars only; no provider, broker, Telegram or network.
 * Channel labels carry a per-run suffix, so repeated runs on one database never share an identity.
 */
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { buildEvaluationReport, dryRunEvaluation, inspectInput, memoryProvider, runEvaluation, runImport, type RunOptions } from "../../../packages/historical/src/index";
import { runCli } from "../../../scripts/ops/historical-evaluate";
import { tempDir, writeJsonl } from "../../support/historicalFixtures";
import { dailyBars, datasetOf, equitySeries, optionSeries, underlyingSeries, type Ohlc } from "../../support/outcomeFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
let handle: BoundedDbHandle;
const db = () => handle.db;
const sfx = () => randomUUID().slice(0, 8);
const NOW = new Date("2026-10-30T10:00:00Z");
const AS_OF = new Date("2026-06-01T00:00:00Z");
const D0 = new Date("2024-03-04T00:00:00Z"); // every synthetic message is sent at D0; bars start the next day
const bars = (days: number, base: number, at: Record<number, Ohlc> = {}) => dailyBars({ start: D0, days, base, at });

beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const n = async (sql: string, params: unknown[] = []) => Number(must((await q(sql, params))[0])["n"]);
const LIVE = ["telegram_messages", "signals", "options_claims", "risk_decisions", "risk_approvals", "risk_approval_cards", "orders", "fills", "positions", "decisions", "claim_review_cards", "telegram_intake_outbox", "historical_source_records", "historical_normalized_records", "historical_import_batches"];
const counts = async (tables = LIVE) => Promise.all(tables.map((t) => n(`select count(*)::int as n from ${t}`)));
const OUTCOME_TABLES = ["historical_datasets", "historical_evaluation_runs", "historical_outcome_labels", "historical_evaluation_events"];

const MESSAGES: Array<[string, string]> = [
  ["win", "BUY WINCO @ 100 SL 95 TGT 105 110 115"],
  ["loss", "BUY LOSSCO @ 100 SL 95 TGT 105 110 115"],
  ["noentry", "BUY AWAYCO @ 100 SL 95 TGT 105 110 115"],
  ["gap", "BUY GAPCO @ 100 SL 95 TGT 105 110 115"],
  ["nodata", "BUY NODATACO @ 100 SL 95 TGT 105 110 115"],
  ["optce", "BUY NIFTY 24500 CE 28 MAR 2024 @ 100 SL 80 TGT 120 140 premium"],
  ["optpe", "BUY NIFTY 24400 PE 28 MAR 2024 @ 100 SL 80 TGT 120 140 premium"],
  ["noise", "Good morning everyone, markets look calm today"],
];
const DATA = datasetOf([
  equitySeries("WINCO", bars(30, 100, { 3: [100, 111, 100, 110] })),
  equitySeries("LOSSCO", bars(30, 100, { 3: [100, 100, 94, 95] })),
  equitySeries("AWAYCO", bars(30, 130)),
  equitySeries("GAPCO", dailyBars({ start: D0, days: 30, base: 100, skip: [3, 4, 5, 6, 7, 8, 9] })),
  optionSeries("NIFTY", 24500, "CE", "2024-03-28", dailyBars({ start: D0, days: 24, base: 100, at: { 2: [100, 121, 100, 120] } })),
  underlyingSeries("NIFTY", dailyBars({ start: D0, days: 24, base: 22000 })), // an underlying exists, but there is NO premium series for the 24400 PE
]);

async function importBatch(label: string, messages = MESSAGES) {
  const ch = `outc-${sfx()}`;
  const file = writeJsonl(tempDir(), "export.jsonl", messages.map(([, text], i) => ({ channel: ch, message_id: i + 1, timestamp: D0.toISOString(), text, market: "NSE" })));
  const r = await runImport(db(), await inspectInput(file), { label, defaultMarket: "NSE", createdBy: "service:itest", confirmedSource: file, now: NOW });
  const ids = await q("select n.id, s.original_message_id from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = $1 order by s.source_line", [r.batchId]);
  return { batchId: r.batchId, ids: ids.map((x) => x["id"] as string), file };
}
const runOpts = (batchId: string, over: Partial<RunOptions> = {}): RunOptions => ({ scope: { kind: "BATCH", batchId }, provider: memoryProvider([DATA]), createdBy: "service:itest", asOf: AS_OF, ...over });
const labelsOf = async (runId: string) => Object.fromEntries((await q("select l.final_outcome, l.primary_reason, s.original_message_id from historical_outcome_labels l join historical_source_records s on s.id = l.source_record_id where l.run_id = $1", [runId])).map((r) => [r["original_message_id"], r]));

describe("batch evaluation end to end", () => {
  it("labels every evaluable record, keeps the evidence, never touches live tables or the imported records, and keeps every chain intact", async () => {
    const { batchId } = await importBatch(`outc-${sfx()}`);
    const before = await counts();
    const datasetsBefore = await n("select count(*)::int as n from historical_datasets");
    void datasetsBefore;
    const r = await runEvaluation(db(), runOpts(batchId));
    expect(r.outcome).toBe("EVALUATED");
    expect(r.counters.skippedNotEvaluable).toBeGreaterThanOrEqual(1);
    const by = await labelsOf(r.runId);
    expect(by["1"]).toMatchObject({ final_outcome: "WIN_T2" });
    expect(by["2"]).toMatchObject({ final_outcome: "LOSS_SL" });
    expect(by["3"]).toMatchObject({ final_outcome: "NO_ENTRY" });
    expect(by["4"]).toMatchObject({ final_outcome: "UNVERIFIABLE", primary_reason: "DATA_GAP" });
    expect(by["5"]).toMatchObject({ final_outcome: "UNVERIFIABLE", primary_reason: "NO_MARKET_DATA" });
    expect(by["6"]).toMatchObject({ final_outcome: "WIN_T1" }); // CE premium bars, not the underlying
    expect(by["7"]).toMatchObject({ final_outcome: "UNVERIFIABLE", primary_reason: "OPTION_PREMIUM_DATA_MISSING" });
    expect(by["8"]).toBeUndefined(); // chatter has no signal: not evaluated

    const [l] = await q("select l.*, d.dataset_id as ds, d.content_sha256 from historical_outcome_labels l join historical_datasets d on d.id = l.dataset_id join historical_source_records s on s.id = l.source_record_id where l.run_id = $1 and s.original_message_id = '1'", [r.runId]);
    expect(l).toMatchObject({ algorithm_version: "outcome-eval-v1", entry_status: "ENTRY_REACHED", sl_status: "SL_NOT_HIT", data_quality: "GOOD", ds: "synthetic-eod", created_by: "service:itest" });
    expect(l!["content_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(l!["target_evaluations"]).toHaveLength(3);
    expect(l!["data_window"]).toMatchObject({ validityKind: "horizon_cap", gapCount: 0, intervalSeconds: 86_400 });
    expect(l!["input_snapshot"]).toMatchObject({ side: "buy", stopLoss: 95, targets: [105, 110, 115] });
    expect(JSON.stringify(l)).not.toMatch(/WINCO @ 100|Good morning/); // no message text is stored with the label
    const [run] = await q("select * from historical_evaluation_runs where id = $1", [r.runId]);
    expect(run).toMatchObject({ scope: "BATCH", algorithm_version: "outcome-eval-v1", import_batch_id: batchId });
    expect(run!["config"]).toMatchObject({ horizonDays: 30, intrabarPolicy: "unverifiable" });

    // nothing downstream or upstream changed
    expect(await counts()).toEqual(before);
    for (const t of OUTCOME_TABLES) expect(await n(`select count(*)::int as n from ${t}`)).toBeGreaterThan(0);
    const report = must(await buildEvaluationReport(db(), r.runId));
    expect(report).toMatchObject({ labels: 7, completed: true });
    expect(report.byOutcome).toMatchObject({ WIN_T2: 1, LOSS_SL: 1, NO_ENTRY: 1, UNVERIFIABLE: 3, WIN_T1: 1 });
    expect((await verifyAuditChainsWithPool(pool, { chains: OUTCOME_TABLES })).ok).toBe(true);
  });

  it("is idempotent: the same evaluation resolves to the same run and writes nothing more", async () => {
    const { batchId } = await importBatch(`outc-${sfx()}`);
    const first = await runEvaluation(db(), runOpts(batchId));
    const tables = await counts(OUTCOME_TABLES);
    const again = await runEvaluation(db(), runOpts(batchId));
    expect(again).toMatchObject({ outcome: "ALREADY_COMPLETED", runId: first.runId, runKey: first.runKey });
    expect(await counts(OUTCOME_TABLES)).toEqual(tables);
  });

  it("re-evaluation under a different as-of instant is a separate run with identical labels (deterministic)", async () => {
    const { batchId } = await importBatch(`outc-${sfx()}`);
    const a = await runEvaluation(db(), runOpts(batchId));
    const b = await runEvaluation(db(), runOpts(batchId, { asOf: new Date("2026-07-01T00:00:00Z") }));
    expect(b.runId).not.toBe(a.runId);
    expect(await labelsOf(b.runId)).toEqual(await labelsOf(a.runId));
  });

  it("resumes after a crash between chunks: no duplicate labels, same final result as an uninterrupted run", async () => {
    const { batchId } = await importBatch(`outc-${sfx()}`);
    await expect(runEvaluation(db(), runOpts(batchId, { chunkSize: 2, afterChunk: (s) => { if (s === 2) throw new Error("simulated crash"); } }))).rejects.toThrow("simulated crash");
    const [run] = await q("select id from historical_evaluation_runs where import_batch_id = $1", [batchId]);
    const partial = await n("select count(*)::int as n from historical_outcome_labels where run_id = $1", [run!["id"]]);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(7);
    const resumed = await runEvaluation(db(), runOpts(batchId, { chunkSize: 2 }));
    expect(resumed).toMatchObject({ outcome: "RESUMED", runId: run!["id"] });
    expect(resumed.resumedAfter).toBeGreaterThan(0);
    expect(await n("select count(*)::int as n from historical_outcome_labels where run_id = $1", [run!["id"]])).toBe(7);
    expect(await n("select count(distinct normalized_record_id)::int as n from historical_outcome_labels where run_id = $1", [run!["id"]])).toBe(7);
    expect(Object.values(await labelsOf(resumed.runId)).map((x) => x["final_outcome"]).sort()).toEqual(["LOSS_SL", "NO_ENTRY", "UNVERIFIABLE", "UNVERIFIABLE", "UNVERIFIABLE", "WIN_T1", "WIN_T2"]);
    expect((await verifyAuditChainsWithPool(pool, { chains: OUTCOME_TABLES })).ok).toBe(true);
  });

  it("a dry run reports the outcomes and writes nothing", async () => {
    const { batchId } = await importBatch(`outc-${sfx()}`);
    const before = await counts([...LIVE, ...OUTCOME_TABLES]);
    const d = await dryRunEvaluation(db(), runOpts(batchId));
    expect(d).toMatchObject({ targets: 8, evaluable: 7 });
    expect(d.counters.byOutcome).toMatchObject({ WIN_T2: 1, LOSS_SL: 1, NO_ENTRY: 1 });
    expect(await counts([...LIVE, ...OUTCOME_TABLES])).toEqual(before);
  });

  it("future-dated bars are rejected: data that is not complete at the as-of instant never produces a win", async () => {
    const { batchId } = await importBatch(`outc-${sfx()}`, [MESSAGES[0] as [string, string]]);
    const r = await runEvaluation(db(), runOpts(batchId, { asOf: new Date("2024-03-05T12:00:00Z") }));
    const by = await labelsOf(r.runId);
    expect(by["1"]).toMatchObject({ final_outcome: "UNVERIFIABLE" });
  });
});

describe("the outcome tables are append-only and tamper-evident", () => {
  it("refuses update, delete and truncate on every outcome table", async () => {
    const c = await pool.connect();
    try {
      for (const sql of [
        "update historical_outcome_labels set final_outcome = 'WIN_T3'", "delete from historical_outcome_labels", "truncate historical_outcome_labels",
        "update historical_datasets set bar_count = 0", "delete from historical_datasets", "update historical_evaluation_runs set algorithm_version = 'x'", "delete from historical_evaluation_runs",
        "update historical_evaluation_events set sequence = 99", "delete from historical_evaluation_events",
      ]) {
        const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
        expect(["23001", "0A000"], `${sql} -> ${e?.code}`).toContain(e?.code);
      }
    } finally { c.release(); }
  });
  it("the label integrity trigger refuses a label whose run, record or hash fields are inconsistent", async () => {
    const { batchId, ids } = await importBatch(`outc-${sfx()}`, [MESSAGES[0] as [string, string]]);
    const r = await runEvaluation(db(), runOpts(batchId));
    const [row] = await q("select * from historical_outcome_labels where run_id = $1", [r.runId]);
    const c = await pool.connect();
    try {
      const e = await c.query(
        "insert into historical_outcome_labels (run_id, normalized_record_id, source_record_id, algorithm_version, final_outcome, reasons, entry_status, sl_status, target_evaluations, data_quality, data_window, input_snapshot, evidence, created_by) select run_id, normalized_record_id, $2, algorithm_version, final_outcome, reasons, entry_status, sl_status, target_evaluations, data_quality, data_window, input_snapshot, evidence, created_by from historical_outcome_labels where id = $1",
        [row!["id"], randomUUID()],
      ).then(() => null, (x: { code?: string }) => x);
      expect(e).not.toBeNull(); // the unique (run, record) index and the foreign key / integrity trigger refuse it
    } finally { c.release(); }
    expect(ids).toHaveLength(1);
  });
});

describe("the CLI", () => {
  it("evaluates one record by id, supports --dry-run, resumes a batch, and prints counts, codes and ids only", async () => {
    const { batchId, ids, file } = await importBatch(`outc-${sfx()}`);
    const dir = tempDir();
    const data = join(dir, "bars.json");
    writeFileSync(data, JSON.stringify(DATA));
    const out: string[] = [], errs: string[] = [];
    const cli = (args: string[]) => runCli(args, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }), now: () => NOW });
    const asOf = ["--as-of", AS_OF.toISOString(), "--created-by", "operator:itest", "--data", data];
    expect(await cli(["record", "--id", must(ids[0]), ...asOf, "--dry-run"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ dryRun: true, wrote: false, targets: 1, evaluable: 1 });
    out.length = 0;
    expect(await cli(["record", "--id", must(ids[0]), ...asOf])).toBe(0);
    expect(out.join("\n")).toMatch(/evaluation EVALUATED: run [0-9a-f-]{36}/);
    expect(out.join("\n")).toMatch(/WIN_T2: 1/);
    const runId = /run ([0-9a-f-]{36})/.exec(out.join("\n"))?.[1];
    out.length = 0;
    expect(await cli(["batch", "--batch", batchId, ...asOf, "--chunk-size", "3"])).toBe(0);
    expect(out.join("\n")).toMatch(/evaluation EVALUATED/);
    out.length = 0;
    expect(await cli(["batch", "--batch", batchId, ...asOf])).toBe(0);
    expect(out.join("\n")).toMatch(/ALREADY_COMPLETED/);
    out.length = 0;
    expect(await cli(["report", "--run", must(runId)])).toBe(0);
    expect(out.join("\n")).toContain("data quality:");
    expect(out.join("\n") + errs.join("\n")).not.toMatch(/WINCO|Good morning|DATABASE_URL=|postgres(ql)?:\/\//);
    // usage and refusals
    expect(await cli(["record"])).toBe(2);
    expect(await cli(["batch", "--batch", batchId, "--data", join(dir, "missing.json"), "--created-by", "operator:itest"])).toBe(3);
    expect(await cli(["batch", "--batch", randomUUID(), ...asOf])).toBe(3);
    expect(createHash("sha256").update(file).digest("hex")).toHaveLength(64);
  });
});
