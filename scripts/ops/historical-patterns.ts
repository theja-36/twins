/**
 * Operations CLI for the historical pattern library and calibrated confidence (Stage 4 / Task 4). Works only on already-imported historical records, their outcome labels and scorecard
 * tiers. Contacts no Telegram, provider or broker; creates no signal, risk decision, approval card or order; the confidence model is local and deterministic (no LLM).
 *
 *   historical-patterns rebuild-library --created-by operator:<name>
 *   historical-patterns rebuild-metrics --created-by operator:<name> [--as-of <ISO>] [--embargo-days N] [--min-sample N]
 *   historical-patterns estimate-record --id <normalized-record-uuid> --created-by operator:<name> [--pattern-run <uuid>] [--trust-mode point_in_time|latest] [--allow-in-sample] [--config file.json] [--dry-run]
 *   historical-patterns estimate-batch  --batch <import-batch-uuid>   --created-by operator:<name> [same options]
 *   historical-patterns show   --pattern "<key text | hash>" [--run <uuid>] [--json]
 *   historical-patterns export --format json|csv [--run <uuid>] [--out file]
 *
 * Estimates for historical signals are refused unless the pattern run (and trust tiers) pre-date each signal; --allow-in-sample records the estimate as in-sample (LOOKAHEAD_IN_SAMPLE).
 * `--as-of` defaults to now and is part of a pattern run's identity. Output is counts, identifiers, feature keys and numbers only. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { exportPatternReport, InputError, rebuildPatternLibrary, rebuildPatternMetrics, runConfidenceEstimation, showPattern, type EstimateOptions } from "../../packages/historical/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
  now?: () => Date;
}
const USAGE = [
  "usage:",
  "  historical-patterns rebuild-library --created-by operator:<name>",
  "  historical-patterns rebuild-metrics --created-by operator:<name> [--as-of <ISO>] [--embargo-days N] [--min-sample N]",
  "  historical-patterns estimate-record --id <uuid> --created-by operator:<name> [--pattern-run <uuid>] [--trust-mode point_in_time|latest] [--allow-in-sample] [--config file.json] [--dry-run]",
  "  historical-patterns estimate-batch --batch <uuid> --created-by operator:<name> [same options]",
  "  historical-patterns show --pattern \"<key text | hash>\" [--run <uuid>] [--json]",
  "  historical-patterns export --format json|csv [--run <uuid>] [--out file]",
].join("\n");
const BARE = new Set(["allow-in-sample", "dry-run", "json"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const intOpt = (v: string | undefined): number | undefined | "bad" => (v === undefined ? undefined : /^\d{1,5}$/.test(v) ? Number(v) : "bad");

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (!cmd || !a || !["rebuild-library", "rebuild-metrics", "estimate-record", "estimate-batch", "show", "export"].includes(cmd)) { deps.err(USAGE); return 2; }
  let handle: { db: Db; close: () => Promise<void> } | undefined;
  try {
    const url = deps.env["DATABASE_URL"];
    if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
    const by = a.values.get("created-by");
    const asOfRaw = a.values.get("as-of");
    const asOf = asOfRaw === undefined ? (deps.now?.() ?? new Date()) : new Date(asOfRaw);
    if (asOfRaw !== undefined && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(asOfRaw) || Number.isNaN(asOf.getTime()))) { deps.err("--as-of must be an ISO instant with an offset"); return 2; }
    const embargo = intOpt(a.values.get("embargo-days")), minSample = intOpt(a.values.get("min-sample"));
    if (embargo === "bad" || minSample === "bad") { deps.err("numeric option is not a whole number"); return 2; }
    const run = a.values.get("run");
    if (run && !UUID.test(run)) { deps.err(USAGE); return 2; }
    handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
    const db = handle.db;

    if (cmd === "rebuild-library") {
      if (!by) { deps.err(USAGE); return 2; }
      const r = await rebuildPatternLibrary(db, by);
      deps.out(`library: ${r.patterns} patterns from ${r.signals} signals (${Object.entries(r.byLevel).map(([k, v]) => `${k}=${v}`).join(", ")})`);
      return 0;
    }
    if (cmd === "rebuild-metrics") {
      if (!by) { deps.err(USAGE); return 2; }
      const r = await rebuildPatternMetrics(db, { asOf, createdBy: by, config: { ...(embargo !== undefined ? { embargoDays: embargo } : {}), ...(minSample !== undefined ? { minSample } : {}) } });
      deps.out(`${r.created ? "built" : "unchanged"} pattern run ${r.runId}: ${r.patterns} patterns (${r.sufficient} sufficient) from ${r.trainingSignals} training signals, as of ${asOf.toISOString()}`);
      return 0;
    }
    if (cmd === "estimate-record" || cmd === "estimate-batch") {
      const target = cmd === "estimate-record" ? a.values.get("id") : a.values.get("batch");
      const mode = a.values.get("trust-mode") ?? "point_in_time";
      if (!by || !target || !UUID.test(target) || (mode !== "point_in_time" && mode !== "latest")) { deps.err(USAGE); return 2; }
      const cfgPath = a.values.get("config");
      let config: unknown;
      if (cfgPath) { try { config = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { deps.err("refused: config_unreadable"); return 3; } }
      const pr = a.values.get("pattern-run");
      if (pr && !UUID.test(pr)) { deps.err(USAGE); return 2; }
      const opts: EstimateOptions = {
        scope: cmd === "estimate-record" ? { kind: "RECORD", normalizedRecordId: target } : { kind: "BATCH", batchId: target }, createdBy: by, trustMode: mode, allowInSample: a.bare.has("allow-in-sample"), dryRun: a.bare.has("dry-run"),
        ...(pr ? { patternRunId: pr } : {}), ...(config ? { config: config as never } : {}),
      };
      const r = await runConfidenceEstimation(db, opts);
      deps.out(`${opts.dryRun ? "dry-run (nothing written)" : r.created ? "estimated" : "unchanged"}${r.runId ? ` run ${r.runId}` : ""}: ${r.counts.evaluated} signals (${r.counts.skippedNotSignal} not signals), pattern run ${r.patternRunId}${r.lookahead ? ", IN-SAMPLE (lookahead)" : ""}`);
      deps.out(`  tiers: ${Object.entries(r.counts.byTier).sort().map(([k, v]) => `${k}=${v}`).join(", ") || "-"}; evidence: ${Object.entries(r.counts.byEvidence).sort().map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`);
      return 0;
    }
    if (cmd === "show") {
      const pat = a.values.get("pattern");
      if (!pat) { deps.err(USAGE); return 2; }
      const d = await showPattern(db, pat, run);
      if (!d) { deps.err("refused: pattern_not_found"); return 3; }
      if (a.bare.has("json")) { deps.out(JSON.stringify(d, null, 2)); return 0; }
      const m = d.metrics as { winRateEntered: number | null; winRateEnteredWilsonLower: number | null; winRateEnteredWilsonUpper: number | null; netExpectancyR: number | null; unverifiableRate: number | null; maxDrawdownR: number };
      deps.out(`${d.keyText}  [${d.status}] n=${d.sampleSize} (historical association only)`);
      deps.out(`  win rate (entered) ${m.winRateEntered} [Wilson ${m.winRateEnteredWilsonLower}..${m.winRateEnteredWilsonUpper}] net R ${m.netExpectancyR} unverifiable ${m.unverifiableRate} maxDD ${m.maxDrawdownR}; observed ${d.firstObserved?.slice(0, 10) ?? "-"}..${d.lastObserved?.slice(0, 10) ?? "-"}; run ${d.runId}`);
      return 0;
    }
    const format = a.values.get("format");
    if (format !== "json" && format !== "csv") { deps.err(USAGE); return 2; }
    const text = await exportPatternReport(db, format, run);
    const outPath = a.values.get("out");
    if (outPath) { writeFileSync(outPath, text + "\n", { flag: "wx" }); deps.out(`wrote ${outPath}`); } else deps.out(text);
    return 0;
  } catch (error) {
    if (error instanceof InputError) { deps.err(`refused: ${error.code}`); return 3; }
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`);
    return 1;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("historical-patterns");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code), () => process.exit(1));
}
