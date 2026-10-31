/**
 * Owner-run control for the database's view of the agent engine (P0 hardening / HB-03). The ONLY supported way to change `agent_engine_state`. No HTTP endpoint.
 *
 *   agent-engine-control status
 *   agent-engine-control set --value <true|false> --reason "<why, 8-500 chars>" --changed-by operator:<name> [--expected-version N]
 *
 * Same boundary as safety-control: the caller holds the owner database credential (DATABASE_URL); the runtime role has SELECT only. Setting `true` does NOT enable the engine: the worker still needs
 * TWINS_AGENT_ENGINE_ENABLED=true, and the start-up probe refuses an environment that enables the engine while this flag is false. Setting `true` makes the approval function refuse an approval that has no
 * research assessment. The shared live-trading guard runs first. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused. The connection string is never printed.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";

export interface CliDeps { env: Record<string, string | undefined>; out: (l: string) => void; err: (l: string) => void; openPool?: (url: string) => { pool: pg.Pool; close: () => Promise<void> } }
const USAGE = "usage:\n  agent-engine-control status\n  agent-engine-control set --value <true|false> --reason <text> --changed-by operator:<name> [--expected-version N]";

function flags(argv: string[], allowed: string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const f = argv[i] ?? "";
    if (!f.startsWith("--") || !allowed.includes(f.slice(2))) return `unknown or malformed argument ${JSON.stringify(f.slice(0, 30))}`;
    const v = argv[i + 1];
    if (v === undefined) return `${f} needs a value`;
    if (f.slice(2) in out) return `${f} given twice`;
    out[f.slice(2)] = v;
  }
  return out;
}
const defaultOpen: NonNullable<CliDeps["openPool"]> = (url) => {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10_000, application_name: "twins-agent-engine-control" });
  pool.on("error", () => undefined);
  return { pool, close: () => pool.end() };
};

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "status" && cmd !== "set") { deps.err(USAGE); return 2; }
  const url = deps.env["DATABASE_URL"];
  if (!url) { deps.err("DATABASE_URL is not set"); return 2; }
  const f = flags(rest, cmd === "set" ? ["value", "reason", "changed-by", "expected-version"] : []);
  if (typeof f === "string") { deps.err(f); deps.err(USAGE); return 2; }
  if (cmd === "set") {
    if (f["value"] !== "true" && f["value"] !== "false") { deps.err("--value must be true or false"); return 2; }
    if (!f["reason"] || f["reason"].trim().length < 8 || f["reason"].length > 500) { deps.err("--reason must be 8-500 characters"); return 2; }
    if (!f["changed-by"] || !/^operator:[A-Za-z0-9._-]{1,50}$/.test(f["changed-by"])) { deps.err("--changed-by must be operator:<name>"); return 2; }
    if (f["expected-version"] !== undefined && !/^[0-9]{1,12}$/.test(f["expected-version"])) { deps.err("--expected-version must be an integer"); return 2; }
  }
  const { pool, close } = (deps.openPool ?? defaultOpen)(url);
  try {
    const cur = (await pool.query("select enabled, version, changed_by, changed_at from agent_engine_state where id = 1")).rows[0] as { enabled: boolean; version: string; changed_by: string; changed_at: Date } | undefined;
    if (!cur) { deps.err("agent_engine_state is empty: migration 0028 has not been applied"); return 1; }
    if (cmd === "status") { deps.out(JSON.stringify({ enabled: cur.enabled, version: Number(cur.version), changedBy: cur.changed_by, changedAt: new Date(cur.changed_at).toISOString() })); return 0; }
    const value = f["value"] === "true";
    if (cur.enabled === value) { deps.out(JSON.stringify({ unchanged: true, enabled: cur.enabled, version: Number(cur.version) })); return 0; }
    const expected = f["expected-version"] !== undefined ? Number(f["expected-version"]) : Number(cur.version);
    if (expected !== Number(cur.version)) { deps.err("the state changed since it was read (stale --expected-version)"); return 3; }
    const r = await pool.query("update agent_engine_state set enabled = $1, version = version + 1, reason = $2, changed_by = $3 where id = 1 and version = $4 returning enabled, version", [value, f["reason"], f["changed-by"], expected]);
    if (r.rowCount !== 1) { deps.err("the change was refused (concurrent update)"); return 3; }
    deps.out(JSON.stringify({ changed: true, enabled: value, version: Number((r.rows[0] as { version: string }).version) }));
    return 0;
  } catch (e) {
    deps.err(`failed: ${(e as { code?: string }).code ?? "error"}`);
    return 1;
  } finally { await close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  enforceLiveTradingGuard("agent-engine-control");
  void runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c));
}
