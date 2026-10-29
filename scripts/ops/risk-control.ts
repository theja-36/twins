/**
 * Operations CLI for risk-decision expiry and the loss circuit breakers (Stage 3 / Task 4).
 *
 *   risk-control expiry list    [--as-of <ISO>] [--limit N]
 *   risk-control expiry run     [--dry-run] [--as-of <ISO>] [--limit N]
 *   risk-control breakers status   [--capital N] [--as-of <ISO>]
 *   risk-control breakers evaluate [--capital N] [--as-of <ISO>]
 *   risk-control breakers record-loss --amount N --source-ref <ref> --created-by operator:<name> [--source manual_adjustment|synthetic] [--occurred-at <ISO>]
 *
 * Expiry only APPENDS EXPIRED versions (never updates) and is allowed under the kill switch (it removes exposure). Breaker `status` is read-only. Nothing here
 * can reset a circuit breaker early or touch the kill switch: breakers reset only at their period rollover. `record-loss` appends an auditable loss event
 * (synthetic events are refused when APP_ENV=production). Capital defaults to TWINS_SIZING_AVAILABLE_CAPITAL. The shared live-trading guard runs first.
 * Exit codes: 0 ok, 1 failure, 2 usage error, 3 refused/invalid input. The connection string is never printed.
 */
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import {
  evaluateCircuitBreakers, expireStaleRiskDecisions, getCircuitBreakerStatus, listStaleRiskDecisions, loadBreakerConfig, loadExpiryConfig, loadSizingConfig, recordLossEvent, RiskDecisionError, type LossSource,
} from "../../packages/risk/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Tests inject a database handle; the real entry point opens one from DATABASE_URL. */
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
}

const USAGE = [
  "usage:",
  "  risk-control expiry list|run [--dry-run] [--as-of <ISO>] [--limit N]",
  "  risk-control breakers status|evaluate [--capital N] [--as-of <ISO>]",
  "  risk-control breakers record-loss --amount N --source-ref <ref> --created-by operator:<name> [--source manual_adjustment|synthetic] [--occurred-at <ISO>]",
].join("\n");

function flags(args: string[]): { values: Map<string, string>; bare: Set<string> } | null {
  const values = new Map<string, string>(), bare = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) return null;
    if (a === "--dry-run") { bare.add("dry-run"); continue; }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    values.set(a.slice(2), v);
    i++;
  }
  return { values, bare };
}
const date = (v: string | undefined): Date | undefined | "invalid" => { if (v === undefined) return undefined; const d = new Date(v); return Number.isNaN(d.getTime()) ? "invalid" : d; };
const json = (o: unknown): string => JSON.stringify(o, null, 2);

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [group, cmd, ...rest] = argv;
  const f = flags(rest);
  if (!group || !cmd || !f) { deps.err(USAGE); return 2; }
  const url = deps.env["DATABASE_URL"];
  if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
  const asOf = date(f.values.get("as-of"));
  if (asOf === "invalid") { deps.err("--as-of must be an ISO date-time"); return 2; }
  const limit = f.values.get("limit") === undefined ? undefined : Number(f.values.get("limit"));
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) { deps.err("--limit must be a positive whole number"); return 2; }
  const handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
  try {
    const capitalArg = f.values.get("capital");
    const capital = capitalArg !== undefined ? Number(capitalArg) : loadSizingConfig(deps.env).availableCapital;
    const common = { ...(asOf ? { asOf } : {}) };
    if (group === "expiry" && (cmd === "list" || cmd === "run")) {
      const config = loadExpiryConfig(deps.env);
      if (cmd === "list") {
        const stale = await listStaleRiskDecisions(handle.db, { config, ...common, ...(limit ? { limit } : {}) });
        deps.out(json({ validityMinutes: { PENDING: config.pendingMinutes, APPROVED_FOR_REVIEW: config.approvedForReviewMinutes }, stale: stale.map((s) => ({ id: s.id, status: s.status, version: s.decisionVersion, symbol: s.symbol, ageSeconds: s.ageSeconds, expiresAt: s.expiresAt.toISOString() })) }));
        return 0;
      }
      const run = await expireStaleRiskDecisions(handle.db, { config, ...common, ...(limit ? { limit } : {}), dryRun: f.bare.has("dry-run") });
      deps.out(json({ asOf: run.asOf.toISOString(), dryRun: run.dryRun, examined: run.examined, expired: run.expired, alreadyExpired: run.alreadyExpired, skipped: run.skipped }));
      return 0;
    }
    if (group === "breakers" && (cmd === "status" || cmd === "evaluate")) {
      if (capital === null || !Number.isFinite(capital) || !(capital > 0)) { deps.err("a positive --capital (or TWINS_SIZING_AVAILABLE_CAPITAL) is required"); return 2; }
      const breakers = loadBreakerConfig(deps.env);
      const r = cmd === "status" ? { status: await getCircuitBreakerStatus(handle.db, { capital, breakers, ...common }), events: [] } : await evaluateCircuitBreakers(handle.db, { capital, breakers, ...common });
      deps.out(json({ blocked: r.status.blocked, blockedBy: r.status.blockedBy, scopes: r.status.scopes, createdEvents: r.events.filter((e) => e.created).map((e) => ({ scope: e.scope, type: e.eventType })) }));
      return 0;
    }
    if (group === "breakers" && cmd === "record-loss") {
      const amount = Number(f.values.get("amount")), ref = f.values.get("source-ref"), by = f.values.get("created-by");
      const source = (f.values.get("source") ?? "manual_adjustment") as LossSource;
      const occurred = date(f.values.get("occurred-at"));
      if (!ref || !by || !Number.isFinite(amount) || occurred === "invalid") { deps.err(USAGE); return 2; }
      const r = await recordLossEvent(handle.db, { amount, occurredAt: occurred ?? new Date(), source, sourceRef: ref, createdBy: by }, deps.env);
      deps.out(json(r));
      return 0;
    }
    deps.err(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof RiskDecisionError) { deps.err(`refused: ${error.code}: ${error.message}`); return error.code === "store_failure" ? 1 : 3; }
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`);
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("risk-control");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code), () => process.exit(1));
}
