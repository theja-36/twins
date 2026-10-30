/**
 * Operations CLI for the agent engine's provider snapshot files (Stage 5 / Task 9). It reads and writes local files only: no network, no database, no broker, no scheduler, nothing deployed, and no
 * order, fill, position or approval card is created. Snapshots are exported elsewhere (a reviewed exporter or an operator); this tool only lists, validates and installs them.
 *
 *   agent-snapshots list     [--dir <path>] [--json]                                  every known snapshot: status, age, coverage, whether the provider setting reads it
 *   agent-snapshots validate [--dir <path>] [--json]                                  the same assessment as a verdict under the configured strictness (exit 0 ok, 1 not ok)
 *   agent-snapshots write    --kind <kind> --file <path> [--dir <path>] [--overwrite --confirm <kind>]
 *                                                                                      validates with the agent's strict parser, then writes atomically; replacing an existing snapshot needs
 *                                                                                      --overwrite AND --confirm naming the kind (the previous version is kept in .previous/)
 *
 * Configuration: TWINS_AGENT_SNAPSHOT_DIR / _REQUIRED / _STRICTNESS / _FRESHNESS_HOURS (see docs/twins/AGENT_ENGINE.md). Output never contains snapshot contents beyond counts and short key lists.
 * Exit codes: 0 ok, 1 failure or not ok, 2 usage, 3 refused (would overwrite without confirmation).
 */
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { listSnapshots, loadAgentRulesConfig, loadSnapshotConfig, SNAPSHOT_KINDS, SnapshotError, writeSnapshot, MAX_SNAPSHOT_BYTES, type SnapshotValidation } from "../../packages/agents/src/index";

export interface CliDeps { env: Record<string, string | undefined>; out: (line: string) => void; err: (line: string) => void; now?: () => Date }
const USAGE = [
  "usage:",
  "  agent-snapshots list [--dir <path>] [--json]",
  "  agent-snapshots validate [--dir <path>] [--json]",
  `  agent-snapshots write --kind <${SNAPSHOT_KINDS.join("|")}> --file <path> [--dir <path>] [--overwrite --confirm <kind>]`,
].join("\n");

function parseArgs(args: string[]): { values: Map<string, string>; flags: Set<string> } | null {
  const values = new Map<string, string>(), flags = new Set<string>();
  const valued = new Set(["--dir", "--kind", "--file", "--confirm"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--json" || a === "--overwrite") { flags.add(a); continue; }
    if (!valued.has(a)) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    values.set(a, v); i += 1;
  }
  return { values, flags };
}
const fmtAge = (h: number | null): string => (h === null ? "-" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h / 24)}d`);
function render(v: SnapshotValidation, out: (l: string) => void): void {
  out(`snapshot directory: ${v.dir}${v.dirExists ? "" : " (missing)"}   strictness: ${v.strictness}   result: ${v.ok ? "OK" : "NOT OK"}`);
  for (const r of v.reports) {
    out(`${r.status.padEnd(9)} ${r.kind.padEnd(21)} ${r.required ? "required" : "optional"}  age ${fmtAge(r.ageHours).padStart(5)} (warn ${fmtAge(r.warnHours)}, max ${fmtAge(r.maxHours)})  entries ${r.coverage?.entries ?? "-"}  ${r.code}${r.servesFromDirectory === false && r.status !== "MISSING" ? "  [provider setting does not read this file]" : ""}`);
  }
  if (v.missingRequired.length) out(`missing required: ${v.missingRequired.join(", ")}`);
  if (v.malformed.length) out(`malformed: ${v.malformed.join(", ")}`);
  if (v.unsafe.length) out(`unsafe: ${v.unsafe.join(", ")}`);
  if (v.expired.length) out(`expired: ${v.expired.join(", ")}`);
  if (v.stale.length) out(`stale: ${v.stale.join(", ")}`);
  if (v.notServed.length) out(`required but not read by the provider setting: ${v.notServed.join(", ")}`);
  if (v.unexpectedFiles.length) out(`unexpected files: ${v.unexpectedFiles.join(", ")}`);
  if (v.leftoverTemp.length) out(`leftover temporary files (an interrupted write): ${v.leftoverTemp.join(", ")}`);
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (!cmd || !a || !["list", "validate", "write"].includes(cmd)) { deps.err(USAGE); return 2; }
  let cfg;
  try { cfg = loadSnapshotConfig(deps.env); } catch (e) { deps.err(`invalid configuration: ${(e as { code?: string }).code ?? "INVALID_SNAPSHOT_CONFIG"}`); return 1; }
  const dir = a.values.get("--dir");
  if (dir !== undefined) cfg = { ...cfg, dir };
  const now = (deps.now ?? (() => new Date()))();
  if (cmd === "write") {
    const kind = a.values.get("--kind"), file = a.values.get("--file");
    if (!kind || !file) { deps.err(USAGE); return 2; }
    if (a.flags.has("--overwrite") !== a.values.has("--confirm")) { deps.err("replacing a snapshot needs both --overwrite and --confirm <kind>"); return 2; }
    let text: string;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size === 0 || st.size > MAX_SNAPSHOT_BYTES) { deps.err("the input is not a regular, non-empty file within the size limit"); return 1; }
      text = readFileSync(file, "utf8");
    } catch { deps.err("the input file cannot be read"); return 1; }
    try {
      const w = writeSnapshot(cfg, kind, text, { ...(a.values.has("--confirm") ? { confirmOverwrite: a.values.get("--confirm") as string } : {}), now });
      deps.out(a.flags.has("--json") ? JSON.stringify(w) : `wrote ${w.file} (${w.bytes} bytes, sha256 ${w.sha256.slice(0, 16)}..., as_of ${w.asOf})${w.replaced ? "; the previous version is kept in .previous/" : ""}`);
      return 0;
    } catch (e) {
      if (e instanceof SnapshotError) { deps.err(`refused: ${e.code}: ${e.message}`); return e.code === "SNAPSHOT_EXISTS" ? 3 : 1; }
      deps.err("the snapshot could not be written"); return 1;
    }
  }
  let rules;
  try { rules = loadAgentRulesConfig(deps.env); } catch { rules = undefined; }
  const v = listSnapshots(cfg, now, rules);
  if (a.flags.has("--json")) deps.out(JSON.stringify(v, null, 2)); else render(v, deps.out);
  return cmd === "validate" && !v.ok ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c), () => process.exit(1));
}
