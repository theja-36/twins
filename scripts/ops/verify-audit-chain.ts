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
import { writeFileSync } from "node:fs";
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
    return 3;
  } finally {
    await close().catch(() => undefined);
  }
  deps.out(json ? JSON.stringify(report) : formatReport(report));
  if (statusFile) {
    const when = (deps.now ?? (() => new Date()))();
    writeFileSync(statusFile, `${JSON.stringify({ ok: report.ok, ts: when.toISOString(), epoch: Math.floor(when.getTime() / 1000), first_failure: report.firstFailure?.code ?? null, chains: report.chains.map((c) => ({ chain: c.chain, rows: c.rows, head: c.lastIndex })) })}\n`, { mode: 0o600 });
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  enforceLiveTradingGuard("verify-audit-chain");
  void main(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code));
}
