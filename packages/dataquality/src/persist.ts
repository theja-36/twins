import { schema } from "@twins/database";
import type { Db } from "./db";
import type { QualityAssessmentResult } from "./types";

export async function persistAssessment(
  db: Db,
  assessment: QualityAssessmentResult,
): Promise<string> {
  const [row] = await db
    .insert(schema.qualityAssessments)
    .values({
      entityType: assessment.entityType,
      entityId: assessment.entityId,
      source: assessment.source,
      overallStatus: assessment.overallStatus,
      qualityScore: assessment.qualityScore.toString(),
      dimensions: assessment.dimensions,
      reasons: assessment.reasons,
      evaluatedAt: assessment.evaluatedAt,
    })
    .returning({ id: schema.qualityAssessments.id });
  if (!row) throw new Error("failed to persist quality assessment");
  return row.id;
}
