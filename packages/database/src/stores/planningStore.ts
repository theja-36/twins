import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../client";
import { confidenceAssessments, confidenceCalibrationRuns, riskAssessments, riskControlEvents, simulations, userCapitalProfiles, userRiskPolicies } from "../schema";
import { withUser } from "../withUser";

/**
 * Persistence for capital, risk, confidence and simulation (Master Build Stage 06). Every user-owned table is written inside `withUser`, so row-level security binds each write to its owner; the composite owner keys
 * (account, user) make a cross-user reference impossible. Profiles and policies are append-only VERSIONS (the next version, serialised per account); assessments, simulations and control events are append-only.
 */
type Tx = Parameters<Parameters<typeof withUser>[2]>[0];
const t = (tx: Tx) => tx as unknown as Pick<Db, "execute" | "select" | "insert">;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface CapitalProfileInput { accountId: string; totalCapital: string; availableCapital: string; maxPositionNotionalPct: string | null; effectiveFrom?: Date; createdBy: string }
export interface StoredCapitalProfile { id: string; accountId: string; version: number; totalCapital: string; availableCapital: string; maxPositionNotionalPct: string | null; currency: string; effectiveFrom: Date; createdBy: string }
export async function appendCapitalProfile(db: Pick<Db, "transaction">, userId: string, i: CapitalProfileInput): Promise<{ id: string; version: number }> {
  return withUser(db, userId, async (tx) => {
    const x = t(tx);
    await x.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"capital:" + i.accountId}, 0))`);
    const [last] = await x.select({ v: userCapitalProfiles.version }).from(userCapitalProfiles).where(eq(userCapitalProfiles.accountId, i.accountId)).orderBy(desc(userCapitalProfiles.version)).limit(1);
    const version = (last?.v ?? 0) + 1;
    const [r] = await x.insert(userCapitalProfiles).values({ userId, accountId: i.accountId, version, totalCapital: i.totalCapital, availableCapital: i.availableCapital, maxPositionNotionalPct: i.maxPositionNotionalPct, effectiveFrom: i.effectiveFrom ?? new Date(), createdBy: i.createdBy }).returning({ id: userCapitalProfiles.id });
    return { id: (r as { id: string }).id, version };
  });
}
export async function getEffectiveCapitalProfile(db: Pick<Db, "transaction">, userId: string, accountId: string, at: Date): Promise<StoredCapitalProfile | null> {
  return withUser(db, userId, async (tx) => {
    const [r] = await t(tx).select().from(userCapitalProfiles).where(and(eq(userCapitalProfiles.accountId, accountId), lte(userCapitalProfiles.effectiveFrom, at))).orderBy(desc(userCapitalProfiles.effectiveFrom), desc(userCapitalProfiles.version)).limit(1);
    return r ? { id: r.id, accountId: r.accountId, version: r.version, totalCapital: r.totalCapital, availableCapital: r.availableCapital, maxPositionNotionalPct: r.maxPositionNotionalPct, currency: r.currency, effectiveFrom: r.effectiveFrom, createdBy: r.createdBy } : null;
  });
}
export async function listCapitalProfileVersions(db: Pick<Db, "transaction">, userId: string, accountId: string): Promise<StoredCapitalProfile[]> {
  return withUser(db, userId, async (tx) => (await t(tx).select().from(userCapitalProfiles).where(eq(userCapitalProfiles.accountId, accountId)).orderBy(desc(userCapitalProfiles.version))).map((r) => ({ id: r.id, accountId: r.accountId, version: r.version, totalCapital: r.totalCapital, availableCapital: r.availableCapital, maxPositionNotionalPct: r.maxPositionNotionalPct, currency: r.currency, effectiveFrom: r.effectiveFrom, createdBy: r.createdBy })));
}

export interface RiskPolicyInput { accountId: string; riskPercent: string; maxRiskPerTrade: string | null; maxDailyLoss: string; maxConcurrentPositions: number; maxLots: number; minRewardToRisk: string; allowedUnderlyings: string[]; maxDrawdownPct: string | null; maxPortfolioExposurePct: string | null; maxCorrelatedRiskPct: string | null; effectiveFrom?: Date; createdBy: string }
export interface StoredRiskPolicy extends Omit<RiskPolicyInput, "effectiveFrom"> { id: string; version: number; effectiveFrom: Date }
const policyOf = (r: typeof userRiskPolicies.$inferSelect): StoredRiskPolicy => ({ id: r.id, accountId: r.accountId, version: r.version, riskPercent: r.riskPercent, maxRiskPerTrade: r.maxRiskPerTrade, maxDailyLoss: r.maxDailyLoss, maxConcurrentPositions: r.maxConcurrentPositions, maxLots: r.maxLots, minRewardToRisk: r.minRewardToRisk, allowedUnderlyings: r.allowedUnderlyings, maxDrawdownPct: r.maxDrawdownPct, maxPortfolioExposurePct: r.maxPortfolioExposurePct, maxCorrelatedRiskPct: r.maxCorrelatedRiskPct, effectiveFrom: r.effectiveFrom, createdBy: r.createdBy });
export async function appendRiskPolicy(db: Pick<Db, "transaction">, userId: string, i: RiskPolicyInput): Promise<{ id: string; version: number }> {
  return withUser(db, userId, async (tx) => {
    const x = t(tx);
    await x.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"risk_policy:" + i.accountId}, 0))`);
    const [last] = await x.select({ v: userRiskPolicies.version }).from(userRiskPolicies).where(eq(userRiskPolicies.accountId, i.accountId)).orderBy(desc(userRiskPolicies.version)).limit(1);
    const version = (last?.v ?? 0) + 1;
    const { effectiveFrom, ...rest } = i;
    const [r] = await x.insert(userRiskPolicies).values({ ...rest, userId, version, effectiveFrom: effectiveFrom ?? new Date() }).returning({ id: userRiskPolicies.id });
    return { id: (r as { id: string }).id, version };
  });
}
export async function getEffectiveRiskPolicy(db: Pick<Db, "transaction">, userId: string, accountId: string, at: Date): Promise<StoredRiskPolicy | null> {
  return withUser(db, userId, async (tx) => { const [r] = await t(tx).select().from(userRiskPolicies).where(and(eq(userRiskPolicies.accountId, accountId), lte(userRiskPolicies.effectiveFrom, at))).orderBy(desc(userRiskPolicies.effectiveFrom), desc(userRiskPolicies.version)).limit(1); return r ? policyOf(r) : null; });
}

/** One strength assessment per (candidate, model version); a repeat is a no-op that returns the stored row's id. Shared (a candidate's strength does not depend on a user). */
export async function storeConfidenceAssessment(db: Pick<Db, "insert" | "select">, row: { candidateId: string; score: number; components: unknown; supporting: unknown; contradicting: unknown; missing: unknown; riskFlags: unknown; historicalComparison: unknown | null; explanation: string; calibrationStatus: "UNCALIBRATED" | "CALIBRATING" | "CALIBRATED"; modelVersion: string }): Promise<{ id: string; created: boolean }> {
  const [ins] = await db.insert(confidenceAssessments).values({ ...row, score: String(row.score) }).onConflictDoNothing().returning({ id: confidenceAssessments.id });
  if (ins) return { id: ins.id, created: true };
  const [ex] = await db.select({ id: confidenceAssessments.id }).from(confidenceAssessments).where(and(eq(confidenceAssessments.candidateId, row.candidateId), eq(confidenceAssessments.modelVersion, row.modelVersion)));
  if (!ex) throw new Error("the confidence assessment vanished");
  return { id: ex.id, created: false };
}
export async function getConfidenceAssessment(db: Pick<Db, "select">, candidateId: string, modelVersion: string): Promise<{ id: string; score: number; calibrationStatus: string; explanation: string; components: unknown; missing: unknown } | null> {
  const [r] = await db.select().from(confidenceAssessments).where(and(eq(confidenceAssessments.candidateId, candidateId), eq(confidenceAssessments.modelVersion, modelVersion)));
  return r ? { id: r.id, score: Number(r.score), calibrationStatus: r.calibrationStatus, explanation: r.explanation, components: r.components, missing: r.missing } : null;
}
export async function storeCalibrationRun(db: Pick<Db, "insert">, run: { modelVersion: string; sampleSize: number; outOfSample: boolean; bins: unknown; brierScore: number | null; status: "UNCALIBRATED" | "CALIBRATING" | "CALIBRATED" }): Promise<string> {
  const [r] = await db.insert(confidenceCalibrationRuns).values({ modelVersion: run.modelVersion, sampleSize: run.sampleSize, outOfSample: run.outOfSample, bins: run.bins, brierScore: run.brierScore === null ? null : String(run.brierScore), calibrationStatus: run.status }).returning({ id: confidenceCalibrationRuns.id });
  return (r as { id: string }).id;
}
export async function latestCalibrationRun(db: Pick<Db, "select">, modelVersion: string): Promise<{ id: string; status: string; sampleSize: number; outOfSample: boolean; bins: unknown; brierScore: number | null } | null> {
  const [r] = await db.select().from(confidenceCalibrationRuns).where(eq(confidenceCalibrationRuns.modelVersion, modelVersion)).orderBy(desc(confidenceCalibrationRuns.createdAt)).limit(1);
  return r ? { id: r.id, status: r.calibrationStatus, sampleSize: r.sampleSize, outOfSample: r.outOfSample, bins: r.bins, brierScore: num(r.brierScore) } : null;
}

export interface RiskAssessmentRow { accountId: string; candidateId: string; policyVersion: number; verdict: "PASS" | "RESTRICTED" | "BLOCKED"; blockers: unknown; result: unknown; researchPackageId: string | null }
export async function storeRiskAssessment(db: Pick<Db, "transaction">, userId: string, r: RiskAssessmentRow): Promise<string> {
  return withUser(db, userId, async (tx) => {
    const [row] = await t(tx).insert(riskAssessments).values({ userId, accountId: r.accountId, candidateId: r.candidateId, policyVersion: r.policyVersion, passed: r.verdict === "PASS", verdict: r.verdict, researchPackageId: r.researchPackageId, blockers: r.blockers, result: r.result }).returning({ id: riskAssessments.id });
    return (row as { id: string }).id;
  });
}
/**
 * Stage 06 (G-46): persist one evaluation atomically. Under a per-(account, candidate) advisory lock, ONE transaction re-checks recency, then inserts the risk assessment and the simulation that points at it. Two concurrent
 * evaluations of the same candidate therefore store one result (the loser gets `created: false`), and a crash can never leave an assessment without its simulation.
 */
export async function persistEvaluation(db: Pick<Db, "transaction">, userId: string, i: { risk: RiskAssessmentRow; withinMinutes: number; simulation: { params: unknown; scenarios: unknown; costModelVersion: string } }): Promise<{ created: false } | { created: true; riskAssessmentId: string; simulationId: string }> {
  return withUser(db, userId, async (tx) => {
    const r = i.risk;
    await t(tx).execute(sql`select pg_advisory_xact_lock(hashtextextended(${"evaluation:" + r.accountId + ":" + r.candidateId}, 0))`);
    const recent = await t(tx).execute(sql`select 1 from risk_assessments where account_id = ${r.accountId} and candidate_id = ${r.candidateId} and research_package_id is not distinct from ${r.researchPackageId} and created_at > now() - (${i.withinMinutes} * interval '1 minute') limit 1`);
    if (recent.rows.length > 0) return { created: false as const };
    const [a] = await t(tx).insert(riskAssessments).values({ userId, accountId: r.accountId, candidateId: r.candidateId, policyVersion: r.policyVersion, passed: r.verdict === "PASS", verdict: r.verdict, researchPackageId: r.researchPackageId, blockers: r.blockers, result: r.result }).returning({ id: riskAssessments.id });
    const riskAssessmentId = (a as { id: string }).id;
    const [sm] = await t(tx).insert(simulations).values({ userId, accountId: r.accountId, candidateId: r.candidateId, params: i.simulation.params, scenarios: i.simulation.scenarios, costModelVersion: i.simulation.costModelVersion, riskAssessmentId }).returning({ id: simulations.id });
    return { created: true as const, riskAssessmentId, simulationId: (sm as { id: string }).id };
  });
}
export async function getLatestRiskAssessment(db: Pick<Db, "transaction">, userId: string, accountId: string, candidateId: string): Promise<{ id: string; verdict: string; policyVersion: number; result: unknown; researchPackageId: string | null; createdAt: Date } | null> {
  return withUser(db, userId, async (tx) => {
    const [r] = await t(tx).select().from(riskAssessments).where(and(eq(riskAssessments.accountId, accountId), eq(riskAssessments.candidateId, candidateId))).orderBy(desc(riskAssessments.createdAt)).limit(1);
    return r ? { id: r.id, verdict: r.verdict, policyVersion: r.policyVersion, result: r.result, researchPackageId: r.researchPackageId, createdAt: r.createdAt } : null;
  });
}
export async function storeSimulation(db: Pick<Db, "transaction">, userId: string, s: { accountId: string; candidateId: string; params: unknown; scenarios: unknown; costModelVersion: string; riskAssessmentId: string | null }): Promise<string> {
  return withUser(db, userId, async (tx) => {
    const [row] = await t(tx).insert(simulations).values({ userId, ...s }).returning({ id: simulations.id });
    return (row as { id: string }).id;
  });
}

// ─── risk controls ──────────────────────────────────────────────────────────
export interface ControlRef { scope: "USER" | "MARKET" | "SOURCE" | "STRATEGY"; scopeKey: string | null; kind: "RESTRICTION" | "DAILY_LOSS_HALT" | "DRAWDOWN_HALT" | "KILL_SWITCH"; userId: string | null }
export class RiskControlError extends Error { constructor(readonly code: string, m: string) { super(m); this.name = "RiskControlError"; } }
const need = (reason: string): void => { if (typeof reason !== "string" || reason.trim().length < 10) throw new RiskControlError("REASON_REQUIRED", "a control change needs a reason of at least 10 characters"); };
const write = async (db: Pick<Db, "transaction">, c: ControlRef, action: "SET" | "CLEAR", o: { reason: string; actor: string; actorKind: "OWNER" | "SYSTEM"; expiresAt?: Date | null }): Promise<string> => {
  need(o.reason);
  if (c.scope === "USER" && !c.userId) throw new RiskControlError("USER_REQUIRED", "a USER control needs the user");
  if (action === "CLEAR" && o.actorKind !== "OWNER" && !(c.kind === "RESTRICTION" || c.kind === "DAILY_LOSS_HALT")) throw new RiskControlError("OWNER_REQUIRED", `only an owner can clear a ${c.kind}; the system never does`);
  const run = async (x: Pick<Db, "insert">): Promise<string> => { const [r] = await x.insert(riskControlEvents).values({ userId: c.userId, scope: c.scope, scopeKey: c.scopeKey, kind: c.kind, action, reason: o.reason.trim(), actor: o.actor, actorKind: o.actorKind, expiresAt: action === "SET" ? o.expiresAt ?? null : null }).returning({ id: riskControlEvents.id }); return (r as { id: string }).id; };
  return c.userId ? withUser(db, c.userId, (tx) => run(t(tx))) : run(db as unknown as Pick<Db, "insert">);
};
export const setRiskControl = (db: Pick<Db, "transaction">, c: ControlRef, o: { reason: string; actor: string; actorKind: "OWNER" | "SYSTEM"; expiresAt?: Date | null }) => write(db, c, "SET", o);
export const clearRiskControl = (db: Pick<Db, "transaction">, c: ControlRef, o: { reason: string; actor: string; actorKind: "OWNER" | "SYSTEM" }) => write(db, c, "CLEAR", o);

/**
 * The RUNTIME path for a halt (migration 0047): the planning cycle records a USER-scope halt ONLY through the narrow SECURITY DEFINER function twins_set_user_halt, because the runtime role has no direct INSERT on risk_control_events.
 * The function fixes scope, action, actor and actor kind; it cannot create a platform-wide control, a CLEAR or an OWNER-labelled event. It is idempotent (an identical halt already recorded is returned, not appended again).
 * The user must be bound (this runs inside `withUser`); the binding itself is NOT authenticated by the database (known limitation, docs/product/ARCHITECTURE_DECISIONS.md ADR-015).
 */
export async function recordUserHalt(db: Pick<Db, "transaction">, userId: string, h: { kind: "DAILY_LOSS_HALT" | "DRAWDOWN_HALT"; reason: string; expiresAt: Date | null }): Promise<string> {
  need(h.reason);
  return withUser(db, userId, async (tx) => {
    const r = await t(tx).execute(sql`select public.twins_set_user_halt(${h.kind}, ${h.reason}, ${h.expiresAt === null ? null : h.expiresAt.toISOString()}::timestamptz) as id`);
    return String((r.rows[0] as { id: unknown }).id);
  });
}

// ─── owner path (the owner CLI, scripts/ops/risk-control.ts `controls`) ─────
export interface ControlEventRow { id: string; userId: string | null; scope: ControlRef["scope"]; scopeKey: string | null; kind: ControlRef["kind"]; action: "SET" | "CLEAR"; reason: string; actor: string; actorKind: "OWNER" | "SYSTEM"; expiresAt: string | null; occurredAt: string }
const ctlRow = (x: Record<string, unknown>): ControlEventRow => ({ id: x["id"] as string, userId: (x["user_id"] ?? null) as string | null, scope: x["scope"] as ControlRef["scope"], scopeKey: (x["scope_key"] ?? null) as string | null, kind: x["kind"] as ControlRef["kind"], action: x["action"] as "SET" | "CLEAR", reason: x["reason"] as string, actor: x["actor"] as string, actorKind: x["actor_kind"] as "OWNER" | "SYSTEM", expiresAt: x["expires_at"] === null || x["expires_at"] === undefined ? null : new Date(x["expires_at"] as string).toISOString(), occurredAt: new Date(x["occurred_at"] as string).toISOString() });
/** Is the connected LOGIN role on the explicit owner allowlist (twins_control_privileged_roles)? The runtime role cannot even read that table, so for it this is an error or false: the CLI refuses either way. */
export async function isPrivilegedControlRole(db: Pick<Db, "execute">): Promise<boolean> {
  const r = await db.execute(sql`select exists (select 1 from public.twins_control_privileged_roles where role_name = session_user) as ok`);
  return (r.rows[0] as { ok: boolean }).ok === true;
}
/** Control events for the owner CLI: `activeOnly` = the controls in force now (latest event per scope/key/kind/user is an unexpired SET); otherwise the event history, newest first. Needs the owner connection (all users' rows). */
export async function listControlEvents(db: Pick<Db, "execute">, f: { userId?: string; scope?: ControlRef["scope"]; activeOnly: boolean; limit: number; now?: Date }): Promise<ControlEventRow[]> {
  const lim = Math.min(Math.max(Math.trunc(f.limit), 1), 500), uf = f.userId ? sql`and user_id = ${f.userId}::uuid` : sql``, sf = f.scope ? sql`and scope = ${f.scope}` : sql``, now = (f.now ?? new Date()).toISOString();
  const r = f.activeOnly
    ? await db.execute(sql`select * from (select distinct on (scope, coalesce(scope_key, ''), kind, coalesce(user_id::text, '')) id, user_id, scope, scope_key, kind, action, reason, actor, actor_kind, expires_at, occurred_at from risk_control_events where true ${uf} ${sf} order by scope, coalesce(scope_key, ''), kind, coalesce(user_id::text, ''), occurred_at desc, id desc) latest where action = 'SET' and (expires_at is null or expires_at > ${now}::timestamptz) order by occurred_at desc limit ${lim}`)
    : await db.execute(sql`select id, user_id, scope, scope_key, kind, action, reason, actor, actor_kind, expires_at, occurred_at from risk_control_events where true ${uf} ${sf} order by occurred_at desc, id desc limit ${lim}`);
  return r.rows.map((x) => ctlRow(x as Record<string, unknown>));
}
/** The latest event id for one control key, or null when none exists (what `--expected-event` is compared with). */
export async function latestControlEventId(db: Pick<Db, "execute">, c: ControlRef): Promise<string | null> {
  const r = await db.execute(sql`select id from risk_control_events where scope = ${c.scope} and coalesce(scope_key, '') = ${c.scopeKey ?? ""} and kind = ${c.kind} and coalesce(user_id::text, '') = ${c.userId ?? ""} order by occurred_at desc, id desc limit 1`);
  return r.rows.length ? String((r.rows[0] as { id: unknown }).id) : null;
}
export class OwnerControlError extends Error { constructor(readonly code: "VALIDATION" | "CONCURRENT_CHANGE" | "NOT_IN_FORCE", m: string) { super(m); this.name = "OwnerControlError"; } }
/**
 * One owner-path control change, ALL OR NOTHING in a single transaction: validate, serialise on the control key, compare the latest event with `expectedLatest` (optimistic concurrency), append the control event AND the audit-chain row (audit_events).
 * `operator` is the SELF-DECLARED `operator:<name>` label (not authenticated). USER-scope controls are keyed by the user id (scope_key = user id, exactly as the planning cycle writes them) so an owner CLEAR matches the cycle's SET.
 * The database guard trigger independently refuses this write unless the connected login role is on the allowlist.
 */
export async function ownerChangeControl(db: Pick<Db, "transaction">, c: ControlRef, action: "SET" | "CLEAR", o: { reason: string; operator: string; expiresAt?: Date | null; expectedLatest: string | "none"; now?: Date }): Promise<{ eventId: string; auditId: string; previous: string | null }> {
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (reason.length < 10 || reason.length > 300) throw new OwnerControlError("VALIDATION", "a reason of 10 to 300 characters is required");
  if (!/^operator:[A-Za-z0-9._-]{1,60}$/.test(o.operator)) throw new OwnerControlError("VALIDATION", "operator must look like operator:<name>");
  if (c.scope === "USER") { if (!c.userId || c.scopeKey !== c.userId) throw new OwnerControlError("VALIDATION", "a USER control needs the user and its scope key must be that user id"); }
  else if (c.userId !== null || !c.scopeKey || c.scopeKey.length > 120) throw new OwnerControlError("VALIDATION", "a platform control needs a scope key and no user");
  if (action === "CLEAR" && o.expiresAt) throw new OwnerControlError("VALIDATION", "an expiry exists only on SET");
  if (o.expiresAt && !(o.expiresAt.getTime() > (o.now ?? new Date()).getTime())) throw new OwnerControlError("VALIDATION", "an expiry must be in the future");
  const body = async (tx: Pick<Db, "execute">): Promise<{ eventId: string; auditId: string; previous: string | null }> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`risk_control:${c.scope}:${c.scopeKey ?? ""}:${c.kind}:${c.userId ?? ""}`}, 0))`);
    const prev = await tx.execute(sql`select id, action, expires_at from risk_control_events where scope = ${c.scope} and coalesce(scope_key, '') = ${c.scopeKey ?? ""} and kind = ${c.kind} and coalesce(user_id::text, '') = ${c.userId ?? ""} order by occurred_at desc, id desc limit 1`);
    const latest = prev.rows[0] as { id: string; action: string; expires_at: string | null } | undefined, latestId = latest ? String(latest.id) : null;
    if ((o.expectedLatest === "none" ? null : o.expectedLatest) !== latestId) throw new OwnerControlError("CONCURRENT_CHANGE", "the control changed since it was read; list it again");
    if (action === "CLEAR" && !(latest && latest.action === "SET" && (latest.expires_at === null || new Date(latest.expires_at).getTime() > (o.now ?? new Date()).getTime()))) throw new OwnerControlError("NOT_IN_FORCE", "there is no control in force to clear");
    const ins = await tx.execute(sql`insert into risk_control_events (id, user_id, scope, scope_key, kind, action, reason, actor, actor_kind, expires_at) values (gen_random_uuid(), ${c.userId}::uuid, ${c.scope}, ${c.scopeKey}, ${c.kind}, ${action}, ${reason}, ${o.operator}, 'OWNER', ${action === "SET" && o.expiresAt ? o.expiresAt.toISOString() : null}::timestamptz) returning id`);
    const eventId = String((ins.rows[0] as { id: unknown }).id);
    const meta = JSON.stringify({ scope: c.scope, scopeKey: c.scopeKey, kind: c.kind, userId: c.userId, action, reason, expiresAt: action === "SET" && o.expiresAt ? o.expiresAt.toISOString() : null, previousEventId: latestId, declaredIdentity: "self-declared, not authenticated" });
    const aud = await tx.execute(sql`insert into audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata) values (gen_random_uuid(), ${action === "SET" ? "risk_control.set" : "risk_control.cleared"}, 'risk_control_event', ${eventId}::uuid, 'user', ${o.operator}, ${meta}::jsonb) returning id`);
    return { eventId, auditId: String((aud.rows[0] as { id: unknown }).id), previous: latestId };
  };
  return c.userId ? withUser(db, c.userId, (tx) => body(t(tx))) : db.transaction((tx) => body(tx as unknown as Pick<Db, "execute">));
}
export interface ActiveControlRow { id: string; userId: string | null; scope: ControlRef["scope"]; scopeKey: string | null; kind: ControlRef["kind"]; reason: string; setAt: string; expiresAt: string | null }
/** The controls in force at `now`: the latest event per (scope, key, kind, user) is a SET that has not expired. Platform controls plus the given user's own (row-level security). */
export async function listActiveControls(db: Pick<Db, "transaction">, userId: string | null, now: Date): Promise<ActiveControlRow[]> {
  // defence in depth: the owner filter is explicit, so the read does not depend on row-level security alone (a superuser or BYPASSRLS connection would otherwise see every user's controls)
  const own = userId ? sql`(user_id is null or user_id = ${userId}::uuid)` : sql`user_id is null`;
  const q = async (x: Pick<Db, "execute">): Promise<ActiveControlRow[]> => {
    const r = await x.execute(sql`select * from (select distinct on (scope, coalesce(scope_key, ''), kind, coalesce(user_id::text, '')) id, user_id, scope, scope_key, kind, action, reason, expires_at, occurred_at
        from risk_control_events where ${own} order by scope, coalesce(scope_key, ''), kind, coalesce(user_id::text, ''), occurred_at desc, id desc) latest
      where action = 'SET' and (expires_at is null or expires_at > ${now.toISOString()}::timestamptz) and occurred_at <= ${now.toISOString()}::timestamptz`);
    return r.rows.map((x2) => { const w = x2 as Record<string, unknown>; return { id: w["id"] as string, userId: (w["user_id"] ?? null) as string | null, scope: w["scope"] as ControlRef["scope"], scopeKey: (w["scope_key"] ?? null) as string | null, kind: w["kind"] as ControlRef["kind"], reason: w["reason"] as string, setAt: new Date(w["occurred_at"] as string).toISOString(), expiresAt: w["expires_at"] ? new Date(w["expires_at"] as string).toISOString() : null }; });
  };
  return userId ? withUser(db, userId, (tx) => q(t(tx))) : q(db as unknown as Pick<Db, "execute">);
}

/** The calling user's own accounts (row-level security plus an explicit owner filter). Never accepts another user id from a request: the caller passes the id of the verified session. */
export async function listUserAccounts(db: Pick<Db, "transaction">, userId: string): Promise<Array<{ id: string; name: string; tradingMode: string; baseCurrency: string; isActive: boolean }>> {
  return withUser(db, userId, async (tx) => {
    const r = await (tx as unknown as Pick<Db, "execute">).execute(sql`select id, name, trading_mode, base_currency, is_active from accounts where user_id = ${userId}::uuid order by created_at, id`);
    return r.rows.map((q) => { const w = q as Record<string, unknown>; return { id: w["id"] as string, name: w["name"] as string, tradingMode: w["trading_mode"] as string, baseCurrency: w["base_currency"] as string, isActive: w["is_active"] as boolean }; });
  });
}
/** Per-account portfolio facts derived in exact decimals by the database view `account_portfolio_facts` (0041): open paper positions, allocated notional at entry price, realised P&L, the effective capital profile. Security-invoker view: the caller's row-level security applies. Values are decimal STRINGS; null where no capital profile exists (never invented). */
export interface AccountPortfolioFacts { accountId: string; openPositions: number; allocatedNotional: string; realizedPnl: string; totalCapital: string | null; availableCapital: string | null; unallocatedCapital: string | null; capitalProfileVersion: number | null }
export async function getAccountPortfolioFacts(db: Pick<Db, "transaction">, userId: string, accountId: string): Promise<AccountPortfolioFacts | null> {
  return withUser(db, userId, async (tx) => {
    const r = await (tx as unknown as Pick<Db, "execute">).execute(sql`select account_id, open_positions, allocated_notional::text, realized_pnl::text, total_capital::text, available_capital::text, unallocated_capital::text, capital_profile_version from account_portfolio_facts where user_id = ${userId}::uuid and account_id = ${accountId}::uuid`);
    const w = r.rows[0] as Record<string, unknown> | undefined; if (!w) return null;
    const sv = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    return { accountId: w["account_id"] as string, openPositions: Number(w["open_positions"]), allocatedNotional: String(w["allocated_notional"]), realizedPnl: String(w["realized_pnl"]), totalCapital: sv(w["total_capital"]), availableCapital: sv(w["available_capital"]), unallocatedCapital: sv(w["unallocated_capital"]), capitalProfileVersion: w["capital_profile_version"] === null || w["capital_profile_version"] === undefined ? null : Number(w["capital_profile_version"]) };
  });
}
/** Accounts to evaluate: every active account (id and owner only; capital and policy are read per user under row-level security). Goes through the identifiers-only definer function because accounts are row-level protected (0041). */
export async function listActiveAccounts(db: Pick<Db, "execute">): Promise<Array<{ accountId: string; userId: string }>> {
  const r = await db.execute(sql`select a_account_id, a_user_id from twins_list_active_accounts()`);
  return r.rows.map((x) => ({ accountId: (x as { a_account_id: string }).a_account_id, userId: (x as { a_user_id: string }).a_user_id }));
}
export async function hasRecentRiskAssessment(db: Pick<Db, "transaction">, userId: string, accountId: string, candidateId: string, researchPackageId: string | null, withinMinutes: number): Promise<boolean> {
  return withUser(db, userId, async (tx) => {
    const r = await t(tx).execute(sql`select 1 from risk_assessments where account_id = ${accountId} and candidate_id = ${candidateId} and research_package_id is not distinct from ${researchPackageId} and created_at > now() - (${withinMinutes} * interval '1 minute') limit 1`);
    return r.rows.length > 0;
  });
}

/** The latest stored evaluation of a candidate for an account, as the decision engine consumes it: the risk assessment (with its result), the simulation run beside it, and the shared confidence assessment. */
export async function getLatestEvaluationBundle(db: Pick<Db, "transaction" | "select">, userId: string, accountId: string, candidateId: string): Promise<{ riskAssessmentId: string; verdict: string; policyVersion: number; result: unknown; researchPackageId: string | null; createdAt: Date; simulationId: string | null; confidence: { id: string; score: number; calibrationStatus: string; components: unknown; missing: unknown } | null } | null> {
  const risk = await getLatestRiskAssessment(db, userId, accountId, candidateId);
  if (!risk) return null;
  const sim = await withUser(db, userId, async (tx) => { const r = await t(tx).execute(sql`select id from simulations where risk_assessment_id = ${risk.id}::uuid order by created_at desc limit 1`); return (r.rows[0] as { id: string } | undefined)?.id ?? null; });
  const [conf] = await db.select().from(confidenceAssessments).where(eq(confidenceAssessments.candidateId, candidateId)).orderBy(desc(confidenceAssessments.createdAt)).limit(1);
  return { riskAssessmentId: risk.id, verdict: risk.verdict, policyVersion: risk.policyVersion, result: risk.result, researchPackageId: risk.researchPackageId, createdAt: risk.createdAt, simulationId: sim, confidence: conf ? { id: conf.id, score: Number(conf.score), calibrationStatus: conf.calibrationStatus, components: conf.components, missing: conf.missing } : null };
}
