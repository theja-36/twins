/**
 * Operations CLI for risk-decision expiry and the loss circuit breakers (Stage 3 / Task 4).
 *
 *   risk-control expiry list    [--as-of <ISO>] [--limit N]
 *   risk-control expiry run     [--dry-run] [--as-of <ISO>] [--limit N]
 *   risk-control breakers status   [--capital N] [--as-of <ISO>]
 *   risk-control breakers evaluate [--capital N] [--as-of <ISO>]
 *   risk-control blackout add --market <CODE|ALL> --scope MARKET|SYMBOL [--symbol S] --severity WARNING|CRITICAL --starts <ISO> --ends <ISO> --reason-code <code> --created-by operator:<name> [--reason <text>]
 *   risk-control blackout cancel --id <uuid> --created-by operator:<name> [--reason <text>]
 *   risk-control blackout list [--at <ISO>] [--include-cancelled]
 *   risk-control breakers record-loss --amount N --source-ref <ref> --created-by operator:<name> [--source manual_adjustment|synthetic] [--occurred-at <ISO>]
 *   risk-control controls list [--user <uuid>] [--scope USER|MARKET|SOURCE|STRATEGY] [--active-only] [--limit N]
 *   risk-control controls set|clear --scope <S> [--scope-key <K>] [--user <uuid>] --kind <RESTRICTION|DAILY_LOSS_HALT|DRAWDOWN_HALT|KILL_SWITCH> --reason "<10-300 chars>" --changed-by operator:<name> [--expires <ISO>] [--expected-event <uuid|none>] [--apply] [--confirm <token>]
 *
 * `controls` is the OWNER path for risk_control_events (migration 0047): the runtime role can no longer write platform controls, CLEAR events or OWNER-labelled events. It needs the owner database credential AND a login role on the allowlist
 * (twins_control_privileged_roles); the runtime role is refused (exit 5). set / clear are a DRY RUN unless --apply is given; --apply needs --expected-event (the latest event id shown by `controls list` / the dry run, or `none`) so a concurrent change is refused (exit 4).
 * Clearing a KILL_SWITCH, a DRAWDOWN_HALT or any platform-scope control needs --confirm with the exact token the dry run prints. Every applied change writes the control event AND an audit_events row (the hash-chained audit trail) in one transaction.
 * `--changed-by operator:<name>` is a SELF-DECLARED identity, not authenticated. USER-scope controls are keyed by the user id (as the planning cycle writes them). Extra exit codes: 4 concurrent change, 5 not authorised.
 *
 * Expiry only APPENDS EXPIRED versions (never updates) and is allowed under the kill switch (it removes exposure). Breaker `status` is read-only. Nothing here
 * can reset a circuit breaker early or touch the kill switch: breakers reset only at their period rollover. `record-loss` appends an auditable loss event
 * (synthetic events are refused when APP_ENV=production). Capital defaults to TWINS_SIZING_AVAILABLE_CAPITAL. The shared live-trading guard runs first.
 * Exit codes: 0 ok, 1 failure, 2 usage error, 3 refused/invalid input. The connection string is never printed.
 */
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { isPrivilegedControlRole, latestControlEventId, listControlEvents, ownerChangeControl, OwnerControlError, type ControlRef } from "../../packages/database/src/index";
import {
  addEventWindow, cancelEventWindow, evaluateCircuitBreakers, expireStaleRiskDecisions, listEventWindows, getCircuitBreakerStatus, listStaleRiskDecisions, loadBreakerConfig, loadExpiryConfig, loadSizingConfig, recordLossEvent, RiskDecisionError, type LossSource,
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
  "  risk-control blackout add|cancel|list (see the header of scripts/ops/risk-control.ts)",
  "  risk-control breakers record-loss --amount N --source-ref <ref> --created-by operator:<name> [--source manual_adjustment|synthetic] [--occurred-at <ISO>]",
  "  risk-control controls list|set|clear (owner path for risk controls; see the header of scripts/ops/risk-control.ts)",
].join("\n");

function flags(args: string[]): { values: Map<string, string>; bare: Set<string> } | null {
  const values = new Map<string, string>(), bare = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) return null;
    if (a === "--dry-run" || a === "--include-cancelled" || a === "--apply" || a === "--active-only") { bare.add(a.slice(2)); continue; }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    values.set(a.slice(2), v);
    i++;
  }
  return { values, bare };
}
const date = (v: string | undefined): Date | undefined | "invalid" => { if (v === undefined) return undefined; const d = new Date(v); return Number.isNaN(d.getTime()) ? "invalid" : d; };
const json = (o: unknown): string => JSON.stringify(o, null, 2);

const CONTROL_SCOPES = ["USER", "MARKET", "SOURCE", "STRATEGY"] as const, CONTROL_KINDS = ["RESTRICTION", "DAILY_LOSS_HALT", "DRAWDOWN_HALT", "KILL_SWITCH"] as const, UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `controls list|set|clear`: the owner path for risk_control_events. All branches return an exit code; nothing is written without --apply. */
async function controlsCommand(db: Db, cmd: "list" | "set" | "clear", f: { values: Map<string, string>; bare: Set<string> }, deps: CliDeps): Promise<number> {
  // authorisation: the connected login role must be on the explicit owner allowlist (the runtime role cannot even read that table: refused)
  // only a permission-denied answer means "not on the allowlist" (the runtime role cannot read it); any other failure (an outage) is a plain failure, never mistaken for an authorisation answer
  const allowed = await isPrivilegedControlRole(db).then((v) => v, (e: unknown) => { const o = e as { code?: unknown; cause?: { code?: unknown } } | null; if ((o?.code ?? o?.cause?.code) === "42501") return false; throw e; });
  if (!allowed) { deps.err("refused: NOT_AUTHORISED: this database role is not on the risk-control owner allowlist"); return 5; }
  const scope = f.values.get("scope"), user = f.values.get("user");
  if (scope !== undefined && !(CONTROL_SCOPES as readonly string[]).includes(scope)) { deps.err("--scope must be USER, MARKET, SOURCE or STRATEGY"); return 2; }
  if (user !== undefined && !UUID_RE.test(user)) { deps.err("--user must be a UUID"); return 2; }
  if (cmd === "list") {
    const limit = f.values.get("limit") === undefined ? 100 : Number(f.values.get("limit"));
    const rows = await listControlEvents(db, { ...(user ? { userId: user } : {}), ...(scope ? { scope: scope as ControlRef["scope"] } : {}), activeOnly: f.bare.has("active-only"), limit: Number.isInteger(limit) && limit > 0 ? limit : 100 });
    deps.out(json({ activeOnly: f.bare.has("active-only"), events: rows }));
    return 0;
  }
  const kind = f.values.get("kind"), reason = f.values.get("reason"), by = f.values.get("changed-by"), scopeKeyArg = f.values.get("scope-key"), expires = date(f.values.get("expires"));
  if (!scope || !kind || !reason || !by || !(CONTROL_KINDS as readonly string[]).includes(kind) || expires === "invalid") { deps.err(USAGE); return 2; }
  if (scope === "USER" && !user) { deps.err("--user is required for a USER-scope control"); return 2; }
  if (scope !== "USER" && user) { deps.err("--user is only for a USER-scope control"); return 2; }
  if (scope === "USER" && scopeKeyArg !== undefined && scopeKeyArg !== user) { deps.err("a USER control is keyed by the user id; omit --scope-key"); return 2; }
  const ref: ControlRef = { scope: scope as ControlRef["scope"], scopeKey: scope === "USER" ? (user as string) : (scopeKeyArg ?? null), kind: kind as ControlRef["kind"], userId: scope === "USER" ? (user as string) : null };
  if (scope !== "USER" && !ref.scopeKey) { deps.err("--scope-key is required for a platform control"); return 2; }
  const action = cmd === "set" ? "SET" : "CLEAR", latest = await latestControlEventId(db, ref);
  const dangerous = action === "CLEAR" && (kind === "KILL_SWITCH" || kind === "DRAWDOWN_HALT" || scope !== "USER");
  const token = `CLEAR:${ref.scope}:${ref.scopeKey ?? "-"}:${ref.kind}:${ref.userId ?? "platform"}`;
  if (!f.bare.has("apply")) {
    deps.out(json({ dryRun: true, wouldWrite: { action, ...ref, reason, expiresAt: expires ? expires.toISOString() : null, changedBy: by }, latestEventId: latest, useExpectedEvent: latest ?? "none", ...(dangerous ? { confirmToken: token } : {}), note: "nothing was written; add --apply (and --expected-event, and --confirm for a dangerous clear) to write" }));
    return 0;
  }
  const expected = f.values.get("expected-event");
  if (expected === undefined || (expected !== "none" && !UUID_RE.test(expected))) { deps.err("--expected-event <uuid|none> is required with --apply"); return 2; }
  if (dangerous && f.values.get("confirm") !== token) { deps.err(`refused: CONFIRMATION_REQUIRED: this clear needs --confirm ${token}`); return 3; }
  const r = await ownerChangeControl(db, ref, action, { reason, operator: by, ...(expires ? { expiresAt: expires } : {}), expectedLatest: expected });
  deps.out(json({ applied: true, action, ...ref, eventId: r.eventId, auditId: r.auditId, previousEventId: r.previous }));
  return 0;
}

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
    if (group === "blackout" && (cmd === "add" || cmd === "cancel" || cmd === "list")) {
      const by = f.values.get("created-by");
      if (cmd === "list") {
        const at = date(f.values.get("at"));
        if (at === "invalid") { deps.err("--at must be an ISO date-time"); return 2; }
        const rows = await listEventWindows(handle.db, { ...(at ? { at } : {}), includeCancelled: f.bare.has("include-cancelled") });
        deps.out(json(rows.map((w) => ({ id: w.id, market: w.market, scope: w.scope, scopeValue: w.scopeValue, severity: w.severity, startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString(), reasonCode: w.reasonCode, cancelled: w.cancelled }))));
        return 0;
      }
      if (!by) { deps.err(USAGE); return 2; }
      if (cmd === "cancel") {
        const id = f.values.get("id");
        if (!id) { deps.err(USAGE); return 2; }
        deps.out(json(await cancelEventWindow(handle.db, id, { createdBy: by, ...(f.values.get("reason") ? { reason: f.values.get("reason") as string } : {}) })));
        return 0;
      }
      const starts = date(f.values.get("starts")), ends = date(f.values.get("ends"));
      const market = f.values.get("market"), scope = f.values.get("scope"), severity = f.values.get("severity"), reasonCode = f.values.get("reason-code");
      if (!market || !scope || !severity || !reasonCode || !starts || !ends || starts === "invalid" || ends === "invalid") { deps.err(USAGE); return 2; }
      deps.out(json(await addEventWindow(handle.db, { market, scope: scope as "MARKET" | "SYMBOL", scopeValue: f.values.get("symbol") ?? null, severity: severity as "WARNING" | "CRITICAL", startsAt: starts, endsAt: ends, reasonCode, reason: f.values.get("reason") ?? null, createdBy: by })));
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
    if (group === "controls" && (cmd === "list" || cmd === "set" || cmd === "clear")) return await controlsCommand(handle.db, cmd, f, deps);
    deps.err(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof OwnerControlError) { deps.err(`refused: ${error.code}: ${error.message}`); return error.code === "CONCURRENT_CHANGE" ? 4 : 3; }
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
