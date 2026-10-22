import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { assembleSignalIntelligence, type AssembleSignalIntelligenceOptions } from "@twins/signals";
import type { Db } from "./db";
import { decide, type DecideOptions } from "./decide";
import { findValidationByKey, persistDecisionIntelligence } from "./persist";
import type { DecisionIntelligenceResult } from "./types";

export interface ValidateSignalOptions {
  intelligence?: AssembleSignalIntelligenceOptions;
  decide?: DecideOptions;
  /**
   * Makes this validation idempotent for a retried/duplicated trigger: at most one
   * row exists per key. Omit for ordinary re-validation, which appends history.
   */
  idempotencyKey?: string;
  /**
   * Explicit analysis as-of time. Evidence received after it is excluded and it is the "now" of the structural
   * age check unless `decide.now` is set. Omit for "everything received so far, now = current time".
   */
  asOf?: Date;
}

export interface ValidateSignalOutcome {
  /** Canonical stored validation row. */
  validationId: string;
  /** The single effective as-of time used for BOTH evidence selection and the decision clock (absent on a reused keyed row). */
  asOf?: Date;
  /**
   * This call's computed decision. Absent when an existing keyed row was reused
   * without recomputation. If another concurrent caller won the key, this is
   * THIS call's computation, not necessarily what was stored - use validationId.
   */
  result?: DecisionIntelligenceResult;
  reused: boolean;
}

/**
 * The effective as-of time: any of `asOf`, `intelligence.asOf`, `decide.now` that are set must be the same instant
 * (a silent disagreement between the evidence cutoff and the decision clock is refused); none set means "now".
 */
export function resolveEffectiveAsOf(options: ValidateSignalOptions): Date {
  const set = [options.asOf, options.intelligence?.asOf, options.decide?.now].filter((d): d is Date => d instanceof Date);
  const first = set[0];
  if (!first) return new Date();
  if (set.some((d) => d.getTime() !== first.getTime())) {
    throw new Error("validateSignal: asOf, intelligence.asOf and decide.now disagree; they must be the same instant");
  }
  return new Date(first.getTime());
}

/**
 * The Phase 9 entry point: Signal -> [Phase 8: assembleSignalIntelligence]
 * -> Decision Context -> ... -> Explainable Decision -> Persisted Audit
 * Record. This is the only function in this package that touches the
 * database or Phase 8; everything else (decide(), buildBullThesis(),
 * etc.) is a pure function so the decision RULES are directly
 * unit-testable without Postgres.
 *
 * Marks the signal `decided` (spec section: signals.status already has
 * this value from Phase 2 - no schema change needed) once a validation
 * row is persisted. Never writes to `decisions`/`risk_decisions` (those
 * belong to a later trade-direction Decision Engine / Risk Engine) and
 * never creates an order, computes a position size, or picks a trade
 * direction.
 */
export async function validateSignal(
  db: Db,
  signalId: string,
  options: ValidateSignalOptions = {},
): Promise<ValidateSignalOutcome> {
  if (options.idempotencyKey) {
    const existingId = await findValidationByKey(db, options.idempotencyKey);
    if (existingId) return { validationId: existingId, reused: true };
  }

  const [signal] = await db.select().from(schema.signals).where(eq(schema.signals.id, signalId));
  if (!signal) throw new Error(`signals row not found: ${signalId}`);

  const [instrument] = await db
    .select()
    .from(schema.instruments)
    .where(eq(schema.instruments.id, signal.instrumentId));

  // ONE effective as-of time drives evidence selection (received-by / observed bounds) and the decision clock.
  const asOf = resolveEffectiveAsOf(options);
  const report = await assembleSignalIntelligence(db, signalId, { ...options.intelligence, asOf });
  const result = decide(signal, instrument ?? null, report, { ...options.decide, now: asOf });

  const persisted = await persistDecisionIntelligence(db, result, options.idempotencyKey);
  const validationId = persisted.id;

  await db
    .update(schema.signals)
    .set({ status: "decided", updatedAt: new Date() })
    .where(eq(schema.signals.id, signalId));

  return { validationId, asOf, result, reused: persisted.reused };
}
