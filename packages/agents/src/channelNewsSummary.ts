/**
 * One-line summary of the channel news clusters (route field and Dashboard line). PURE. Channel commentary is capped: the recommendation is NONE or CAUTION and can never be anything stronger.
 * An unavailable file is "unavailable", never "no news"; an empty file is "no commentary", never "all clear".
 */
export type ChannelNewsRecommendation = "NONE" | "CAUTION";
export interface SummaryCluster { items: number; polarity: number; mixed: boolean }
export interface ChannelNewsSummary {
  available: boolean;
  clusters: number;
  mixed: number;
  /** Clusters of at least two items with a clearly negative mean polarity. */
  negative: number;
  recommendation: ChannelNewsRecommendation;
  line: string;
}

export const NEGATIVE_POLARITY = -0.5;
export const NEGATIVE_MIN_ITEMS = 2;

export function summarizeChannelNews(clusters: readonly SummaryCluster[], status: "ok" | "stale" | "missing" | "invalid"): ChannelNewsSummary {
  if (status === "missing" || status === "invalid") return { available: false, clusters: 0, mixed: 0, negative: 0, recommendation: "NONE", line: `Channel news unavailable (${status})` };
  const mixed = clusters.filter((c) => c.mixed).length;
  const negative = clusters.filter((c) => c.items >= NEGATIVE_MIN_ITEMS && c.polarity <= NEGATIVE_POLARITY).length;
  const recommendation: ChannelNewsRecommendation = mixed > 0 || negative > 0 ? "CAUTION" : "NONE";
  const stale = status === "stale" ? " (stale)" : "";
  const line = clusters.length === 0 ? `No channel commentary${stale}` : `${clusters.length} cluster${clusters.length === 1 ? "" : "s"}, ${mixed} mixed, ${recommendation}${stale}`;
  return { available: true, clusters: clusters.length, mixed, negative, recommendation, line };
}
