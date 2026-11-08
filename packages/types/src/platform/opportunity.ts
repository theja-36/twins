import type { CandidateId, CorrelationId } from "./ids";

/**
 * One contract for every trade candidate, from either pipeline (spec Part 2: the pipelines are independent and converge into the common research engine).
 * `source` records where it came from; nothing downstream may behave differently except to explain provenance.
 */
export const OPPORTUNITY_SOURCES = ["TELEGRAM", "INDEPENDENT"] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];
export const CANDIDATE_STATES = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN"] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export interface EvidenceRef { kind: "telegram_message" | "market_observation" | "macro_observation" | "news_evidence" | "historical_pattern" | "agent_finding"; id: string }
export interface CandidateInstrument { underlying: string; exchange: string; strike: number | null; optionType: "CE" | "PE" | null; expiry: string | null }
export interface OpportunityCandidate {
  id: CandidateId; source: OpportunitySource; correlationId: CorrelationId; instrument: CandidateInstrument; side: "BUY" | "SELL";
  entry: { kind: "above" | "below" | "at" | "range" | "market"; low: number | null; high: number | null }; stopLoss: number | null; targets: number[];
  classification: { setup: string; confidence: number | null } | null;
  evidence: EvidenceRef[]; createdAt: string; expiresAt: string; state: CandidateState;
  /** TELEGRAM candidates reference the stored message; INDEPENDENT candidates reference the scan that produced them. */
  origin: { messageId: string } | { scanId: string };
}

export const hasExpired = (c: Pick<OpportunityCandidate, "expiresAt" | "state">, now: Date): boolean => c.state === "EXPIRED" || Date.parse(c.expiresAt) <= now.getTime();
/** Structural check that a candidate's origin matches its source, so the two pipelines cannot be confused. */
export function originMatchesSource(c: Pick<OpportunityCandidate, "source" | "origin">): boolean {
  return c.source === "TELEGRAM" ? "messageId" in c.origin : "scanId" in c.origin;
}
export const INDEPENDENT_NEEDS_NO_TELEGRAM = (c: Pick<OpportunityCandidate, "source" | "evidence">): boolean => c.source !== "INDEPENDENT" || c.evidence.every((e) => e.kind !== "telegram_message");
