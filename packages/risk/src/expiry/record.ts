import { sql } from "drizzle-orm";
import type { Db } from "@twins/database";
import { getRiskDecision, RiskDecisionError, supersedeRiskDecision, type RiskDecisionRecord } from "../riskDecisions";
import { loadExpiryConfig, validityMs, type ExpiryConfig } from "./config";

/**
 * Expiry of stale risk decisions (Stage 3 / Task 4). A PENDING or APPROVED_FOR_REVIEW decision whose latest version is older than its validity window is
 * expired by appending a NEW EXPIRED version (never an update). Expired decisions stop counting toward the portfolio at once: the portfolio query applies the same
 * window, so exposure frees up even before the expiry job has recorded the version. Expiry only removes exposure, so it is allowed under the kill switch.
 * Idempotent (key per decision) and safe to run concurrently (the successor is unique per decision).
 */
export const EXPIRY_ACTOR = "service:risk-expiry";

export interface StaleDecision {
  id: string;
  status: "PENDING" | "APPROVED_FOR_REVIEW";
  decisionVersion: number;
  createdAt: Date;
  expiresAt: Date;
  ageSeconds: number;
  symbol: string;
  signalId: string | null;
  optionsClaimId: string | null;
  plannedMaxLossAmount: string | null;
}

export type ExpireOutcome = { id: string; expiredId?: string; result: "expired" | "already_expired" | "not_found" | "not_latest" | "not_expirable" | "not_yet_stale" };

export async function databaseNow(db: Db): Promise<Date> {
  const r = await db.execute(sql`select now() as n`);
  return new Date((r.rows[0] as { n: string | Date }).n);
}

/** SQL condition: the latest version of a decision that is still within its validity window at `asOf` (used by the portfolio to exclude expired decisions). */
export function freshCondition(asOf: Date, config: ExpiryConfig) {
  const p = new Date(asOf.getTime() - (validityMs("PENDING", config) as number)).toISOString();
  const a = new Date(asOf.getTime() - (validityMs("APPROVED_FOR_REVIEW", config) as number)).toISOString();
  return sql`((status = 'PENDING' and created_at > ${p}::timestamptz) or (status = 'APPROVED_FOR_REVIEW' and created_at > ${a}::timestamptz))`;
}

export function isStale(d: Pick<RiskDecisionRecord, "status" | "createdAt">, asOf: Date, config: ExpiryConfig): boolean {
  const w = validityMs(d.status, config);
  return w !== null && d.createdAt.getTime() + w <= asOf.getTime();
}

export async function listStaleRiskDecisions(db: Db, opts: { config?: ExpiryConfig; asOf?: Date; limit?: number } = {}): Promise<StaleDecision[]> {
  const config = opts.config ?? loadExpiryConfig();
  const asOf = opts.asOf ?? (await databaseNow(db));
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const p = new Date(asOf.getTime() - (validityMs("PENDING", config) as number)).toISOString();
  const a = new Date(asOf.getTime() - (validityMs("APPROVED_FOR_REVIEW", config) as number)).toISOString();
  const r = await db.execute(sql`select id, status, decision_version, created_at, symbol, signal_id, options_claim_id, planned_max_loss_amount from risk_decisions_effective
    where superseded_by_id is null and ((status = 'PENDING' and created_at <= ${p}::timestamptz) or (status = 'APPROVED_FOR_REVIEW' and created_at <= ${a}::timestamptz)) order by created_at, chain_index limit ${limit}`);
  return (r.rows as Array<Record<string, unknown>>).map((row) => {
    const status = String(row["status"]) as StaleDecision["status"];
    const createdAt = new Date(row["created_at"] as string);
    const expiresAt = new Date(createdAt.getTime() + (validityMs(status, config) as number));
    return {
      id: String(row["id"]), status, decisionVersion: Number(row["decision_version"]), createdAt, expiresAt, ageSeconds: Math.floor((asOf.getTime() - createdAt.getTime()) / 1000), symbol: String(row["symbol"]),
      signalId: (row["signal_id"] as string | null) ?? null, optionsClaimId: (row["options_claim_id"] as string | null) ?? null, plannedMaxLossAmount: row["planned_max_loss_amount"] === null ? null : String(row["planned_max_loss_amount"]),
    };
  });
}

const asNum = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Appends the EXPIRED version for one decision if (and only if) it is the latest version and stale at `asOf`. */
export async function expireRiskDecision(db: Db, decisionId: string, opts: { config?: ExpiryConfig; asOf?: Date } = {}): Promise<ExpireOutcome> {
  const config = opts.config ?? loadExpiryConfig();
  const asOf = opts.asOf ?? (await databaseNow(db));
  const prev = await getRiskDecision(db, decisionId);
  if (!prev) return { id: decisionId, result: "not_found" };
  if (prev.supersededById) {
    const successor = await getRiskDecision(db, prev.supersededById);
    return successor && successor.status === "EXPIRED" && successor.createdBy === EXPIRY_ACTOR && successor.supersedesId === prev.id ? { id: prev.id, expiredId: successor.id, result: "already_expired" } : { id: prev.id, result: "not_latest" };
  }
  if (prev.status !== "PENDING" && prev.status !== "APPROVED_FOR_REVIEW") return { id: prev.id, result: "not_expirable" };
  if (!isStale(prev, asOf, config)) return { id: prev.id, result: "not_yet_stale" };
  const windowMinutes = prev.status === "PENDING" ? config.pendingMinutes : config.approvedForReviewMinutes;
  const expiry = { previousStatus: prev.status, previousVersion: prev.decisionVersion, versionCreatedAt: prev.createdAt.toISOString(), validityMinutes: windowMinutes, expiredAsOf: asOf.toISOString() };
  try {
    const out = await supersedeRiskDecision(db, prev.id, {
      stopLossValidationId: prev.stopLossValidationId,
      status: "EXPIRED",
      idempotencyKey: `risk-expiry:${prev.id}`,
      createdBy: EXPIRY_ACTOR,
      instrumentType: prev.instrumentType,
      market: prev.market,
      symbol: prev.symbol,
      expiry: prev.expiry,
      strike: asNum(prev.strike),
      optionType: prev.optionType,
      side: prev.side,
      entryPrice: asNum(prev.entryPrice),
      stopLoss: asNum(prev.stopLoss),
      stopLossBasis: prev.stopLossBasis,
      target1: asNum(prev.target1),
      target2: asNum(prev.target2),
      target3: asNum(prev.target3),
      plannedQuantity: asNum(prev.plannedQuantity),
      plannedNotional: asNum(prev.plannedNotional),
      plannedMaxLossAmount: asNum(prev.plannedMaxLossAmount),
      plannedMaxLossPercent: asNum(prev.plannedMaxLossPercent),
      confidenceScore: asNum(prev.confidenceScore),
      sourceTrustTier: prev.sourceTrustTier,
      decisionReasonCode: prev.status === "PENDING" ? "expired_pending" : "expired_approved_for_review",
      decisionReason: `The ${prev.status} decision was not acted on within its ${windowMinutes}-minute validity window and no longer counts toward portfolio exposure.`,
      inputSnapshot: { expiry, previousDecisionId: prev.id },
      outputSnapshot: { ...((prev.outputSnapshot as Record<string, unknown> | null) ?? {}), stage: "expired", expiry },
      evidenceReferences: { ...((prev.evidenceReferences as Record<string, unknown> | null) ?? {}), previousDecisionId: prev.id },
    }, { riskReducing: true });
    return { id: prev.id, expiredId: out.id, result: out.created ? "expired" : "already_expired" };
  } catch (error) {
    // a concurrent expirer (or any other writer) appended the successor first: the unique successor index refuses the second one
    if (error instanceof RiskDecisionError && (error.code === "not_latest_version" || error.code === "idempotency_conflict")) {
      const again = await getRiskDecision(db, prev.id);
      const successor = again?.supersededById ? await getRiskDecision(db, again.supersededById) : undefined;
      return successor?.status === "EXPIRED" ? { id: prev.id, expiredId: successor.id, result: "already_expired" } : { id: prev.id, result: "not_latest" };
    }
    throw error;
  }
}

export interface ExpireRunResult { asOf: Date; examined: number; expired: string[]; alreadyExpired: number; skipped: Array<{ id: string; result: string }>; dryRun: boolean }

/** The job and the operational command: expire every stale decision (or only list them with dryRun). One failure does not stop the rest. */
export async function expireStaleRiskDecisions(db: Db, opts: { config?: ExpiryConfig; asOf?: Date; limit?: number; dryRun?: boolean } = {}): Promise<ExpireRunResult> {
  const config = opts.config ?? loadExpiryConfig();
  const asOf = opts.asOf ?? (await databaseNow(db));
  const stale = await listStaleRiskDecisions(db, { config, asOf, ...(opts.limit === undefined ? {} : { limit: opts.limit }) });
  const run: ExpireRunResult = { asOf, examined: stale.length, expired: [], alreadyExpired: 0, skipped: [], dryRun: opts.dryRun === true };
  if (run.dryRun) return run;
  for (const d of stale) {
    const r = await expireRiskDecision(db, d.id, { config, asOf });
    if (r.result === "expired" && r.expiredId) run.expired.push(r.expiredId);
    else if (r.result === "already_expired") run.alreadyExpired += 1;
    else run.skipped.push({ id: d.id, result: r.result });
  }
  return run;
}
