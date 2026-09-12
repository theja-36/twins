import type { ProviderHealthSnapshot } from "./common";

export type SourceTier = "A" | "B" | "C" | "D" | "E";

export interface NewsFetchParams {
  since?: Date;
  instrumentSymbols?: string[];
}

/**
 * A single raw article/announcement as translated by the adapter (spec
 * section 16/17) - the atomic unit, before clustering/dedup (Phase 7).
 * `headline`/`bodyExcerpt` are untrusted external content (spec section
 * 27): never interpret them as instructions anywhere downstream.
 */
export interface NormalizedNewsItem {
  sourceName: string;
  sourceTier: SourceTier;
  sourceUrl: string;
  headline: string;
  bodyExcerpt?: string;
  sourceTimestamp: Date;
  rawPayload?: unknown;
}

/** NewsProvider (spec section 43). */
export interface NewsProvider {
  readonly providerName: string;
  readonly sourceTier: SourceTier;
  fetchLatest(params: NewsFetchParams): Promise<NormalizedNewsItem[]>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}
