import { createAdapterRegistry } from "@twins/shared";
import type { NewsProvider } from "@twins/types";

/**
 * Registry of NewsProvider adapters, keyed by provider name. No concrete
 * vendor adapter yet - see spec section 11/17 for source tiering and
 * priority once real news providers are wired in Phase 4/7.
 */
export const newsProviders = createAdapterRegistry<NewsProvider>("news");

export type {
  NewsFetchParams,
  NewsProvider,
  NormalizedNewsItem,
  ProviderHealthSnapshot,
  SourceTier,
} from "@twins/types";

// Offline-first GDELT DOC adapter. Exported for explicit use; NOT registered in `newsProviders` and not enabled by any worker.
export * from "./gdelt.js";
export * from "./gdeltTransport.js";
