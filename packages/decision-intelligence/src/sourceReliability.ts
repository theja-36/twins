import type { SourceReliabilityAssessment } from "./types";

/**
 * Source reliability must never be a fabricated trust score (spec: "Do
 * not implement Telegram source = 90 ... without a defensible basis").
 * No table in this repository tracks verified historical signal outcomes
 * yet (that is a future phase's job - "may learn source reliability from
 * actual historical outcomes"), so the only honest answer right now is
 * UNKNOWN, for every source, every time. This function exists as the
 * single place that future phase will change - nothing else in this
 * package should ever invent a number.
 */
export function assessSourceReliability(): SourceReliabilityAssessment {
  return {
    level: "UNKNOWN",
    reason:
      "No historical source-performance tracking exists yet in this system; reliability cannot be measured and is not assumed.",
  };
}
