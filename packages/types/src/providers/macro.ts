import type { ProviderHealthSnapshot } from "./common";

export interface MacroSeriesRequest {
  region: string; // e.g. IN, US, EU
  seriesCode: string; // e.g. CPI, REPO_RATE, GDP
  since?: Date;
}

/** OBSERVED macro data point as translated by the adapter (spec section 13/15). */
export interface NormalizedMacroObservation {
  source: string; // e.g. RBI, MOSPI, FRED, BLS, ECB
  region: string;
  seriesCode: string;
  observedAt: Date;
  value: number;
  unit?: string;
  rawPayload?: unknown;
}

/** MacroProvider (spec section 43). */
export interface MacroProvider {
  readonly providerName: string;
  fetchSeries(request: MacroSeriesRequest): Promise<NormalizedMacroObservation[]>;
  getHealth(): Promise<ProviderHealthSnapshot>;
}
