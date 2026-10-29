import { isStopLossValid, type StopLossValidation } from "./types";

/**
 * Verdict states, by whether they may lead to an approval or an order. Adding a state that is execution-eligible REQUIRES listing it in
 * EXECUTION_ELIGIBLE_STATES, which routes it through assertStopLossAllowsEligibility (a static test pins this list and the enums).
 *  - APPROVE / QUALIFIED : execution-eligible; require a VALID stop-loss.
 *  - CONDITIONAL         : never execution-eligible (e.g. awaiting a stop-loss revision); it can never carry execution rights.
 *  - everything else     : not eligible.
 */
export const EXECUTION_ELIGIBLE_STATES = ["APPROVE", "QUALIFIED"] as const;
export const NEVER_ELIGIBLE_STATES = ["CONDITIONAL", "WAIT", "REJECT", "NO_TRADE", "ALTERNATIVE_CANDIDATE", "INSUFFICIENT_EVIDENCE"] as const;

export class StopLossInvariantError extends Error {
  constructor(
    readonly state: string,
    readonly reasonCode: string | null,
  ) {
    super(`stop-loss invariant: ${state} requires a VALID stop-loss (found ${reasonCode ?? "no validation"})`);
    this.name = "StopLossInvariantError";
  }
}

export const isExecutionEligibleState = (state: string): boolean => (EXECUTION_ELIGIBLE_STATES as readonly string[]).includes(state);

/** Throws unless the state may be produced: an execution-eligible state needs a VALID stop-loss validation; CONDITIONAL is refused as eligible by construction. */
export function assertStopLossAllowsEligibility(state: string, validation: StopLossValidation | null | undefined): void {
  if (!isExecutionEligibleState(state)) return;
  if (!validation || !isStopLossValid(validation)) throw new StopLossInvariantError(state, validation?.reasonCode ?? null);
}
