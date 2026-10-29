/**
 * Audit-chain integrity verifier (Stage 1 / Task 3). Read-only. Usable from CI and as a scheduled check.
 *
 *   npm run audit:verify -- [--json] [--chain <name>]... [--anchor-file <path>] [--require-ddl-watch] [--status-file <path>] [--batch-size N]
 *
 * Verifies, for audit_events, system_control_events, signal_validations, telegram_messages and options_claims: that the append-only/chain
 * triggers exist and are ENABLE ALWAYS; that chain_index runs 1..N without gaps or reordering; that every previous_hash equals the previous
 * row's event_hash; that payload_hash matches the row's CURRENT content; that event_hash matches (chain, index, previous_hash, payload_hash);
 * and that audit_chain_heads agrees with the table (so deleting the newest rows is caught). With --anchor-file it also compares against an
 * external record of earlier verified heads (kept outside the database) and rewrites it after a passing run.
 *
 * Exit codes: 0 PASS, 1 FAIL (integrity problem; the first failure is printed), 2 usage / configuration error, 3 could not run the check.
 * The connection string and driver messages are never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { alerterFromEnv, type Alerter } from "../../packages/alerting/src/index";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { CHAIN_SPECS, formatReport, verifyAuditChains, verifyAuditChainsWithPool, type AuditReport, type Connectable, type Queryable } from "../../packages/audit-chain/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";

export interface VerifyCliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Tests inject a handle (e.g. a transaction client). Default: a one-connection pool on DATABASE_URL. */
  open?: (databaseUrl: string) => { db: Queryable | (Queryable & Connectable); close: () => Promise<void>; snapshot?: boolean };
  now?: () => Date;
  /** Raises alerts (the real entry point passes one). */
  alerter?: Alerter;
}

const USAGE = "usage: verify-audit-chain [--json] [--chain <name>]... [--anchor-file <path>] [--require-ddl-watch] [--status-file <path>] [--batch-size N]";

const defaultOpen: NonNullable<VerifyCliDeps["open"]> = (url) => {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 300_000, application_name: "twins-audit-verify" });
  pool.on("error", () => undefined);
  return { db: pool, close: () => pool.end(), snapshot: true };
};

export async function main(argv: string[], deps: VerifyCliDeps): Promise<number> {
  let json = false;
  let requireDdlWatch = false;
  let anchorFile: string | undefined;
  let statusFile: string | undefined;
  let batchSize: number | undefined;
  const chains: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | undefined => argv[++i];
    if (a === "--json") json = true;
    else if (a === "--require-ddl-watch") requireDdlWatch = true;
    else if (a === "--anchor-file") anchorFile = value();
    else if (a === "--status-file") statusFile = value();
    else if (a === "--batch-size") {
      const v = value();
      if (v === undefined || !/^[1-9][0-9]{0,5}$/.test(v)) {
        deps.err(`usage error: --batch-size needs a positive integer\n${USAGE}`);
        return 2;
      }
      batchSize = Number(v);
    } else if (a === "--chain") {
      const v = value();
      if (v === undefined || !CHAIN_SPECS.some((s) => s.chain === v)) {
        deps.err(`usage error: --chain must be one of ${CHAIN_SPECS.map((s) => s.chain).join(", ")}\n${USAGE}`);
        return 2;
      }
      chains.push(v);
    } else {
      deps.err(`usage error: unknown argument ${JSON.stringify(String(a).slice(0, 30))}\n${USAGE}`);
      return 2;
    }
    if ((a === "--anchor-file" && !anchorFile) || (a === "--status-file" && !statusFile)) {
      deps.err(`usage error: ${a} needs a path\n${USAGE}`);
      return 2;
    }
  }
  const url = deps.env["DATABASE_URL"];
  if (!url) {
    deps.err("configuration error: DATABASE_URL is not set");
    return 2;
  }
  const { db, close, snapshot } = (deps.open ?? defaultOpen)(url);
  let report: AuditReport;
  try {
    const run = snapshot ? (o: Parameters<typeof verifyAuditChains>[1]) => verifyAuditChainsWithPool(db as Connectable, o) : (o: Parameters<typeof verifyAuditChains>[1]) => verifyAuditChains(db as Queryable, o);
    report = await run({
      requireDdlWatch,
      ...(anchorFile ? { anchorFile } : {}),
      ...(batchSize ? { batchSize } : {}),
      ...(chains.length > 0 ? { chains } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    deps.err(`could not run the check: ${error instanceof Error ? error.name : "error"}${typeof code === "string" && /^[A-Za-z0-9_]{1,24}$/.test(code) ? ` (${code})` : ""}`);
    deps.alerter?.alert({ event: "audit.verification_unavailable", severity: "CRITICAL", code: "could_not_run", summary: "The audit-chain verification could not run (database unreachable or error).", dedupeKey: "audit-unavailable" });
    await deps.alerter?.flush();
    return 3;
  } finally {
    await close().catch(() => undefined);
  }
  deps.out(json ? JSON.stringify(report) : formatReport(report));
  if (statusFile) {
    const when = (deps.now ?? (() => new Date()))();
    // last_ok_epoch survives a failing run, so monitoring can still report when verification last PASSED.
    let previousOk: number | null = null;
    try { const prev = JSON.parse(readFileSync(statusFile, "utf8")) as { last_ok_epoch?: unknown }; if (typeof prev.last_ok_epoch === "number") previousOk = prev.last_ok_epoch; } catch { /* first run */ }
    const epoch = Math.floor(when.getTime() / 1000);
    writeFileSync(statusFile, `${JSON.stringify({ ok: report.ok, ts: when.toISOString(), epoch, last_ok_epoch: report.ok ? epoch : previousOk, first_failure: report.firstFailure?.code ?? null, chains: report.chains.map((c) => ({ chain: c.chain, rows: c.rows, head: c.lastIndex })) })}\n`, { mode: 0o600 });
  }
  if (!report.ok) {
    const code = String(report.firstFailure?.code ?? "unknown");
    // a missing/disabled protection trigger or DDL watch is a different (and worse) event than a broken chain
    const protection = code === "protection_missing" || code === "ddl_watch_missing";
    deps.alerter?.alert({ event: protection ? "audit.protection_failed" : "audit.verification_failed", severity: "CRITICAL", code: /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : "verification_failed", summary: protection ? "Audit protection (triggers, chain heads or DDL watch) failed verification." : "Audit-chain verification failed: a chain is broken or was altered.", details: { firstFailure: code }, dedupeKey: "audit" });
    await deps.alerter?.flush();
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  enforceLiveTradingGuard("verify-audit-chain");
  let alerter: Alerter | undefined;
  try { alerter = alerterFromEnv(process.env, "audit-verify"); } catch { console.error("alert configuration invalid; alerts disabled for this run"); }
  void main(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l), ...(alerter ? { alerter } : {}) }).then((code) => process.exit(code));
}
