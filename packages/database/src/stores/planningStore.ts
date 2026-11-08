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
export interface ActiveControlRow { id: string; userId: string | null; scope: ControlRef["scope"]; scopeKey: string | null; kind: ControlRef["kind"]; reason: string; setAt: string; expiresAt: string | null }
/** The controls in force at `now`: the latest event per (scope, key, kind, user) is a SET that has not expired. Platform controls plus the given user's own (row-level security). */
export async function listActiveControls(db: Pick<Db, "transaction">, userId: string | null, now: Date): Promise<ActiveControlRow[]> {
  const q = async (x: Pick<Db, "execute">): Promise<ActiveControlRow[]> => {
    const r = await x.execute(sql`select * from (select distinct on (scope, coalesce(scope_key, ''), kind, coalesce(user_id::text, '')) id, user_id, scope, scope_key, kind, action, reason, expires_at, occurred_at
        from risk_control_events order by scope, coalesce(scope_key, ''), kind, coalesce(user_id::text, ''), occurred_at desc, id desc) latest
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
/** Accounts to evaluate: every active account (id and owner only; capital and policy are read per user under row-level security). */
export async function listActiveAccounts(db: Pick<Db, "execute">): Promise<Array<{ accountId: string; userId: string }>> {
  const r = await db.execute(sql`select id, user_id from accounts where is_active order by created_at, id`);
  return r.rows.map((x) => ({ accountId: (x as { id: string }).id, userId: (x as { user_id: string }).user_id }));
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
