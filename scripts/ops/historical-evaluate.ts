/**
 * Operations CLI for historical outcome evaluation (Stage 4 / Task 2). Evaluates imported historical signals against PRE-EXPORTED market data files (format twins-historical-bars-v1,
 * see docs/twins/HISTORICAL_OUTCOME_EVALUATION.md). It contacts no market-data provider, broker or Telegram, and creates no signal, risk decision, approval card or order.
 *
 *   historical-evaluate record  --id <normalized-record-uuid> --data <file>[,<file>...] --created-by operator:<name> [--dry-run] [options]
 *   historical-evaluate batch   --batch <import-batch-uuid>   --data <file>[,<file>...] --created-by operator:<name> [--dry-run] [--chunk-size N] [options]
 *   historical-evaluate report  --run <run-uuid>
 *
 * options: --as-of <ISO instant with offset> (default now; part of the run identity, so re-running with the same value resumes / is a no-op), --horizon-days N (default 30),
 *          --intrabar unverifiable|conservative, --tz-offset-minutes N (markets other than NSE/BSE), --near-tolerance-pct P, --json
 * Output carries counts, codes and ids only - never message content. Exit codes: 0 ok, 1 failure, 2 usage error, 3 refused / invalid input. The connection string is never printed.
 */
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { buildEvaluationReport, DatasetError, dryRunEvaluation, fileProvider, InputError, renderEvaluationReport, runEvaluation, type RunOptions, type Scope } from "../../packages/historical/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
  now?: () => Date;
}
const USAGE = [
  "usage:",
  "  historical-evaluate record --id <uuid> --data <file,...> --created-by operator:<name> [--dry-run] [options]",
  "  historical-evaluate batch --batch <uuid> --data <file,...> --created-by operator:<name> [--dry-run] [--chunk-size N] [options]",
  "  historical-evaluate report --run <uuid>",
  "  options: --as-of <ISO> --horizon-days N --intrabar unverifiable|conservative --tz-offset-minutes N --near-tolerance-pct P --json",
].join("\n");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE = new Set(["dry-run", "json"]);

function parseArgs(args: string[]): { values: Map<string, string>; bare: Set<string> } | null {
  const values = new Map<string, string>(), bare = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) return null;
    const k = a.slice(2);
    if (BARE.has(k)) { bare.add(k); continue; }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    values.set(k, v);
    i++;
  }
  return { values, bare };
}
const json = (o: unknown): string => JSON.stringify(o, null, 2);
const intOpt = (v: string | undefined): number | null | "bad" => (v === undefined ? null : /^-?\d{1,5}$/.test(v) ? Number(v) : "bad");

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (!cmd || !a || !["record", "batch", "report"].includes(cmd)) { deps.err(USAGE); return 2; }
  let handle: { db: Db; close: () => Promise<void> } | undefined;
  const open = (): { db: Db; close: () => Promise<void> } | undefined => {
    const url = deps.env["DATABASE_URL"];
    if (!url) return undefined;
    handle ??= deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
    return handle;
  };
  try {
    if (cmd === "report") {
      const id = a.values.get("run");
      if (!id || !UUID.test(id)) { deps.err(USAGE); return 2; }
      const h = open();
      if (!h) { deps.err("DATABASE_URL is not set"); return 1; }
      const r = await buildEvaluationReport(h.db, id);
      if (!r) { deps.err("refused: run_not_found"); return 3; }
      deps.out(a.bare.has("json") ? json(r) : renderEvaluationReport(r));
      return 0;
    }
    const target = cmd === "record" ? a.values.get("id") : a.values.get("batch");
    const data = a.values.get("data"), by = a.values.get("created-by");
    if (!target || !UUID.test(target) || !data || !by) { deps.err(USAGE); return 2; }
    const asOfRaw = a.values.get("as-of");
    const asOf = asOfRaw === undefined ? (deps.now?.() ?? new Date()) : new Date(asOfRaw);
    if (asOfRaw !== undefined && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(asOfRaw) || Number.isNaN(asOf.getTime()))) { deps.err("--as-of must be an ISO instant with an offset"); return 2; }
    const horizon = intOpt(a.values.get("horizon-days")), tz = intOpt(a.values.get("tz-offset-minutes")), chunk = intOpt(a.values.get("chunk-size"));
    if (horizon === "bad" || tz === "bad" || chunk === "bad") { deps.err("numeric option is not a whole number"); return 2; }
    const intrabar = a.values.get("intrabar");
    if (intrabar !== undefined && intrabar !== "unverifiable" && intrabar !== "conservative") { deps.err("--intrabar must be unverifiable or conservative"); return 2; }
    const nearRaw = a.values.get("near-tolerance-pct");
    const near = nearRaw === undefined ? null : Number(nearRaw);
    if (near !== null && !Number.isFinite(near)) { deps.err("--near-tolerance-pct must be a number"); return 2; }
    const h = open();
    if (!h) { deps.err("DATABASE_URL is not set"); return 1; }
    const provider = await fileProvider(data.split(",").filter(Boolean));
    const scope: Scope = cmd === "record" ? { kind: "RECORD", normalizedRecordId: target } : { kind: "BATCH", batchId: target };
    const opts: RunOptions = {
      scope, provider, createdBy: by, asOf, ...(chunk ? { chunkSize: chunk } : {}),
      config: { ...(horizon !== null ? { horizonDays: horizon } : {}), ...(intrabar ? { intrabarPolicy: intrabar } : {}), ...(tz !== null ? { tzOffsetMinutes: tz } : {}), ...(near !== null ? { nearTolerancePct: near } : {}) },
    };
    if (a.bare.has("dry-run")) {
      const r = await dryRunEvaluation(h.db, opts);
      deps.out(json({ dryRun: true, wrote: false, asOf: asOf.toISOString(), ...r }));
      return 0;
    }
    const r = await runEvaluation(h.db, opts);
    deps.out(`evaluation ${r.outcome}: run ${r.runId} (as of ${asOf.toISOString()}, ${r.resumedAfter} already labelled, ${r.checkpoints} events)`);
    const report = await buildEvaluationReport(h.db, r.runId);
    if (report) deps.out(a.bare.has("json") ? json(report) : renderEvaluationReport(report));
    return 0;
  } catch (error) {
    if (error instanceof InputError) { deps.err(`refused: ${error.code}${error.file ? ` (${error.file})` : ""}`); return 3; }
    if (error instanceof DatasetError) { deps.err(`refused: ${error.code}${error.where ? ` (${error.where})` : ""}`); return 3; }
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`);
    return 1;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("historical-evaluate");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code), () => process.exit(1));
}
