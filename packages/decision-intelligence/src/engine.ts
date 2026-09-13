import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { assembleSignalIntelligence, type AssembleSignalIntelligenceOptions } from "@twins/signals";
import type { Db } from "./db";
import { decide, type DecideOptions } from "./decide";
import { persistDecisionIntelligence } from "./persist";
import type { DecisionIntelligenceResult } from "./types";

export interface ValidateSignalOptions {
  intelligence?: AssembleSignalIntelligenceOptions;
  decide?: DecideOptions;
}

export interface ValidateSignalOutcome {
  validationId: string;
  result: DecisionIntelligenceResult;
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
  const [signal] = await db.select().from(schema.signals).where(eq(schema.signals.id, signalId));
  if (!signal) throw new Error(`signals row not found: ${signalId}`);

  const [instrument] = await db
    .select()
    .from(schema.instruments)
    .where(eq(schema.instruments.id, signal.instrumentId));

  const report = await assembleSignalIntelligence(db, signalId, options.intelligence);
  const result = decide(signal, instrument ?? null, report, options.decide);

  const validationId = await persistDecisionIntelligence(db, result);

  await db
    .update(schema.signals)
    .set({ status: "decided", updatedAt: new Date() })
    .where(eq(schema.signals.id, signalId));

  return { validationId, result };
}
