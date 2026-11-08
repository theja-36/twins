/**
 * Evidence completeness (Module 03). A decision must be traceable to its source evidence, research, historical comparison and revisions. This checks that each required kind of evidence is
 * PRESENT and not too old. Missing or stale evidence is reported as such and never counts as positive.
 */
export const EVIDENCE_KINDS = ["source", "classification", "research_package", "market_regime", "historical_comparison", "confidence_assessment", "risk_assessment", "simulation"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
/** What each stage needs before it may proceed. */
export const REQUIRED_FOR = {
  RESEARCH: ["source", "classification"],
  DECISION: ["source", "classification", "research_package", "market_regime", "historical_comparison", "confidence_assessment", "risk_assessment", "simulation"],
} as const satisfies Record<string, readonly EvidenceKind[]>;
export type Stage = keyof typeof REQUIRED_FOR;

export interface EvidenceItem { kind: EvidenceKind; id: string; at: Date; dataSource?: "FIXTURE" | "LIVE" | "HISTORICAL" }
/** Maximum age (minutes) per kind. A regime or research older than this is stale for a live decision. Absent = no age limit (e.g. the immutable source message). */
export const MAX_AGE_MINUTES: Partial<Record<EvidenceKind, number>> = { market_regime: 30, research_package: 60, confidence_assessment: 60, risk_assessment: 15, simulation: 15 };

export interface CompletenessResult { stage: Stage; complete: boolean; present: EvidenceKind[]; missing: EvidenceKind[]; stale: EvidenceKind[]; fixtureBacked: EvidenceKind[]; score: number }
export function checkEvidenceCompleteness(stage: Stage, items: readonly EvidenceItem[], now: Date): CompletenessResult {
  const required = REQUIRED_FOR[stage] as readonly EvidenceKind[];
  const present: EvidenceKind[] = [], missing: EvidenceKind[] = [], stale: EvidenceKind[] = [], fixtureBacked: EvidenceKind[] = [];
  for (const k of required) {
    const have = items.filter((i) => i.kind === k && i.at.getTime() <= now.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (!have) { missing.push(k); continue; }
    const max = MAX_AGE_MINUTES[k];
    if (max !== undefined && now.getTime() - have.at.getTime() > max * 60_000) { stale.push(k); continue; }
    present.push(k);
    if (have.dataSource === "FIXTURE") fixtureBacked.push(k);
  }
  return { stage, complete: missing.length === 0 && stale.length === 0 && fixtureBacked.length === 0, present, missing, stale, fixtureBacked, score: Math.round((present.length / required.length) * 100) / 100 };
}
