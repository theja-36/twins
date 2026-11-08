import { createAdapterRegistry } from "@twins/shared";
import type { AIProvider } from "@twins/types";

/**
 * Registry of AIProvider adapters, keyed by provider name. Spec section
 * 24 names OpenRouter as the initial provider ("AIProvider ->
 * OpenRouterAdapter"), but that concrete adapter belongs to Phase 10 (AI
 * intelligence), once real prompts/evidence-shaping/cost controls are
 * being built - Phase 3 only establishes the contract so nothing above
 * this layer ever couples to a specific vendor's request/response
 * format (spec section 24).
 */
export const aiProviders = createAdapterRegistry<AIProvider>("AI");

export type {
  AIAnalysisRequest,
  AIAnalysisResponse,
  AIEvidenceItem,
  AIProvider,
  ProviderHealthSnapshot,
} from "@twins/types";
export * from "./gateway/index";
