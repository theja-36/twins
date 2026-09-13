/**
 * Phase 8 - the "Context Window" pipeline stage. A signal intelligence
 * assembly is always bounded to a specific instant (the signal's own
 * timestamp) and, optionally, a lookback horizon for how far back to
 * consider evidence relevant. This is deliberately a plain value object,
 * not a class - every later stage just reads `asOf`/`from`.
 */
export interface ContextWindow {
  /** The signal's own timestamp - nothing after this may be considered (no look-ahead). */
  asOf: Date;
  /** Optional lower bound - evidence older than this is still fetchable but may be flagged stale by freshness assessment. */
  from?: Date | undefined;
}

export interface ResolveContextWindowOptions {
  /** How far back, in ms, evidence is still considered part of this window. Omit for no lower bound. */
  lookbackMs?: number | undefined;
}

export function resolveContextWindow(
  signalTimestamp: Date,
  options: ResolveContextWindowOptions = {},
): ContextWindow {
  const from = options.lookbackMs !== undefined ? new Date(signalTimestamp.getTime() - options.lookbackMs) : undefined;
  return { asOf: signalTimestamp, from };
}
