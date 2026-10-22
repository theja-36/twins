import type { schema } from "@twins/database";
import type { QualityAssessmentResult } from "@twins/dataquality";
import type { MarketContext } from "./context/market";

export interface SignalIntelligence {
  signal: typeof schema.signals.$inferSelect;
  originalTelegramMessage?: typeof schema.telegramMessages.$inferSelect | undefined;
  telegramMessageQuality?: QualityAssessmentResult | undefined;
  marketContext: MarketContext | null;
  /** Why no market input was selected (only set when marketContext is null). */
  marketInputReason?: string | undefined;
  macroContext: Array<typeof schema.macroObservations.$inferSelect>;
  newsContext: Array<typeof schema.newsEvidence.$inferSelect>;
  priorSignalStats: { totalPriorSignalsForInstrument: number };
  /** Explicit notes on what evidence was NOT found - never silently omitted. */
  dataCompletenessNotes: string[];
  generatedAt: Date;
}
