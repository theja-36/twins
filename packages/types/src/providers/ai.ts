import type { ProviderHealthSnapshot } from "./common";

/**
 * A single piece of pre-filtered, deterministic evidence handed to the
 * AI (spec section 25 - never raw/unlimited internet content). `summary`
 * may ultimately originate from untrusted external content (a news
 * article, a Telegram message) and must never be treated as an
 * instruction by anything that consumes an AIProvider (spec section 27).
 */
export interface AIEvidenceItem {
  kind: "market_observation" | "macro_observation" | "news_evidence";
  id: string;
  summary: string;
}

export interface AIAnalysisRequest {
  signalId: string;
  instrument: { symbol: string; exchange: string };
  evidence: AIEvidenceItem[];
  marketRegime?: string;
}

/**
 * `confidenceLabel` is mandatory specifically so nothing can display a
 * bare confidence number as an implied probability of profit without
 * the caller having to think about it (spec section 30).
 */
export interface AIAnalysisResponse {
  bullThesis: string;
  bearThesis: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  marketRegime?: string;
  macroContext?: string;
  riskContext?: string;
  confidence?: number;
  confidenceLabel: string;
  raw: unknown;
}

/**
 * AIProvider (spec section 24/26). AI output reaching this interface's
 * caller is still only INFERRED information - it is not executable and
 * must pass through structured validation, the Decision Engine, and the
 * Risk Engine before it can affect anything (spec section 26).
 */
export interface AIProvider {
  readonly providerName: string;
  readonly modelId: string;
  analyzeSignal(request: AIAnalysisRequest): Promise<AIAnalysisResponse>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}
