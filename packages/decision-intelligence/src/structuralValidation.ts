import type { schema } from "@twins/database";
import type { StructuralValidationIssue } from "./types";

export interface StructuralValidationOptions {
  /** Signals older than this are considered stale for decision purposes. Default 30 days. */
  maxSignalAgeMs?: number;
}

const DEFAULT_MAX_SIGNAL_AGE_MS = 1000 * 60 * 60 * 24 * 30;

export interface StructuralValidationResult {
  issues: StructuralValidationIssue[];
  /** A blocking issue means the signal itself is invalid and cannot proceed regardless of evidence (spec: "exposes a strong invalidating condition"). */
  blocking: boolean;
}

/**
 * The Telegram signal is an external CLAIM, never proof (spec section
 * 7/61). This validates the claim's own structure before any evidence is
 * even considered - malformed/stale/unresolvable claims are rejected
 * outright, exactly as a human analyst would discard an unusable tip
 * before spending time researching it.
 */
export function validateSignalStructure(
  signal: typeof schema.signals.$inferSelect,
  instrument: typeof schema.instruments.$inferSelect | null,
  now: Date,
  options: StructuralValidationOptions = {},
): StructuralValidationResult {
  const maxSignalAgeMs = options.maxSignalAgeMs ?? DEFAULT_MAX_SIGNAL_AGE_MS;
  const issues: StructuralValidationIssue[] = [];
  let blocking = false;

  if (!instrument) {
    issues.push({ ruleId: "structural.instrument_unresolved", description: "the signal's instrument could not be resolved" });
    blocking = true;
  }

  if (signal.direction !== "buy" && signal.direction !== "sell") {
    issues.push({ ruleId: "structural.invalid_direction", description: "signal direction is neither buy nor sell" });
    blocking = true;
  }

  const ageMs = now.getTime() - signal.signalTimestamp.getTime();
  if (ageMs > maxSignalAgeMs) {
    issues.push({
      ruleId: "structural.stale_signal",
      description: `signal is ${Math.round(ageMs / 86_400_000)} days old, exceeding the ${Math.round(maxSignalAgeMs / 86_400_000)}-day freshness threshold`,
    });
  }
  if (ageMs < 0) {
    issues.push({ ruleId: "structural.future_signal", description: "signal timestamp is in the future" });
    blocking = true;
  }

  const isBare = signal.entryPrice === null && signal.stopLoss === null && (!Array.isArray(signal.targets) || signal.targets.length === 0);
  if (isBare) {
    issues.push({
      ruleId: "structural.bare_signal",
      description: "signal carries no entry price, stop loss, or targets - only a bare direction claim",
    });
  }

  return { issues, blocking };
}
