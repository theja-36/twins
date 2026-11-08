import { deriveFeatures } from "@twins/historical";
import type { ContextInputKey } from "../contract";
import type { SignalContext } from "../record";

/**
 * The common research subject (Stage 04). BOTH pipelines - a Telegram-originated candidate and an independently generated market candidate - are described by this one shape (it mirrors
 * `opportunity_candidates`) and are researched by the SAME agents, synthesis and package builder. Neither pipeline reads the other. The shape carries parsed fields only: never message text.
 */
export interface ResearchCandidate {
  id: string; source: "TELEGRAM" | "INDEPENDENT"; underlying: string; exchange: string;
  strike: number | null; optionType: "CE" | "PE" | null; expiry: string | null; side: "BUY" | "SELL";
  entryKind: "above" | "below" | "at" | "range" | "market"; entryLow: number | null; entryHigh: number | null;
  stopLoss: number | null; targets: readonly number[]; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL";
  /** When the candidate was produced (the signal time for TELEGRAM, the scan time for INDEPENDENT). */
  createdAt: Date;
}
const mid = (c: ResearchCandidate): number | null =>
  c.entryLow !== null && c.entryHigh !== null ? (c.entryLow + c.entryHigh) / 2 : c.entryLow ?? c.entryHigh;

/** Maps a candidate to the closed set of agent inputs. The shapes equal those built for a stored risk decision, so every existing agent runs unchanged. A candidate has no stored stop-loss validation yet (null, never assumed valid). */
export function candidateToAgentInputs(c: ResearchCandidate, o: { sourceIntelligence?: Record<string, unknown> | null; version?: number } = {}): Record<ContextInputKey, unknown> {
  const isOption = c.strike !== null && c.optionType !== null;
  const entry = mid(c);
  const targets = [...c.targets];
  const signalContext: SignalContext = {
    subject: "options_claim", signalTimestamp: c.createdAt.toISOString(), messageLinked: c.source === "TELEGRAM",
    revision: { known: false, otherVersions: 0, state: "unknown", anyAmbiguous: false, levelsChanged: null }, entryType: c.entryKind, parserVersion: null,
  };
  return {
    risk_decision: {
      id: c.id, version: o.version ?? 1, status: "PENDING", instrumentType: isOption ? "option" : "equity", market: c.exchange, symbol: c.underlying, side: c.side, entryPrice: entry, stopLoss: c.stopLoss,
      stopLossBasis: isOption ? "premium" : "price", targets, expiry: c.expiry, strike: c.strike, optionType: c.optionType, createdAt: c.createdAt.toISOString(),
    },
    source_intelligence: o.sourceIntelligence ?? null,
    stop_loss_validation: null,
    signal_context: signalContext,
    signal_features: deriveFeatures({
      market: c.exchange, instrumentType: isOption ? "option" : "equity", underlying: c.underlying, optionType: c.optionType, side: c.side,
      entry: entry === null ? null : { type: "at", price: entry }, stopLoss: c.stopLoss, targets, expiryDate: c.expiry, timestamp: c.createdAt,
    }),
  };
}
