import { createHash } from "node:crypto";
import { COARSE_SETUP, SETUP_DETECTOR_VERSION, type SetupSignal } from "./setups";
import type { RankDetail } from "./rank";
import type { OpportunityDataSource } from "./config";
import type { RewardRiskScreen } from "./screen";

/** The candidate a scan proposes, in the shape the `opportunity_candidates` table stores (INDEPENDENT source). Parsed fields only. It is a proposal for the research path, never an order. */
export interface CandidateDraft {
  dedupeKey: string; underlying: string; exchange: string; side: "BUY" | "SELL"; setup: "BREAKOUT" | "REVERSAL" | "MOMENTUM" | "OTHER";
  entryKind: "at"; entryLow: number; entryHigh: number; stopLoss: number; targets: number[]; invalidation: SetupSignal["invalidation"];
  rankScore: number; evidence: unknown[]; dataSource: OpportunityDataSource; correlationId: string; createdAt: Date; expiresAt: Date;
}
export interface DraftProvenance { providerName: string; providerAsOf: string | null; scanSlot: string; regimeRef: string | null; /** the scan engine and the hash of the settings that decided the candidate (reproducibility) */ engineVersion?: string; configSha256?: string; /** what the calendar said at scan time: PROCEED, or CALENDAR_UNAVAILABLE (missing evidence, never "all clear") */ calendar?: string }

/** Same instrument, setup class, side, signal bar and detector version -> the same key. Re-scanning the same bar can never create a second candidate. */
export function dedupeKeyOf(underlying: string, s: SetupSignal): string {
  return createHash("sha256").update(["opportunity", SETUP_DETECTOR_VERSION, underlying, s.setup, s.side, String(s.timeframeSeconds), s.signalBarAt].join("|")).digest("hex");
}
export function toCandidateDraft(o: { underlying: string; exchange: string; signal: SetupSignal; rank: RankDetail; dataSource: OpportunityDataSource; now: Date; ttlMinutes: number; correlationId: string; provenance: DraftProvenance; screen?: RewardRiskScreen }): CandidateDraft {
  const s = o.signal;
  return {
    dedupeKey: dedupeKeyOf(o.underlying, s), underlying: o.underlying, exchange: o.exchange, side: s.side, setup: COARSE_SETUP[s.setup], entryKind: "at", entryLow: s.entry, entryHigh: s.entry,
    stopLoss: s.stop, targets: s.targets, invalidation: s.invalidation, rankScore: o.rank.score, dataSource: o.dataSource, correlationId: o.correlationId, createdAt: o.now, expiresAt: new Date(o.now.getTime() + o.ttlMinutes * 60_000),
    evidence: [
      { kind: "setup", setupClass: s.setup, detector: SETUP_DETECTOR_VERSION, timeframeSeconds: s.timeframeSeconds, signalBarAt: s.signalBarAt, reasons: s.reasons, volumeConfirmed: s.volumeConfirmed, riskPerUnit: s.riskPerUnit },
      { kind: "rank", ...o.rank },
      ...(o.screen ? [{ kind: "reward_risk_screen", ...o.screen }] : []),
      // a stop derived from price structure is a PROPOSAL: it has not been through stop-loss validation (Stage 07 must validate it before any qualification)
      { kind: "stop_loss", basis: "price", derivedFrom: "setup_structure", validated: false, note: "proposed by the setup rules; independent validation is required before qualification" },
      { kind: "provenance", provider: o.provenance.providerName, providerAsOf: o.provenance.providerAsOf, dataSource: o.dataSource, scanSlot: o.provenance.scanSlot, regimeRef: o.provenance.regimeRef, ...(o.provenance.engineVersion ? { engineVersion: o.provenance.engineVersion } : {}), ...(o.provenance.configSha256 ? { configSha256: o.provenance.configSha256 } : {}), ...(o.provenance.calendar ? { calendar: o.provenance.calendar } : {}), calibrated: false, confidence: null },
    ],
  };
}
