import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import type { DecisionIntelligenceResult } from "./types";

export interface PersistOutcome {
  id: string;
  /** True when an existing row with the same idempotency key was reused (nothing inserted). */
  reused: boolean;
}

/** Returns the validation id already stored for an idempotency key, if any. */
export async function findValidationByKey(db: Db, key: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: schema.signalValidations.id })
    .from(schema.signalValidations)
    .where(eq(schema.signalValidations.idempotencyKey, key));
  return row?.id;
}

export async function persistDecisionIntelligence(
  db: Db,
  result: DecisionIntelligenceResult,
  idempotencyKey?: string,
): Promise<PersistOutcome> {
  const [row] = await db
    .insert(schema.signalValidations)
    .values({
      signalId: result.signalId,
      outcome: result.outcome,
      decisionConfidence: result.decisionConfidence.toString(),
      confidenceLabel: result.confidenceLabel,
      bullThesis: result.bullThesis,
      bearThesis: result.bearThesis,
      counterThesis: result.counterThesis,
      counterThesisSeverity: result.counterThesis.severity,
      sourceReliability: result.sourceReliability.level,
      sourceReliabilityReason: result.sourceReliability.reason,
      rationale: result.rationale,
      idempotencyKey: idempotencyKey ?? null,
      validatedAt: result.validatedAt,
    })
    .onConflictDoNothing({ target: schema.signalValidations.idempotencyKey })
    .returning({ id: schema.signalValidations.id });
  if (row) return { id: row.id, reused: false };
  if (!idempotencyKey) throw new Error("failed to persist signal_validations row");
  // Lost a race on the idempotency key: reuse the canonical row.
  const existing = await findValidationByKey(db, idempotencyKey);
  if (!existing) throw new Error("signal_validations conflicted but canonical row not found");
  return { id: existing, reused: true };
}
