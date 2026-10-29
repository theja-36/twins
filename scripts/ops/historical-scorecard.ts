/**
 * Operations CLI for source scorecards and trust tiers (Stage 4 / Task 3). Works only on already-imported historical records and their evaluated outcome labels; it contacts no
 * Telegram, provider or broker, and creates no signal, risk decision, approval card or order.
 *
 *   historical-scorecard register   --created-by operator:<name>                                  register one identity per imported channel label
 *   historical-scorecard link-alias --alias <label> --canonical <label> --reason <text> --created-by operator:<name>
 *   historical-scorecard rebuild    (--source <label> | --all) --created-by operator:<name> [--as-of <ISO with offset>] [--tier-config <file.json>] [--eval-run <uuid,...>]
 *   historical-scorecard list       [--json]
 *   historical-scorecard show       --source <label> [--json]
 *   historical-scorecard export     --format json|csv [--out <file>]
 *
 * `--as-of` (default now) is part of a scorecard's identity: the same input, configuration and as-of resolve to the same run (a no-op). Output carries identifiers, tiers and numbers
 * only - never message content. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused / invalid input. The connection string is never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { exportReport, InputError, linkAlias, listSources, rebuildAll, rebuildScorecard, registerSources, resolveSource, showScorecard } from "../../packages/historical/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
  now?: () => Date;
}
const USAGE = [
  "usage:",
  "  historical-scorecard register --created-by operator:<name>",
  "  historical-scorecard link-alias --alias <label> --canonical <label> --reason <text> --created-by operator:<name>",
  "  historical-scorecard rebuild (--source <label> | --all) --created-by operator:<name> [--as-of <ISO>] [--tier-config <file.json>] [--eval-run <uuid,...>]",
  "  historical-scorecard list [--json]",
  "  historical-scorecard show --source <label> [--json]",
  "  historical-scorecard export --format json|csv [--out <file>]",
].join("\n");
const BARE = new Set(["all", "json"]);
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
const pct = (v: number | null): string => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null): string => (v === null ? "-" : v.toFixed(3));

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (!cmd || !a || !["register", "link-alias", "rebuild", "list", "show", "export"].includes(cmd)) { deps.err(USAGE); return 2; }
  let handle: { db: Db; close: () => Promise<void> } | undefined;
  try {
    const url = deps.env["DATABASE_URL"];
    if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
    handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
    const db = handle.db;
    const by = a.values.get("created-by");
    const asOfRaw = a.values.get("as-of");
    const asOf = asOfRaw === undefined ? (deps.now?.() ?? new Date()) : new Date(asOfRaw);
    if (asOfRaw !== undefined && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(asOfRaw) || Number.isNaN(asOf.getTime()))) { deps.err("--as-of must be an ISO instant with an offset"); return 2; }
    const json = a.bare.has("json");

    if (cmd === "register") {
      if (!by) { deps.err(USAGE); return 2; }
      const r = await registerSources(db, by);
      deps.out(`registered ${r.registered} new source identities (${r.total} channel labels in the archive)`);
      return 0;
    }
    if (cmd === "link-alias") {
      const alias = a.values.get("alias"), canonical = a.values.get("canonical"), reason = a.values.get("reason");
      if (!by || !alias || !canonical || !reason) { deps.err(USAGE); return 2; }
      const r = await linkAlias(db, { alias, canonical, reason, createdBy: by });
      deps.out(`${r.created ? "linked" : "already linked"}: alias ${r.linkId}`);
      return 0;
    }
    if (cmd === "rebuild") {
      const source = a.values.get("source");
      if (!by || (!source && !a.bare.has("all")) || (source && a.bare.has("all"))) { deps.err(USAGE); return 2; }
      const cfgPath = a.values.get("tier-config");
      let tierConfig: unknown;
      if (cfgPath) { try { tierConfig = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { deps.err("refused: tier_config_unreadable"); return 3; } }
      const evalRaw = a.values.get("eval-run");
      const evaluationRunIds = evalRaw ? evalRaw.split(",") : undefined;
      if (evaluationRunIds?.some((x) => !UUID.test(x))) { deps.err("--eval-run must be a comma-separated list of UUIDs"); return 2; }
      const opts = { asOf, createdBy: by, ...(tierConfig ? { tierConfig: tierConfig as never } : {}), ...(evaluationRunIds ? { evaluationRunIds } : {}) };
      let results;
      if (a.bare.has("all")) results = await rebuildAll(db, opts);
      else {
        await registerSources(db, by);
        const s = await resolveSource(db, source as string);
        if (!s) { deps.err("refused: source_not_registered"); return 3; }
        results = [await rebuildScorecard(db, s, opts)];
      }
      for (const r of results) deps.out(`${r.created ? "built" : "unchanged"} ${r.sourceLabel}: tier ${r.tier} (${r.evaluable} evaluable) run ${r.runId}`);
      deps.out(`${results.length} source(s), as of ${asOf.toISOString()}`);
      return 0;
    }
    if (cmd === "list") {
      const rows = await listSources(db);
      if (json) deps.out(JSON.stringify(rows, null, 2));
      else for (const r of rows) deps.out(`${r.tier.padEnd(7)} ${r.channelLabel}  evaluable=${r.evaluable ?? "-"} win%(entered)=${pct(r.winRateEntered)} netR=${num(r.netExpectancyR)} unverifiable=${pct(r.unverifiableRate)} conflict=${pct(r.revisionConflictRate)} maxDD=${num(r.maxDrawdownR)}`);
      if (!json && rows.length === 0) deps.out("(no sources registered)");
      return 0;
    }
    if (cmd === "show") {
      const source = a.values.get("source");
      if (!source) { deps.err(USAGE); return 2; }
      const d = await showScorecard(db, source);
      if (!d) { deps.err("refused: scorecard_not_found"); return 3; }
      if (json) { deps.out(JSON.stringify(d, null, 2)); return 0; }
      deps.out(`${d.source.channelLabel}: tier ${d.tier.tier} (${d.tier.label}) as of ${d.run.asOf}; members: ${d.source.members.join(", ")}`);
      deps.out(`rules: ${(d.tier.explanation as Array<{ rule: string; effect: string }>).map((r) => `${r.rule}->${r.effect}`).join("; ")}`);
      for (const w of d.windows) {
        const m = w.metrics as { winRateEntered: number | null; netExpectancyR: number | null; unverifiableRate: number | null; maxDrawdownR: number };
        deps.out(`  ${w.windowType.padEnd(14)} ${w.windowStart.slice(0, 10)}..${w.windowEnd.slice(0, 10)} n=${w.sampleSize} win%=${pct(m.winRateEntered)} netR=${num(m.netExpectancyR)} unverifiable=${pct(m.unverifiableRate)} maxDD=${num(m.maxDrawdownR)}`);
      }
      return 0;
    }
    // export
    const format = a.values.get("format");
    if (format !== "json" && format !== "csv") { deps.err(USAGE); return 2; }
    const text = await exportReport(db, format);
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
  enforceLiveTradingGuard("historical-scorecard");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code), () => process.exit(1));
}
