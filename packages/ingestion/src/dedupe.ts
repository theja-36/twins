import { createHash } from "node:crypto";

/**
 * Deterministic dedupe key for a news article (spec section: "provider/
 * source + stable external ID where available, otherwise carefully
 * normalized identity"). No stable external ID is guaranteed across news
 * providers, so URL identity is the normalized fallback.
 */
export function computeNewsDedupeHash(sourceUrl: string): string {
  const normalized = sourceUrl.trim().toLowerCase().replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex");
}
