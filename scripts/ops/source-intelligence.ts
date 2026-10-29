/**
 * Operations CLI for source intelligence in the risk flow (Stage 4 / Task 5). READ-ONLY: it writes nothing, contacts no Telegram, provider or broker, and creates no risk decision,
 * approval card or order. (Intelligence is recorded on risk decisions by the worker, not from here.)
 *
 *   source-intelligence resolve --signal <live-signal-uuid> [--json]       resolve (do not record) the point-in-time intelligence for a live signal
 *   source-intelligence show    --decision <risk-decision-uuid> [--json]   the intelligence snapshot recorded on a risk decision version
 *   source-intelligence list    [--json]                                   sources with latest trust tier and confidence availability
 *   source-intelligence export  --format json|csv [--out file]             safe report: identifiers, tiers and numbers only
 *
 * Output never contains message text, the decision's input snapshot or credentials. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused. The connection string is never printed.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { listSourceIntelligence } from "../../packages/historical/src/index";
import { getLatestRiskDecisionForSignal, getRiskDecision, intelligenceOf, isIntelligenceValid, resolveIntelligenceForDecision } from "../../packages/risk/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
}
const USAGE = [
  "usage:",
  "  source-intelligence resolve --signal <uuid> [--json]",
  "  source-intelligence show --decision <uuid> [--json]",
  "  source-intelligence list [--json]",
  "  source-intelligence export --format json|csv [--out file]",
].join("\n");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(args: string[]): { values: Map<string, string>; json: boolean } | null {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) return null;
    if (a === "--json") { json = true; continue; }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    values.set(a.slice(2), v);
    i++;
  }
  return { values, json };
}
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLS = ["label", "tier", "tierLabel", "scorecardAsOf", "evaluable", "confidenceAvailable"] as const;

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (!cmd || !a || !["resolve", "show", "list", "export"].includes(cmd)) { deps.err(USAGE); return 2; }
  let handle: { db: Db; close: () => Promise<void> } | undefined;
  try {
    const url = deps.env["DATABASE_URL"];
    if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
    const signalId = a.values.get("signal"), decisionId = a.values.get("decision"), format = a.values.get("format");
    if (cmd === "resolve" && (!signalId || !UUID.test(signalId))) { deps.err(USAGE); return 2; }
    if (cmd === "show" && (!decisionId || !UUID.test(decisionId))) { deps.err(USAGE); return 2; }
    if (cmd === "export" && format !== "json" && format !== "csv") { deps.err(USAGE); return 2; }
    handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
    const db = handle.db;

    if (cmd === "resolve") {
      const d = await getLatestRiskDecisionForSignal(db, signalId as string);
      if (!d) { deps.err("refused: no_risk_decision"); return 3; }
      const i = await resolveIntelligenceForDecision(db, d.id);
      if (a.json) { deps.out(JSON.stringify(i, null, 2)); return 0; }
      deps.out(`signal ${signalId}: intelligence ${i.status} (${i.reasonCode}) as of ${i.asOf}`);
      deps.out(`  source: ${i.sourceIdentity.registered ? "registered" : "not registered"}; trust ${i.trust.tier} (${i.trust.reason}), scorecard ${i.trust.scorecardRunId ?? "-"}`);
      deps.out(`  confidence ${i.confidence.tier} score ${i.confidence.score} (${i.confidence.evidenceQuality}, n=${i.confidence.sampleSize}); data sufficiency ${i.dataSufficiency}`);
      return 0;
    }
    if (cmd === "show") {
      const d = await getRiskDecision(db, decisionId as string);
      if (!d) { deps.err("refused: not_found"); return 3; }
      const i = intelligenceOf(d);
      if (!i) { deps.err("refused: no_intelligence_recorded"); return 3; }
      if (a.json) { deps.out(JSON.stringify({ decisionId: d.id, decisionVersion: d.decisionVersion, current: d.supersededById === null, valid: isIntelligenceValid(i), intelligence: i }, null, 2)); return 0; }
      deps.out(`decision ${d.id} v${d.decisionVersion}${d.supersededById ? " (superseded)" : ""}: intelligence ${i.status} (${i.reasonCode}), valid=${isIntelligenceValid(i)}`);
      deps.out(`  trust ${i.trust.tier} (sizing ${i.sizingTrustTier}) scorecard ${i.trust.scorecardRunId ?? "-"}; confidence ${i.confidence.tier} ${i.confidence.score} pattern run ${i.confidence.patternRunId ?? "-"}; as of ${i.asOf}`);
      deps.out(`  rules: ${i.explanation.map((x) => x.rule).join(", ")}`);
      return 0;
    }
    const rows = await listSourceIntelligence(db);
    if (cmd === "list") {
      if (a.json) deps.out(JSON.stringify(rows, null, 2));
      else for (const r of rows) deps.out(`${r.tier.padEnd(7)} ${r.label}  evaluable=${r.evaluable ?? "-"} confidence-available=${r.confidenceAvailable}`);
      if (!a.json && rows.length === 0) deps.out("(no sources registered)");
      return 0;
    }
    const safe = rows.map((r) => Object.fromEntries(COLS.map((c) => [c, r[c]])));
    const text = format === "json" ? JSON.stringify(safe, null, 2) : [COLS.join(","), ...safe.map((r) => COLS.map((c) => csvCell(r[c])).join(","))].join("\n");
    const outPath = a.values.get("out");
    if (outPath) { writeFileSync(outPath, text + "\n", { flag: "wx" }); deps.out(`wrote ${outPath}`); } else deps.out(text);
    return 0;
  } catch (error) {
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`); // never the message: a driver error can embed row values
    return 1;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("source-intelligence");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code), () => process.exit(1));
}
