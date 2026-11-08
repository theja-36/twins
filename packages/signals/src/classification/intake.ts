import type { Db } from "../db";
import type { OptionsClaim } from "../options/types";
import { classifySignal } from "./classify";
import { storeClassification } from "./persist";

/**
 * Classification at intake (Master Build Stage 03). OFF by default: `TWINS_CLASSIFY_ON_INTAKE` must be exactly "true" (anything other than true, false or empty is a configuration error, so the
 * worker refuses to start rather than guess). When on, each newly recorded options claim is classified right after the claim row exists.
 *
 * Boundaries: classification is EVIDENCE. It writes one append-only `signal_classifications` row (codes and structure only, never message text) keyed by claim and classifier version, so it is
 * idempotent and carries its provenance (claim, classifier version). It makes no decision, creates no risk decision, and touches neither the stop-loss rule nor sizing.
 * A failure NEVER stops or loses the intake event: it is caught, reported as `failed` (error class name only), and the claim stays unclassified, which the backfill and the next retry of the same
 * message both pick up.
 */
export const CLASSIFY_ON_INTAKE_ENV = "TWINS_CLASSIFY_ON_INTAKE";
export class ClassifyOnIntakeConfigError extends Error { constructor(message: string) { super(message); this.name = "ClassifyOnIntakeConfigError"; } }
export function loadClassifyOnIntakeFlag(env: Record<string, string | undefined>): boolean {
  const raw = env[CLASSIFY_ON_INTAKE_ENV];
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new ClassifyOnIntakeConfigError(`${CLASSIFY_ON_INTAKE_ENV} must be true or false`);
}

export interface ClassifyOnIntakeInput { claimId: string; claim: OptionsClaim; messageText: string; messageTimestamp: Date }
export type ClassifyOnIntakeResult = { status: "stored" | "already_recorded" } | { status: "failed"; errorName: string };

export async function classifyClaimOnIntake(db: Db, input: ClassifyOnIntakeInput): Promise<ClassifyOnIntakeResult> {
  try {
    const result = classifySignal({ claim: input.claim, messageText: input.messageText, messageTimestamp: input.messageTimestamp });
    return { status: (await storeClassification(db, input.claimId, result)) ? "stored" : "already_recorded" };
  } catch (e) {
    return { status: "failed", errorName: e instanceof Error ? e.name : "Error" }; // the name only: an error message could embed row or message content
  }
}
