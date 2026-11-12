/**
 * Shared-intelligence read contracts used by Stage 09.3A (Opportunity Discovery, Opportunity Detail, Market Intelligence).
 * Typed from the backend view mappers (apps/api/src/opportunityApi.ts `candidateView` / `scanView`, researchApi.ts `view`, telegramIntelApi.ts `channelView`) and the key lists are
 * asserted against the REAL routes by tests/unit/api-contracts/opportunityParity.test.ts. A candidate is a PROPOSAL for research: it carries no order, approval, size or risk verdict.
 * Prices on a candidate are JSON numbers (display only; nothing here computes).
 */
import type { IsoTimestamp, Uuid } from "./wire";

export const CANDIDATE_SOURCES = ["TELEGRAM", "INDEPENDENT"] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
export const CANDIDATE_LIFECYCLE_STATES = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"] as const;
export type CandidateLifecycleState = (typeof CANDIDATE_LIFECYCLE_STATES)[number];
/** Page size the screens request; the backend accepts 1..200. */
export const CANDIDATE_PAGE_SIZE = 25;

export const CANDIDATE_VIEW_KEYS = ["id", "source", "state", "stateReason", "supersededBy", "underlying", "exchange", "setup", "side", "entryKind", "entryLow", "entryHigh", "stopLoss", "targets", "strike", "optionType", "expiry", "rankScore", "dataSource", "createdAt", "expiresAt", "lastValidatedAt", "researchAttempts"] as const;
export interface CandidateView {
  id: Uuid; source: CandidateSource; state: string; stateReason: string | null; supersededBy: Uuid | null; underlying: string; exchange: string; setup: string | null; side: "BUY" | "SELL";
  entryKind: string; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[]; strike: number | null; optionType: "CE" | "PE" | null; expiry: string | null;
  rankScore: number | null; dataSource: string; createdAt: IsoTimestamp; expiresAt: IsoTimestamp; lastValidatedAt: IsoTimestamp | null; researchAttempts: number;
}
export interface CandidatesResponse { state: "EMPTY" | "OK"; candidates: CandidateView[]; note: string }

export const CANDIDATE_DETAIL_KEYS = ["candidate", "lifecycle", "evidence", "research"] as const;
export const CANDIDATE_RESEARCH_KEYS = ["status", "packageId", "packageVersion", "assessment"] as const;
export interface CandidateLifecycleEvent { from: string | null; to: string; reason: string | null; at: IsoTimestamp }
export interface CandidateDetailResponse {
  candidate: CandidateView; lifecycle: CandidateLifecycleEvent[];
  /** The parsed evidence the scan recorded: tagged objects (`kind`). Inner shapes are not contract-guaranteed; render as labelled text only. */
  evidence: unknown[];
  research: { status: string | null; packageId: Uuid | null; packageVersion: number | null; assessment: string | null };
}

export const SCAN_VIEW_KEYS = ["id", "kind", "slot", "status", "dataSource", "detectorVersion", "universeSize", "candidates", "errorKind", "skipped", "parameters", "startedAt", "completedAt"] as const;
export interface ScanView { id: Uuid; kind: string; slot: string | null; status: string; dataSource: string; detectorVersion: string; universeSize: number; candidates: number; errorKind: string | null; skipped: unknown; parameters: unknown; startedAt: IsoTimestamp; completedAt: IsoTimestamp | null }
export interface ScansResponse { state: "EMPTY" | "OK"; scans: ScanView[] }

/** GET /research/candidates/:id/package. `package` (the agent results) is NOT typed: its inner shape is unverified, so the interface shows only the envelope. */
export const RESEARCH_PACKAGE_KEYS = ["packageId", "candidateId", "version", "assessment", "haltReason", "status", "researchAttempts", "createdAt", "package"] as const;
export interface ResearchPackageResponse { packageId: Uuid; candidateId: Uuid; version: number; assessment: string; haltReason: string | null; status: string | null; researchAttempts: number | null; createdAt: IsoTimestamp; package: unknown }
/** The same route when no package exists yet. */
export const RESEARCH_PACKAGE_ABSENT_KEYS = ["candidateId", "status", "researchAttempts", "package", "note"] as const;
export interface ResearchPackageAbsentResponse { candidateId: Uuid; status: string | null; researchAttempts: number | null; package: null; note: string }

export const CHANNEL_VIEW_KEYS = ["id", "channel", "name", "messages", "messages24h", "claims", "candidates", "firstMessageAt", "lastMessageAt", "health"] as const;
export const CHANNEL_HEALTH_KEYS = ["status", "lastMessageAgeSeconds", "messages24h", "capture", "reasons", "reliability"] as const;
export interface ChannelHealthView { status: string; lastMessageAgeSeconds: number | null; messages24h: number; capture: "NO_DATA" | "TIMELY" | "DELAYED"; reasons: string[]; reliability: "NOT_AVAILABLE" }
export interface ChannelView { id: Uuid; channel: string; name: string | null; messages: number; messages24h: number; claims: { claim: number; ambiguous: number; unsupported: number }; candidates: Record<string, number>; firstMessageAt: IsoTimestamp | null; lastMessageAt: IsoTimestamp | null; health: ChannelHealthView }
export interface ChannelsResponse { channels: ChannelView[]; reliabilityNote: string }
