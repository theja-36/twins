import { schema } from "@twins/database";
import type { Db } from "./db";
import type { DecisionIntelligenceResult } from "./types";

export async function persistDecisionIntelligence(db: Db, result: DecisionIntelligenceResult): Promise<string> {
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
      validatedAt: result.validatedAt,
    })
    .returning({ id: schema.signalValidations.id });
  if (!row) throw new Error("failed to persist signal_validations row");
  return row.id;
}
