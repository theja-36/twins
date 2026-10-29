import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { databaseNow, freshCondition } from "../expiry/record";
import { loadExpiryConfig, type ExpiryConfig } from "../expiry/config";
import { RiskDecisionError } from "../riskDecisions";
import { loadBreakerConfig, type BreakerConfig } from "./config";
import { periodFor, type BreakerScope, type Period } from "./periods";

/**
 * Daily / weekly loss circuit breakers (Stage 3 / Task 4). The state is DERIVED from two append-only, hash-chained tables: `loss_events` (the explicit,
 * auditable source of REALIZED loss) and `circuit_breaker_events` (WARNED / BREACHED / RESET history). A breaker is open while a BREACHED row's reset time is
 * in the future and no RESET references it. It is SEPARATE from the manual kill switch (system_controls): resetting a breaker never touches the kill switch,
 * and every enforcement point evaluates the kill switch independently. Nothing here places an order or calls a broker; no loss is ever derived from a signal.
 */
export const BREAKER_ACTOR = "service:circuit-breaker";
export const SCOPES: readonly BreakerScope[] = ["DAILY", "WEEKLY"];

// ── loss events: the accounting interface ──
export type LossSource = "synthetic" | "manual_adjustment" | "broker_reconciliation";
export interface LossEventInput {
  /** The loss MAGNITUDE (> 0). A profit is not a loss event and never offsets one. */
  amount: number;
  occurredAt: Date;
  source: LossSource;
  /** The external reference (a reconciled fill id, a test id). Unique per source. */
  sourceRef: string;
  idempotencyKey?: string;
  riskDecisionId?: string | null;
  details?: Record<string, unknown>;
  createdBy: string;
  currency?: string;
}
/** The seam for a future broker reconciliation: implement `fetchLossEvents` and call `ingestLossEvents`. No implementation exists (no fills / P&L yet). */
export interface LossEventSource {
  readonly name: string;
  fetchLossEvents(range: { from: Date; to: Date }): Promise<LossEventInput[]>;
}
export const syntheticLossSource = (events: LossEventInput[]): LossEventSource => ({ name: "synthetic", fetchLossEvents: async (r) => events.filter((e) => e.occurredAt >= r.from && e.occurredAt < r.to) });

const ACTOR = /^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$/;
const REF = /^[A-Za-z0-9_.:/@-]{1,120}$/;

export async function recordLossEvent(db: Db, input: LossEventInput, env: Record<string, string | undefined> = process.env): Promise<{ id: string; created: boolean }> {
  if (!Number.isFinite(input.amount) || !(input.amount > 0)) throw new RiskDecisionError("invalid_input", "a loss event amount must be a positive number (a loss magnitude)");
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) throw new RiskDecisionError("invalid_input", "occurredAt must be a valid date");
  if (!["synthetic", "manual_adjustment", "broker_reconciliation"].includes(input.source)) throw new RiskDecisionError("invalid_input", "unknown loss event source");
  if (input.source === "synthetic" && env["APP_ENV"] === "production") throw new RiskDecisionError("invalid_input", "synthetic loss events are refused in production");
  if (!REF.test(input.sourceRef)) throw new RiskDecisionError("invalid_input", "sourceRef must be 1-120 safe characters");
  if (!ACTOR.test(input.createdBy)) throw new RiskDecisionError("invalid_input", "createdBy must be service:<name> or operator:<name>");
  const key = input.idempotencyKey ?? `loss:${input.source}:${input.sourceRef}`;
  const values = { amount: String(input.amount), currency: input.currency ?? "INR", occurredAt: input.occurredAt, source: input.source, sourceRef: input.sourceRef, riskDecisionId: input.riskDecisionId ?? null, idempotencyKey: key, details: input.details ?? null, createdBy: input.createdBy };
  try {
    const [row] = await db.insert(schema.lossEvents).values(values).onConflictDoNothing({ target: schema.lossEvents.idempotencyKey }).returning({ id: schema.lossEvents.id });
    if (row) return { id: row.id, created: true };
    const [existing] = await db.select().from(schema.lossEvents).where(eq(schema.lossEvents.idempotencyKey, key));
    if (!existing || Number(existing.amount) !== input.amount || existing.source !== input.source || existing.sourceRef !== input.sourceRef) throw new RiskDecisionError("idempotency_conflict", "that idempotency key was used for a different loss event");
    return { id: existing.id, created: false };
  } catch (error) {
    if (error instanceof RiskDecisionError) throw error;
    const pg = ((error as { cause?: unknown } | null)?.cause ?? error) as { code?: string } | null;
    if (pg?.code === "23505") throw new RiskDecisionError("idempotency_conflict", "that source reference is already recorded as a different loss event", undefined, error);
    if (pg?.code === "23503") throw new RiskDecisionError("not_found", "the referenced risk decision does not exist", undefined, error);
    throw new RiskDecisionError("store_failure", "the loss event could not be stored", undefined, error);
  }
}

export async function ingestLossEvents(db: Db, source: LossEventSource, range: { from: Date; to: Date }, env: Record<string, string | undefined> = process.env): Promise<{ source: string; fetched: number; created: number }> {
  const events = await source.fetchLossEvents(range);
  let created = 0;
  for (const e of events) if ((await recordLossEvent(db, e, env)).created) created += 1;
  return { source: source.name, fetched: events.length, created };
}

// ── state ──
export interface ScopeStatus {
  scope: BreakerScope;
  status: "CLEAR" | "WARNING" | "BREACHED";
  periodStart: Date;
  periodEnd: Date;
  /** When the (current or would-be) breach lifts. */
  resetsAt: Date;
  realizedLoss: number;
  plannedExposure: number;
  limitPct: number;
  limitAmount: number;
  lossPct: number;
  warnAmount: number;
  breachEventId: string | null;
  breachedAt: Date | null;
  breachReason: string | null;
  lastResetAt: Date | null;
  lastResetAuthorization: string | null;
}
export interface CircuitBreakerStatus {
  asOf: Date;
  capital: number;
  scopes: Record<BreakerScope, ScopeStatus>;
  blocked: boolean;
  blockedBy: BreakerScope[];
  /** Ids of the stored BREACHED events currently open (empty if the block comes only from a loss not yet recorded). */
  openBreachIds: string[];
}
export interface BreakerEventRecord { id: string; scope: BreakerScope; eventType: "WARNED" | "BREACHED" | "RESET"; lossPct: number; limitPct: number; created: boolean }
export interface BreakerOptions { asOf?: Date; breakers?: BreakerConfig; expiry?: ExpiryConfig; onBreakerEvent?: (e: BreakerEventRecord) => void }

const num = (v: unknown): number => Number(v ?? 0);
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const EPS = 1e-9;
const limitPctOf = (scope: BreakerScope, c: BreakerConfig): number => (scope === "DAILY" ? c.dailyLossPct : c.weeklyLossPct);

async function scopeStatus(db: Db, scope: BreakerScope, capital: number, asOf: Date, config: BreakerConfig, expiry: ExpiryConfig): Promise<ScopeStatus> {
  const period: Period = periodFor(scope, asOf, config.utcOffsetMinutes);
  const start = period.start.toISOString(), end = period.end.toISOString(), now = asOf.toISOString();
  const loss = await db.execute(sql`select coalesce(sum(amount), 0) as s from loss_events where occurred_at >= ${start}::timestamptz and occurred_at < ${end}::timestamptz`);
  const planned = await db.execute(sql`select coalesce(sum(planned_max_loss_amount), 0) as s from risk_decisions_effective where superseded_by_id is null and planned_max_loss_amount > 0 and ${freshCondition(asOf, expiry)} and created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz`);
  const open = await db.execute(sql`select id, created_at, reason_code, period_end from circuit_breaker_events b where scope = ${scope} and event_type = 'BREACHED' and period_start <= ${now}::timestamptz and period_end > ${now}::timestamptz
    and not exists (select 1 from circuit_breaker_events r where r.breach_event_id = b.id) order by chain_index desc limit 1`);
  const reset = await db.execute(sql`select created_at, reset_authorization from circuit_breaker_events where scope = ${scope} and event_type = 'RESET' order by chain_index desc limit 1`);
  const realizedLoss = num((loss.rows[0] as { s: unknown }).s);
  const limitPct = limitPctOf(scope, config);
  const limitAmount = (capital * limitPct) / 100;
  const warnAmount = (limitAmount * config.warnPct) / 100;
  const stored = open.rows[0] as { id: string; created_at: string; reason_code: string; period_end: string } | undefined;
  const status: ScopeStatus["status"] = stored || realizedLoss >= limitAmount - EPS ? "BREACHED" : realizedLoss >= warnAmount - EPS ? "WARNING" : "CLEAR";
  const lastReset = reset.rows[0] as { created_at: string; reset_authorization: string } | undefined;
  return {
    scope, status, periodStart: period.start, periodEnd: period.end, resetsAt: stored ? new Date(stored.period_end) : period.resetsAt, realizedLoss: round6(realizedLoss), plannedExposure: round6(num((planned.rows[0] as { s: unknown }).s)),
    limitPct, limitAmount: round6(limitAmount), lossPct: round6((realizedLoss * 100) / capital), warnAmount: round6(warnAmount), breachEventId: stored?.id ?? null, breachedAt: stored ? new Date(stored.created_at) : null,
    breachReason: stored?.reason_code ?? (status === "BREACHED" ? `${scope.toLowerCase()}_loss_limit_breached` : null), lastResetAt: lastReset ? new Date(lastReset.created_at) : null, lastResetAuthorization: lastReset?.reset_authorization ?? null,
  };
}

/** Read-only inspection (never blocked by any control). Computed from the loss events and the breaker history; writes nothing. */
export async function getCircuitBreakerStatus(db: Db, opts: { capital: number } & BreakerOptions): Promise<CircuitBreakerStatus> {
  if (!Number.isFinite(opts.capital) || !(opts.capital > 0)) throw new RiskDecisionError("invalid_input", "capital must be a positive number to evaluate the loss limits");
  const config = opts.breakers ?? loadBreakerConfig();
  const expiry = opts.expiry ?? loadExpiryConfig();
  const asOf = opts.asOf ?? (await databaseNow(db));
  const daily = await scopeStatus(db, "DAILY", opts.capital, asOf, config, expiry);
  const weekly = await scopeStatus(db, "WEEKLY", opts.capital, asOf, config, expiry);
  const blockedBy = ([daily, weekly] as ScopeStatus[]).filter((s) => s.status === "BREACHED").map((s) => s.scope);
  return { asOf, capital: opts.capital, scopes: { DAILY: daily, WEEKLY: weekly }, blocked: blockedBy.length > 0, blockedBy, openBreachIds: [daily.breachEventId, weekly.breachEventId].filter((x): x is string => x !== null) };
}

async function insertEvent(db: Db, v: typeof schema.circuitBreakerEvents.$inferInsert): Promise<{ id: string; created: boolean }> {
  const [row] = await db.insert(schema.circuitBreakerEvents).values(v).onConflictDoNothing({ target: schema.circuitBreakerEvents.idempotencyKey }).returning({ id: schema.circuitBreakerEvents.id });
  if (row) return { id: row.id, created: true };
  const [existing] = await db.select({ id: schema.circuitBreakerEvents.id }).from(schema.circuitBreakerEvents).where(eq(schema.circuitBreakerEvents.idempotencyKey, v.idempotencyKey));
  if (!existing) throw new RiskDecisionError("store_failure", "the breaker event conflicted but the canonical row was not found");
  return { id: existing.id, created: false };
}

/**
 * Records what the loss events say: RESET of every breach whose reset time has passed (automatic, at the period rollover), BREACHED when a limit is reached,
 * WARNED at the warning threshold. Idempotent (one event per scope and period); `onBreakerEvent` is called for events THIS call created (the alert hook).
 */
export async function evaluateCircuitBreakers(db: Db, opts: { capital: number } & BreakerOptions): Promise<{ status: CircuitBreakerStatus; events: BreakerEventRecord[] }> {
  if (!Number.isFinite(opts.capital) || !(opts.capital > 0)) throw new RiskDecisionError("invalid_input", "capital must be a positive number to evaluate the loss limits");
  const config = opts.breakers ?? loadBreakerConfig();
  const expiry = opts.expiry ?? loadExpiryConfig();
  const asOf = opts.asOf ?? (await databaseNow(db));
  const events: BreakerEventRecord[] = [];
  const emit = (e: BreakerEventRecord) => { events.push(e); if (e.created) opts.onBreakerEvent?.(e); };

  // 1. automatic reset at the period rollover (a kill switch is unaffected: it is not consulted or changed here)
  const stale = await db.execute(sql`select * from circuit_breaker_events b where event_type = 'BREACHED' and period_end <= ${asOf.toISOString()}::timestamptz and not exists (select 1 from circuit_breaker_events r where r.breach_event_id = b.id) order by chain_index`);
  for (const b of stale.rows as Array<Record<string, unknown>>) {
    const scope = String(b["scope"]) as BreakerScope;
    const r = await insertEvent(db, {
      scope, eventType: "RESET", periodStart: new Date(b["period_start"] as string), periodEnd: new Date(b["period_end"] as string), lossAmount: String(b["loss_amount"]), limitAmount: String(b["limit_amount"]), capital: String(b["capital"]),
      lossPct: String(b["loss_pct"]), plannedExposureAmount: String(b["planned_exposure_amount"]), reasonCode: "breaker_reset", reason: "The breach period has ended; the circuit breaker resets automatically.", breachEventId: String(b["id"]),
      resetAuthorization: "automatic:period_rollover", idempotencyKey: `breaker-reset:${String(b["id"])}`, snapshot: { resetAsOf: asOf.toISOString(), breachedAt: new Date(b["created_at"] as string).toISOString(), breachReason: b["reason_code"] }, createdBy: BREAKER_ACTOR,
    });
    emit({ id: r.id, scope, eventType: "RESET", lossPct: num(b["loss_pct"]), limitPct: limitPctOf(scope, config), created: r.created });
  }

  // 2. breach / warning for the current periods
  const before = await getCircuitBreakerStatus(db, { ...opts, asOf, breakers: config, expiry });
  for (const scope of SCOPES) {
    const s = before.scopes[scope];
    if (s.breachEventId) continue; // already open
    const period = periodFor(scope, asOf, config.utcOffsetMinutes);
    const base = {
      scope, periodStart: period.start, lossAmount: String(s.realizedLoss), limitAmount: String(s.limitAmount), capital: String(opts.capital), lossPct: String(s.lossPct), plannedExposureAmount: String(s.plannedExposure), createdBy: BREAKER_ACTOR,
      snapshot: { asOf: asOf.toISOString(), limitPct: s.limitPct, warnPct: config.warnPct, utcOffsetMinutes: config.utcOffsetMinutes, realizedLoss: s.realizedLoss, plannedExposure: s.plannedExposure },
    };
    if (s.realizedLoss >= s.limitAmount - EPS) {
      const r = await insertEvent(db, { ...base, eventType: "BREACHED", periodEnd: period.resetsAt, reasonCode: `${scope.toLowerCase()}_loss_limit_breached`, reason: `Realized ${scope.toLowerCase()} loss reached ${s.lossPct}% of capital (limit ${s.limitPct}%); new risk decisions and approvals are blocked until ${period.resetsAt.toISOString()}.`, idempotencyKey: `breaker:${scope}:${period.start.toISOString()}` });
      emit({ id: r.id, scope, eventType: "BREACHED", lossPct: s.lossPct, limitPct: s.limitPct, created: r.created });
    } else if (s.realizedLoss >= s.warnAmount - EPS) {
      const r = await insertEvent(db, { ...base, eventType: "WARNED", periodEnd: period.end, reasonCode: `${scope.toLowerCase()}_loss_warning`, reason: `Realized ${scope.toLowerCase()} loss reached ${config.warnPct}% of its limit.`, idempotencyKey: `breaker-warn:${scope}:${period.start.toISOString()}` });
      emit({ id: r.id, scope, eventType: "WARNED", lossPct: s.lossPct, limitPct: s.limitPct, created: r.created });
    }
  }
  return { status: await getCircuitBreakerStatus(db, { ...opts, asOf, breakers: config, expiry }), events };
}

/** The enforcement read used by sizing and approval transitions: evaluates (and records) the breakers; any failure to read the state FAILS CLOSED. */
export async function breakerGate(db: Db, capital: number, opts: BreakerOptions = {}): Promise<CircuitBreakerStatus> {
  try {
    return (await evaluateCircuitBreakers(db, { capital, ...opts })).status;
  } catch (cause) {
    if (cause instanceof RiskDecisionError) throw cause;
    throw new RiskDecisionError("circuit_breaker_unavailable", "the circuit-breaker state could not be read; the operation is refused", undefined, cause);
  }
}

/** Stable identity of "which breakers block now" (used to key a blocked record so that a later retry after the reset is a different request). */
export const breakerBlockId = (s: CircuitBreakerStatus): string => createHash("sha256").update(`breaker:${s.blockedBy.join(",")}:${[...s.openBreachIds].sort().join(",")}`).digest("hex");

// ── alerts ──
export interface BreakerAlert { event: string; severity: "INFO" | "WARNING" | "CRITICAL"; code: string; summary: string; details: { scope: string; lossPct: number; limitPct: number } }
/** Fixed-template alert for a created breaker event: scope and percentages only (no amounts, no identities, no free text). */
export function breakerAlert(e: BreakerEventRecord): BreakerAlert {
  const when = e.scope === "DAILY" ? "the next trading day" : "the next trading week";
  const label = e.scope === "DAILY" ? "Daily" : "Weekly";
  const details = { scope: e.scope.toLowerCase(), lossPct: e.lossPct, limitPct: e.limitPct };
  if (e.eventType === "BREACHED") return { event: "risk.circuit_breaker.breached", severity: "CRITICAL", code: `${e.scope.toLowerCase()}_loss_limit_breached`, summary: `${label} loss limit breached: new risk decisions and approvals are blocked until ${when}.`, details };
  if (e.eventType === "WARNED") return { event: "risk.circuit_breaker.warning", severity: "WARNING", code: `${e.scope.toLowerCase()}_loss_warning`, summary: `${label} realized loss has reached the warning threshold of its circuit-breaker limit.`, details };
  return { event: "risk.circuit_breaker.reset", severity: "INFO", code: `${e.scope.toLowerCase()}_breaker_reset`, summary: `${label} circuit breaker reset automatically at the period rollover.`, details };
}
