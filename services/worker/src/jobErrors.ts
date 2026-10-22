/**
 * Permanent (non-retryable) failure classes for worker jobs. Independent of
 * BullMQ; the queue boundary maps them to BullMQ's UnrecoverableError.
 */

/** Retrying the same payload can never succeed (malformed/missing input). */
export class InvalidJobInputError extends Error {
  readonly code = "INVALID_JOB_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobInputError";
  }
}

/**
 * Existing data needs human reconciliation (e.g. several legacy signals for one
 * message with no unambiguous canonical record). Never resolved by guessing or deleting.
 */
export class ReconciliationRequiredError extends Error {
  readonly code = "RECONCILIATION_REQUIRED";
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationRequiredError";
  }
}
