import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { evaluateSafety } from "@twins/runtime-state";

/**
 * Risk decisions (Stage 3 / Task 1). The ONLY production code that writes the `risk_decisions` table. A risk decision is the mandatory link between a
 * parsed signal / options claim, its stop-loss validation evidence and every later stage; rows are immutable (append-only, hash-chained in the
 * database) and a revision is a NEW row that supersedes the old one. This module does no sizing, applies no portfolio limits and sends no approval.
 */
export const RISK_DECISION_STATUSES = ["PENDING", "APPROVED_FOR_REVIEW", "REJECTED", "EXPIRED", "SUPERSEDED"] as const;
export type RiskDecisionStatus = (typeof RISK_DECISION_STATUSES)[number];
/** SUPERSEDED is derived (a successor exists); it can never be requested. */
export type WritableRiskStatus = Exclude<RiskDecisionStatus, "SUPERSEDED">;

export type RiskErrorCode =
  | "invalid_input"
  | "safety_refused"
  | "stop_loss_evidence_missing"
  | "stop_loss_subject_mismatch"
  | "stop_loss_not_valid"
  | "stop_loss_not_latest"
  | "decision_exists"
  | "idempotency_conflict"
  | "not_found"
  | "not_latest_version"
  | "store_failure"
  | "not_sizable"
  | "capital_not_configured";

/** Fixed code + message naming the rule, never a driver message or a value. `cause` keeps the safety refusal for callers that must map it. */
export class RiskDecisionError extends Error {
  constructor(readonly code: RiskErrorCode, message: string, readonly existingId?: string, readonly cause?: unknown) {
    super(message);
    this.name = "RiskDecisionError";
  }
}

export type RiskSubject = { kind: "signal"; signalId: string } | { kind: "options_claim"; optionsClaimId: string };

export interface RiskDecisionInput {
  subject: RiskSubject;
  /** Mandatory: the stop-loss validation this decision rests on. */
  stopLossValidationId: string;
  status: WritableRiskStatus;
  /** Retrying the same creation with the same key returns the same row. */
  idempotencyKey: string;
  /** `service:<name>` or `operator:<name>`. */
  createdBy: string;
  instrumentType: string;
  market?: string | null;
  symbol: string;
  expiry?: string | null; // YYYY-MM-DD
  strike?: number | null;
  optionType?: string | null;
  side?: string | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  stopLossBasis?: string | null;
  target1?: number | null;
  target2?: number | null;
  target3?: number | null;
  /** Position sizing (Stage 3 / Task 2). Written only by the sizing module; absent (NULL) on decisions that have not been sized. */
  plannedQuantity?: number | null;
  plannedNotional?: number | null;
  plannedMaxLossAmount?: number | null;
  plannedMaxLossPercent?: number | null;
  confidenceScore?: number | null;
  sourceTrustTier?: string | null;
  decisionReasonCode: string;
  decisionReason?: string | null;
  /** COMPLETE inputs the decision was made from. Must be a non-empty object. */
  inputSnapshot: Record<string, unknown>;
  outputSnapshot?: Record<string, unknown> | null;
  /** Ids of the records the decision rests on (the stop-loss validation id is added automatically). */
  evidenceReferences?: Record<string, unknown>;
}

export interface RiskDecisionRecord {
  id: string;
  signalId: string | null;
  optionsClaimId: string | null;
  stopLossValidationId: string;
  supersedesId: string | null;
  decisionVersion: number;
  status: RiskDecisionStatus;
  /** SUPERSEDED when a successor exists, else the stored status. */
  effectiveStatus: RiskDecisionStatus;
  supersededById: string | null;
  supersededAt: Date | null;
  idempotencyKey: string;
  instrumentType: string;
  market: string | null;
  symbol: string;
  expiry: string | null;
  strike: string | null;
  optionType: string | null;
  side: string | null;
  entryPrice: string | null;
  stopLoss: string | null;
  stopLossBasis: string | null;
  target1: string | null;
  target2: string | null;
  target3: string | null;
  plannedQuantity: string | null;
  plannedNotional: string | null;
  plannedMaxLossAmount: string | null;
  plannedMaxLossPercent: string | null;
  plannedRiskRewardRatio: string | null;
  confidenceScore: string | null;
  sourceTrustTier: string | null;
  decisionReasonCode: string;
  decisionReason: string | null;
  inputSnapshot: unknown;
  outputSnapshot: unknown;
  evidenceReferences: unknown;
  createdAt: Date;
  createdBy: string;
  chainIndex: number;
}

export interface CreateOutcome {
  id: string;
  /** false: an earlier request with the same idempotency key already created it; nothing was written. */
  created: boolean;
  decisionVersion: number;
  status: WritableRiskStatus;
}

const ACTOR = /^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$/;
const CODE = /^[a-z][a-z0-9_]{2,60}$/;
const KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));

function positive(name: string, v: number | null | undefined): void {
  if (v !== null && v !== undefined && !(Number.isFinite(v) && v > 0)) throw new RiskDecisionError("invalid_input", `${name} must be a positive number`);
}

/** Pure: reward-to-risk of the first target against the stop, 6 decimals; null unless entry, stop and first target are all known and the risk distance is positive. */
export function computeRiskReward(entry: number | null | undefined, stop: number | null | undefined, target1: number | null | undefined): number | null {
  if (!entry || !stop || !target1) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return Math.round((Math.abs(target1 - entry) / risk) * 1e6) / 1e6;
}

export function validateRiskDecisionInput(input: RiskDecisionInput): void {
  if (!(RISK_DECISION_STATUSES as readonly string[]).includes(input.status) || (input.status as string) === "SUPERSEDED") throw new RiskDecisionError("invalid_input", "status must be PENDING, APPROVED_FOR_REVIEW, REJECTED or EXPIRED (SUPERSEDED is derived)");
  const subjectId = input.subject.kind === "signal" ? input.subject.signalId : input.subject.optionsClaimId;
  if (!UUID.test(subjectId ?? "") || !UUID.test(input.stopLossValidationId ?? "")) throw new RiskDecisionError("invalid_input", "subject and stop-loss validation ids must be UUIDs");
  if (!KEY.test(input.idempotencyKey ?? "")) throw new RiskDecisionError("invalid_input", "idempotencyKey must be 8-200 safe characters");
  if (!ACTOR.test(input.createdBy ?? "")) throw new RiskDecisionError("invalid_input", "createdBy must be service:<name> or operator:<name>");
  if (!CODE.test(input.decisionReasonCode ?? "")) throw new RiskDecisionError("invalid_input", "decisionReasonCode must be a snake_case code");
  if (!input.instrumentType || !input.symbol) throw new RiskDecisionError("invalid_input", "instrumentType and symbol are required");
  if (input.expiry != null && !DATE.test(input.expiry)) throw new RiskDecisionError("invalid_input", "expiry must be YYYY-MM-DD");
  if (!input.inputSnapshot || typeof input.inputSnapshot !== "object" || Array.isArray(input.inputSnapshot) || Object.keys(input.inputSnapshot).length === 0) throw new RiskDecisionError("invalid_input", "a complete, non-empty inputSnapshot is required");
  for (const [n, v] of [["entryPrice", input.entryPrice], ["stopLoss", input.stopLoss], ["target1", input.target1], ["target2", input.target2], ["target3", input.target3], ["strike", input.strike]] as const) positive(n, v);
  for (const [n, v] of [["plannedQuantity", input.plannedQuantity], ["plannedNotional", input.plannedNotional], ["plannedMaxLossAmount", input.plannedMaxLossAmount], ["plannedMaxLossPercent", input.plannedMaxLossPercent]] as const) {
    if (v != null && !(Number.isFinite(v) && v >= 0)) throw new RiskDecisionError("invalid_input", `${n} must be a non-negative number`);
  }
  if (input.confidenceScore != null && !(input.confidenceScore >= 0 && input.confidenceScore <= 100)) throw new RiskDecisionError("invalid_input", "confidenceScore must be between 0 and 100");
  if (input.status === "APPROVED_FOR_REVIEW" && (input.stopLoss == null || input.entryPrice == null || !input.stopLossBasis)) throw new RiskDecisionError("stop_loss_not_valid", "APPROVED_FOR_REVIEW requires a stop-loss, an entry price and a stop-loss basis");
}

export async function refuseUnlessSafe(operation: string): Promise<void> {
  // Fail closed: an unreadable state refuses too. Creating a risk decision is intake-class work, so the intake controls (which include the kill switch) apply.
  let refusal;
  try {
    refusal = await evaluateSafety("intake", operation);
  } catch (cause) {
    throw new RiskDecisionError("safety_refused", "the runtime safety state could not be evaluated", undefined, cause);
  }
  if (refusal) throw new RiskDecisionError("safety_refused", `refused by the runtime safety state (${refusal.reason})`, undefined, refusal);
}

type EvidenceRow = { id: string; signalId: string | null; optionsClaimId: string | null; result: string; chainIndex: number };

async function loadEvidence(db: Db, id: string): Promise<EvidenceRow | undefined> {
  const r = await db.execute(sql`select id, signal_id, options_claim_id, result, chain_index from stop_loss_validations where id = ${id}`);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? { id: String(row["id"]), signalId: (row["signal_id"] as string | null) ?? null, optionsClaimId: (row["options_claim_id"] as string | null) ?? null, result: String(row["result"]), chainIndex: Number(row["chain_index"]) } : undefined;
}

function map(r: Record<string, unknown>): RiskDecisionRecord {
  const s = (k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    id: String(r["id"]), signalId: s("signal_id"), optionsClaimId: s("options_claim_id"), stopLossValidationId: String(r["stop_loss_validation_id"]), supersedesId: s("supersedes_id"),
    decisionVersion: Number(r["decision_version"]), status: String(r["status"]) as RiskDecisionStatus, effectiveStatus: String(r["effective_status"]) as RiskDecisionStatus,
    supersededById: s("superseded_by_id"), supersededAt: r["superseded_at"] ? new Date(r["superseded_at"] as string) : null, idempotencyKey: String(r["idempotency_key"]),
    instrumentType: String(r["instrument_type"]), market: s("market"), symbol: String(r["symbol"]), expiry: r["expiry"] ? new Date(r["expiry"] as string).toISOString().slice(0, 10) : null,
    strike: s("strike"), optionType: s("option_type"), side: s("side"), entryPrice: s("entry_price"), stopLoss: s("stop_loss"), stopLossBasis: s("stop_loss_basis"),
    target1: s("target_1"), target2: s("target_2"), target3: s("target_3"), plannedQuantity: s("planned_quantity"), plannedNotional: s("planned_notional"),
    plannedMaxLossAmount: s("planned_max_loss_amount"), plannedMaxLossPercent: s("planned_max_loss_percent"), plannedRiskRewardRatio: s("planned_risk_reward_ratio"),
    confidenceScore: s("confidence_score"), sourceTrustTier: s("source_trust_tier"), decisionReasonCode: String(r["decision_reason_code"]), decisionReason: s("decision_reason"),
    inputSnapshot: r["input_snapshot"], outputSnapshot: r["output_snapshot"], evidenceReferences: r["evidence_references"], createdAt: new Date(r["created_at"] as string),
    createdBy: String(r["created_by"]), chainIndex: Number(r["chain_index"]),
  };
}

export async function getRiskDecision(db: Db, id: string): Promise<RiskDecisionRecord | undefined> {
  if (!UUID.test(id)) throw new RiskDecisionError("invalid_input", "id must be a UUID");
  const r = await db.execute(sql`select * from risk_decisions_effective where id = ${id}`);
  return r.rows[0] ? map(r.rows[0] as Record<string, unknown>) : undefined;
}

export interface ListFilter {
  signalId?: string;
  optionsClaimId?: string;
  /** Matched against the EFFECTIVE status (so SUPERSEDED finds revised decisions). */
  status?: RiskDecisionStatus;
  limit?: number;
}

export async function listRiskDecisions(db: Db, filter: ListFilter = {}): Promise<RiskDecisionRecord[]> {
  for (const v of [filter.signalId, filter.optionsClaimId]) if (v !== undefined && !UUID.test(v)) throw new RiskDecisionError("invalid_input", "ids must be UUIDs");
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const where = [
    filter.signalId ? sql`signal_id = ${filter.signalId}` : sql`true`,
    filter.optionsClaimId ? sql`options_claim_id = ${filter.optionsClaimId}` : sql`true`,
    filter.status ? sql`effective_status = ${filter.status}` : sql`true`,
  ];
  const r = await db.execute(sql`select * from risk_decisions_effective where ${sql.join(where, sql` and `)} order by chain_index desc limit ${limit}`);
  return (r.rows as Array<Record<string, unknown>>).map(map);
}

/** The newest version (the one nothing supersedes) for a signal, or undefined. */
export async function getLatestRiskDecisionForSignal(db: Db, signalId: string): Promise<RiskDecisionRecord | undefined> {
  if (!UUID.test(signalId)) throw new RiskDecisionError("invalid_input", "signalId must be a UUID");
  const r = await db.execute(sql`select * from risk_decisions_effective where signal_id = ${signalId} and superseded_by_id is null order by decision_version desc limit 1`);
  return r.rows[0] ? map(r.rows[0] as Record<string, unknown>) : undefined;
}

export async function getLatestRiskDecisionForOptionsClaim(db: Db, optionsClaimId: string): Promise<RiskDecisionRecord | undefined> {
  if (!UUID.test(optionsClaimId)) throw new RiskDecisionError("invalid_input", "optionsClaimId must be a UUID");
  const r = await db.execute(sql`select * from risk_decisions_effective where options_claim_id = ${optionsClaimId} and superseded_by_id is null order by decision_version desc limit 1`);
  return r.rows[0] ? map(r.rows[0] as Record<string, unknown>) : undefined;
}

/** Creates version 1 for a subject. Idempotent by `idempotencyKey`; a second, different decision for the same subject must be a revision (supersedeRiskDecision). */
export async function createRiskDecision(db: Db, input: RiskDecisionInput): Promise<CreateOutcome> {
  return insertDecision(db, input, undefined);
}

export type RevisionInput = Omit<RiskDecisionInput, "subject">;

/** Appends a new version that supersedes `previousId` (which must be the latest, un-superseded version). The old row is not touched: its SUPERSEDED state is derived. */
export async function supersedeRiskDecision(db: Db, previousId: string, revision: RevisionInput): Promise<CreateOutcome> {
  const prev = await getRiskDecision(db, previousId);
  if (!prev) throw new RiskDecisionError("not_found", "the decision to supersede does not exist");
  if (prev.supersededById) throw new RiskDecisionError("not_latest_version", "that decision has already been superseded", prev.supersededById);
  const subject: RiskSubject = prev.signalId ? { kind: "signal", signalId: prev.signalId } : { kind: "options_claim", optionsClaimId: prev.optionsClaimId as string };
  return insertDecision(db, { ...revision, subject }, prev);
}

async function insertDecision(db: Db, input: RiskDecisionInput, previous: RiskDecisionRecord | undefined): Promise<CreateOutcome> {
  validateRiskDecisionInput(input);
  await refuseUnlessSafe(previous ? "risk_decision.supersede" : "risk_decision.create");

  // Idempotent retry: the same key returns the stored decision, but only if it is the same request (same subject, evidence and status).
  const existing = await findByKey(db, input.idempotencyKey);
  if (existing) return sameRequest(existing, input);

  let evidence: EvidenceRow | undefined;
  try {
    evidence = await loadEvidence(db, input.stopLossValidationId);
  } catch (cause) {
    throw new RiskDecisionError("store_failure", "the stop-loss evidence could not be read", undefined, cause);
  }
  if (!evidence) throw new RiskDecisionError("stop_loss_evidence_missing", "the stop-loss validation evidence does not exist");
  const subjectSignal = input.subject.kind === "signal" ? input.subject.signalId : null;
  const subjectClaim = input.subject.kind === "options_claim" ? input.subject.optionsClaimId : null;
  if ((evidence.signalId ?? null) !== subjectSignal || (evidence.optionsClaimId ?? null) !== subjectClaim) throw new RiskDecisionError("stop_loss_subject_mismatch", "the stop-loss validation belongs to a different signal or options claim");
  if (input.status === "APPROVED_FOR_REVIEW" && evidence.result !== "VALID") throw new RiskDecisionError("stop_loss_not_valid", `APPROVED_FOR_REVIEW requires a VALID stop-loss validation (got ${evidence.result})`);

  const evidenceReferences = { ...(input.evidenceReferences ?? {}), stopLossValidationId: input.stopLossValidationId, stopLossResult: evidence.result };
  const values = {
    signalId: subjectSignal,
    optionsClaimId: subjectClaim,
    stopLossValidationId: input.stopLossValidationId,
    supersedesId: previous?.id ?? null,
    decisionVersion: (previous?.decisionVersion ?? 0) + 1,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    instrumentType: input.instrumentType,
    market: input.market ?? null,
    symbol: input.symbol,
    expiry: input.expiry ?? null,
    strike: num(input.strike),
    optionType: input.optionType ?? null,
    side: input.side ?? null,
    entryPrice: num(input.entryPrice),
    stopLoss: num(input.stopLoss),
    stopLossBasis: input.stopLossBasis ?? null,
    target1: num(input.target1),
    target2: num(input.target2),
    target3: num(input.target3),
    // Sizing is computed by the sizing module (pure engine) and passed in; this writer stores it verbatim. Portfolio exposure is a later stage.
    plannedQuantity: num(input.plannedQuantity),
    plannedNotional: num(input.plannedNotional),
    plannedMaxLossAmount: num(input.plannedMaxLossAmount),
    plannedMaxLossPercent: num(input.plannedMaxLossPercent),
    plannedRiskRewardRatio: num(computeRiskReward(input.entryPrice, input.stopLoss, input.target1)),
    confidenceScore: num(input.confidenceScore),
    sourceTrustTier: input.sourceTrustTier ?? null,
    decisionReasonCode: input.decisionReasonCode,
    decisionReason: input.decisionReason ?? null,
    inputSnapshot: input.inputSnapshot,
    outputSnapshot: input.outputSnapshot ?? null,
    evidenceReferences,
    createdBy: input.createdBy,
  };
  try {
    const [row] = await db.insert(schema.riskDecisions).values(values).onConflictDoNothing({ target: schema.riskDecisions.idempotencyKey }).returning({ id: schema.riskDecisions.id });
    if (row) return { id: row.id, created: true, decisionVersion: values.decisionVersion, status: input.status };
    const raced = await findByKey(db, input.idempotencyKey);
    if (raced) return sameRequest(raced, input);
    throw new RiskDecisionError("store_failure", "the decision conflicted but the canonical row was not found");
  } catch (error) {
    if (error instanceof RiskDecisionError) throw error;
    // drizzle wraps the driver error: the SQLSTATE and constraint live on `.cause`
    const pgErr = ((error as { cause?: unknown } | null)?.cause ?? error) as { code?: string; constraint?: string } | null;
    const code = pgErr?.code;
    const constraint = pgErr?.constraint ?? "";
    if (code === "23505") {
      if (/first_(signal|claim)_unique/.test(constraint)) {
        const latest = input.subject.kind === "signal" ? await getLatestRiskDecisionForSignal(db, input.subject.signalId) : await getLatestRiskDecisionForOptionsClaim(db, input.subject.optionsClaimId);
        throw new RiskDecisionError("decision_exists", "a risk decision already exists for this subject; create a revision with supersedeRiskDecision", latest?.id);
      }
      if (/supersedes_unique/.test(constraint)) throw new RiskDecisionError("not_latest_version", "that decision has already been superseded");
    }
    // the database's own integrity triggers (evidence validity, subject match, version chain) arrive as check_violation / foreign_key_violation
    if (code === "23514") throw new RiskDecisionError(input.status === "APPROVED_FOR_REVIEW" ? "stop_loss_not_valid" : "invalid_input", "the database refused the decision (integrity rule)", undefined, error);
    if (code === "23503") throw new RiskDecisionError("stop_loss_evidence_missing", "a referenced record does not exist", undefined, error);
    throw new RiskDecisionError("store_failure", "the risk decision could not be stored", undefined, error);
  }
}

async function findByKey(db: Db, key: string): Promise<RiskDecisionRecord | undefined> {
  const [row] = await db.select({ id: schema.riskDecisions.id }).from(schema.riskDecisions).where(eq(schema.riskDecisions.idempotencyKey, key));
  return row ? getRiskDecision(db, row.id) : undefined;
}

function sameRequest(existing: RiskDecisionRecord, input: RiskDecisionInput): CreateOutcome {
  const sameSubject = input.subject.kind === "signal" ? existing.signalId === input.subject.signalId : existing.optionsClaimId === input.subject.optionsClaimId;
  if (!sameSubject || existing.stopLossValidationId !== input.stopLossValidationId || existing.status !== input.status) {
    throw new RiskDecisionError("idempotency_conflict", "that idempotency key was used for a different decision", existing.id);
  }
  return { id: existing.id, created: false, decisionVersion: existing.decisionVersion, status: existing.status as WritableRiskStatus };
}

/** Latest un-superseded decision of any kind for a (signal | claim) id pair; helper for callers that hold only an id. */
export async function latestVersionNumber(db: Db, subject: RiskSubject): Promise<number> {
  const col = subject.kind === "signal" ? schema.riskDecisions.signalId : schema.riskDecisions.optionsClaimId;
  const id = subject.kind === "signal" ? subject.signalId : subject.optionsClaimId;
  const [row] = await db.select({ v: schema.riskDecisions.decisionVersion }).from(schema.riskDecisions).where(and(eq(col, id))).orderBy(desc(schema.riskDecisions.decisionVersion)).limit(1);
  return row?.v ?? 0;
}
