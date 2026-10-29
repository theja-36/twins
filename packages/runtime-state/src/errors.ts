import type { RefusalReason, UnavailableReason } from "./types";

/** The safety state could not be read or validated. Carries a stable reason code only (never a driver message, host or value). */
export class RuntimeStateUnavailableError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly detail: string = "",
  ) {
    super(`runtime safety state unavailable: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "RuntimeStateUnavailableError";
  }
}

/**
 * A safety assertion refused an operation. This is the ONE error type callers catch: `reason === "state_unavailable"` means the state
 * could not be read (fail closed) and `cause` holds the RuntimeStateUnavailableError.
 */
export class SafetyRefusalError extends Error {
  constructor(
    readonly operation: string,
    readonly reason: RefusalReason,
    options?: { cause?: RuntimeStateUnavailableError },
  ) {
    super(`safety refused ${operation}: ${reason}`, options?.cause ? { cause: options.cause } : undefined);
    this.name = "SafetyRefusalError";
  }
}

export class ControlChangeInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlChangeInvalidError";
  }
}

/** A well-formed change that the rules forbid (e.g. enabling trading while the kill switch is active). */
export class ControlChangeRefusedError extends Error {
  constructor(readonly code: "kill_switch_active" | "control_row_missing", message: string) {
    super(message);
    this.name = "ControlChangeRefusedError";
  }
}

export class StaleControlVersionError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`control version is ${actual}, expected ${expected}`);
    this.name = "StaleControlVersionError";
  }
}
