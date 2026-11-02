/**
 * Capture-gap detector (pure). The caller supplies the newest durable capture time (e.g. MAX(received_at) of the intake outbox) and the clock; the result is the fields of a
 * `telegram.capture.gap` log event, which ALERT_RULES turns into a CRITICAL alert, or null while capture is recent. A null `lastCapturedAt` (nothing ever captured) is a gap.
 * Quiet channels are real, so the threshold is configuration; it is deliberately not guessed here.
 */
export function detectCaptureGap(lastCapturedAt: Date | null, now: Date, thresholdSeconds: number): { ageSeconds: number; windowSeconds: number } | null {
  if (!Number.isFinite(thresholdSeconds) || thresholdSeconds <= 0) throw new Error("thresholdSeconds must be a positive number");
  const age = lastCapturedAt ? Math.max(0, Math.floor((now.getTime() - lastCapturedAt.getTime()) / 1000)) : Number.MAX_SAFE_INTEGER;
  return age > thresholdSeconds ? { ageSeconds: age, windowSeconds: thresholdSeconds } : null;
}
