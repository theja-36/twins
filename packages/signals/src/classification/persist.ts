import { schema } from "@twins/database";
import type { Db } from "../db";
import type { ClassificationResult } from "./types";

/**
 * Stores one classification (append-only `signal_classifications`). Idempotent per (claim, classifier version): a re-run records nothing new and reports `false`.
 * The row carries structure and cue CODES only; message text is never written here.
 */
export async function storeClassification(db: Db, claimId: string, r: ClassificationResult): Promise<boolean> {
  const rows = await db.insert(schema.signalClassifications).values({
    claimId, signalType: r.signalType, horizon: r.horizon, setup: r.setup, riskProfile: r.riskProfile,
    entryCondition: { ...r.entryCondition, evidenceCodes: r.evidenceCodes, context: r.context }, exitPattern: r.exitPattern,
    structureValid: r.structureValid, confidence: String(r.confidence), classifierVersion: r.classifierVersion,
  }).onConflictDoNothing({ target: [schema.signalClassifications.claimId, schema.signalClassifications.classifierVersion] }).returning({ id: schema.signalClassifications.id });
  return rows.length === 1;
}
