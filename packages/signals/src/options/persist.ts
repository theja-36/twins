import { eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { assertIntakeEnabled } from "@twins/runtime-state";
import { recordStopLossEvidence } from "../stopLossEvidence";
import type { Db } from "../db";
import type { AssessmentReason, OptionsAssessment } from "./assess";
import type { OptionsContractMaster } from "./master";
import type { OptionsPremiumProvider } from "./premium";
import type { OptionAction, OptionsClaim } from "./types";

/**
 * What an options-style Telegram message turned out to be. A "claim" is a parsed (unverified) claim; "ambiguous" and
 * "unsupported" are kept as such with their detail - no complete claim is ever invented for them.
 */
export type OptionsIntake =
  | { kind: "claim"; claim: OptionsClaim }
  | { kind: "ambiguous"; directives: Array<{ direction: OptionAction; symbol: string }> }
  | { kind: "unsupported"; symbol: string; form: string };

export interface RecordOptionsIntakeInput {
  telegramMessageId: string;
  parserVersion: string;
  intake: OptionsIntake;
  /** Present only for a "claim". */
  assessment?: OptionsAssessment | undefined;
  /** The contract master ACTUALLY used for the assessment; null when none was configured. */
  master: OptionsContractMaster | null;
  /** The premium provider ACTUALLY used; null when none was configured. */
  premium: OptionsPremiumProvider | null;
}

export interface RecordOptionsIntakeResult {
  id: string;
  /** True only for the caller whose INSERT created the row. */
  created: boolean;
  /** On a retry: whether a freshly computed result differs from the stored one (the stored row is NEVER changed). */
  differsFromStored: boolean;
}

const NOT_ASSESSED: Record<"ambiguous" | "unsupported", AssessmentReason> = {
  ambiguous: { code: "directives.ambiguous", severity: "insufficient", description: "several distinct directives; not merged, guessed or assessed" },
  unsupported: { code: "underlying.unsupported_options_shape", severity: "insufficient", description: "strong options structure with an underlying other than NIFTY, BANKNIFTY or SENSEX; not mapped, corrected or assessed" },
};

/**
 * Records an unverified options intake for (message, parser version). Idempotent and append-only: a retry returns the
 * existing row and never overwrites it (a changed result is reported via `differsFromStored`, not applied).
 * Never creates a signal, instrument, approval or order.
 */
export async function recordOptionsIntake(db: Db, input: RecordOptionsIntakeInput): Promise<RecordOptionsIntakeResult> {
  // Runtime safety boundary (Stage 1 / Task 2): no new claim row while intake is disabled, the kill switch is active, or the state is unreadable.
  await assertIntakeEnabled("signals.recordOptionsIntake");
  const { intake } = input;
  const assessed = intake.kind === "claim" ? input.assessment : undefined;
  if (intake.kind === "claim" && !assessed) throw new Error("recordOptionsIntake: a claim requires its assessment");
  const reasons: AssessmentReason[] = assessed ? assessed.reasons : [NOT_ASSESSED[intake.kind === "ambiguous" ? "ambiguous" : "unsupported"]];

  const provenance = {
    contractMaster: input.master
      ? { configured: true, name: input.master.name, isTestFixture: input.master.isTestFixture, reference: input.master.reference ?? null }
      : { configured: false },
    premiumProvider: input.premium ? { configured: true, name: input.premium.name, source: input.premium.source ?? null } : { configured: false },
    note: "Only the master/provider actually used are recorded. No sample or manual reference is attached unless explicitly configured.",
  };

  const row = {
    telegramMessageId: input.telegramMessageId,
    parserVersion: input.parserVersion,
    resultKind: intake.kind,
    claim: intake.kind === "claim" ? intake.claim : null,
    detail: intake.kind === "ambiguous" ? { directives: intake.directives } : intake.kind === "unsupported" ? { symbol: intake.symbol, form: intake.form } : null,
    assessmentOutcome: assessed?.outcome ?? null,
    reasons,
    verification: assessed?.verification ?? null,
    premium: assessed?.premium ?? null,
    provenance,
    approvalPossible: false,
  };

  const [inserted] = await db
    .insert(schema.optionsClaims)
    .values(row)
    .onConflictDoNothing({ target: [schema.optionsClaims.telegramMessageId, schema.optionsClaims.parserVersion] })
    .returning({ id: schema.optionsClaims.id });
  if (inserted) {
    // Stop-loss evidence for the claim (immutable, hash-chained). Idempotent per claim; a claim that was not assessed has none and is therefore unverified.
    if (assessed) await recordStopLossEvidence(db, { kind: "options_claim", optionsClaimId: inserted.id }, assessed.stopLoss, `options-claim:${inserted.id}`);
    return { id: inserted.id, created: true, differsFromStored: false };
  }

  const [existing] = await db
    .select()
    .from(schema.optionsClaims)
    .where(eq(schema.optionsClaims.telegramMessageId, input.telegramMessageId));
  const all = await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.telegramMessageId, input.telegramMessageId));
  const stored = all.find((r) => r.parserVersion === input.parserVersion) ?? existing;
  if (!stored) throw new Error("options_claims insert conflicted but the canonical row was not found");
  const storedCodes = (stored.reasons as AssessmentReason[]).map((r) => r.code).join("|");
  const differs = stored.assessmentOutcome !== row.assessmentOutcome || storedCodes !== reasons.map((r) => r.code).join("|");
  return { id: stored.id, created: false, differsFromStored: differs };
}
