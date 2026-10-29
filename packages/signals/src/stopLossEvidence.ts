import { eq, sql } from "drizzle-orm";
import { schema } from "@twins/database";
import type { StopLossValidation } from "@twins/stop-loss";
import type { Db } from "./db";

export type StopLossSubject = { kind: "signal"; signalId: string } | { kind: "options_claim"; optionsClaimId: string };

const num = (n: number | null): string | null => (n === null ? null : String(Number(n.toFixed(8))));

export interface StopLossEvidenceOutcome {
  id: string;
  /** True when an existing row with the same idempotency key was reused (nothing inserted). */
  reused: boolean;
}

/**
 * Appends the stop-loss validation result to the immutable, hash-chained audit trail (table stop_loss_validations): the original parsed stop-loss, the normalized
 * value, the entry/reference price, side, instrument type, option type, basis, risk distance, the bound used, the result and the machine-readable reason code.
 * Always an INSERT: the table is append-only. An idempotency key makes a retried validation reuse its row.
 */
export async function recordStopLossEvidence(db: Db, subject: StopLossSubject, v: StopLossValidation, idempotencyKey?: string): Promise<StopLossEvidenceOutcome> {
  const values = {
    subjectKind: subject.kind,
    signalId: subject.kind === "signal" ? subject.signalId : null,
    optionsClaimId: subject.kind === "options_claim" ? subject.optionsClaimId : null,
    idempotencyKey: idempotencyKey ?? null,
    ruleVersion: v.ruleVersion,
    result: v.result,
    reasonCode: v.reasonCode,
    detail: v.detail,
    instrumentType: v.instrumentType,
    instrumentKind: v.instrumentKind,
    side: v.side,
    optionType: v.optionType,
    levelBasis: v.levelBasis,
    originalStopLoss: v.originalStopLoss,
    normalizedStopLoss: num(v.normalizedStopLoss),
    entryPrice: num(v.entryPrice),
    riskDistance: num(v.riskDistance),
    riskPct: num(v.riskPct),
    maxRiskPct: num(v.maxRiskPct),
    maxRiskSource: v.maxRiskSource,
    expectedStopSide: v.expectedStopSide,
  };
  const [row] = await db.insert(schema.stopLossValidations).values(values).onConflictDoNothing({ target: schema.stopLossValidations.idempotencyKey }).returning({ id: schema.stopLossValidations.id });
  if (row) return { id: row.id, reused: false };
  if (!idempotencyKey) throw new Error("failed to persist stop_loss_validations row");
  const [existing] = await db.select({ id: schema.stopLossValidations.id }).from(schema.stopLossValidations).where(eq(schema.stopLossValidations.idempotencyKey, idempotencyKey));
  if (!existing) throw new Error("stop_loss_validations conflicted but the canonical row was not found");
  return { id: existing.id, reused: true };
}

export interface ValidationEligibility {
  validationId: string;
  /** True only for an APPROVE backed by a VALID stop-loss validation recorded no later than the verdict. Historical rows without evidence are NOT eligible. */
  approvalEligible: boolean;
  /** not_an_approval | legacy_no_stop_loss_evidence | stop_loss_valid | stop_loss_not_valid */
  note: string;
  stopLossResult: string | null;
  stopLossReasonCode: string | null;
}

/** Reads the eligibility of one stored verdict from the view signal_validation_eligibility (migration 0011). Nothing is rewritten; unknown = not eligible. */
export async function getValidationEligibility(db: Db, validationId: string): Promise<ValidationEligibility> {
  const result = await db.execute(sql`select validation_id, approval_eligible, eligibility_note, stop_loss_result, stop_loss_reason_code from signal_validation_eligibility where validation_id = ${validationId}`);
  const row = result.rows[0] as { approval_eligible: boolean; eligibility_note: string; stop_loss_result: string | null; stop_loss_reason_code: string | null } | undefined;
  if (!row) return { validationId, approvalEligible: false, note: "unknown_validation", stopLossResult: null, stopLossReasonCode: null };
  return { validationId, approvalEligible: row.approval_eligible === true, note: row.eligibility_note, stopLossResult: row.stop_loss_result, stopLossReasonCode: row.stop_loss_reason_code };
}
