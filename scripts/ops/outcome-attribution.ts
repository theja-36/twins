/**
 * Read-only outcome attribution report (P0 #5) over already-evaluated historical outcome labels. Stratified tables (source, market, side, session, weekday, data quality), each with its
 * sample size and a THIN flag. It writes nothing, contacts no provider or broker and changes no weight, tier or decision.
 *
 *   outcome-attribution [--min-sample <n>] [--dimension <name>[,<name>...]] [--json]
 *
 * Exit codes: 0 ok, 1 failure, 2 usage. The connection string is never printed.
 */
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { attributionReport, DIMENSIONS, type AttributionReport, type Dimension } from "../../packages/historical/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
}
const USAGE = `usage: outcome-attribution [--min-sample <n>] [--dimension <${DIMENSIONS.join("|")}>[,...]] [--json]`;
const pct = (v: number | null): string => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null): string => (v === null ? "-" : v.toFixed(3));

export function renderText(r: AttributionReport): string[] {
  const lines = [
    `${r.version}: ${r.totalRows} signals, ${r.overall.evaluable} evaluable, ${r.notEvaluated} not evaluated; min sample ${r.minSample}`,
    `overall: win%(entered)=${pct(r.overall.winRateEntered)} expectancyR=${num(r.overall.expectancyR)} totalR=${num(r.overall.totalR)}${r.overall.thin ? "  [THIN]" : ""}`,
  ];
  let dim = "";
  for (const s of r.strata) {
    if (s.dimension !== dim) { dim = s.dimension; lines.push(`-- ${dim}`); }
    const flag = s.reading === "THIN" ? "THIN" : s.differsFromOverall ? "DIFFERS" : "ok";
    lines.push(`  ${s.value.padEnd(18)} n=${String(s.evaluable).padStart(4)} win%=${pct(s.winRateEntered).padStart(6)} [${pct(s.winRateLow)}..${pct(s.winRateHigh)}] expR=${num(s.expectancyR)} dR=${num(s.deltaExpectancyR)} ${flag}`);
  }
  lines.push("-- not attributable yet", ...r.unavailable.map((u) => `  ${u.factor}: ${u.reason}`), ...r.statements.map((s) => `* ${s}`));
  return lines;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let minSample: number | undefined;
  let dimensions: Dimension[] | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") json = true;
    else if (a === "--min-sample") { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1) { deps.err(USAGE); return 2; } minSample = n; }
    else if (a === "--dimension") {
      const v = (argv[++i] ?? "").split(",");
      if (v.some((x) => !(DIMENSIONS as readonly string[]).includes(x))) { deps.err(USAGE); return 2; }
      dimensions = v as Dimension[];
    } else { deps.err(USAGE); return 2; }
  }
  const url = deps.env["DATABASE_URL"];
  if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
  const handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
  try {
    const report = await attributionReport(handle.db, { ...(minSample ? { minSample } : {}), ...(dimensions ? { dimensions } : {}) });
    if (json) deps.out(JSON.stringify(report, null, 2));
    else for (const l of renderText(report)) deps.out(l);
    return 0;
  } catch (error) {
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`);
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("outcome-attribution");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code), () => process.exit(1));
}
