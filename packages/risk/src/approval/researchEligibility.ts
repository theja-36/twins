import { sql } from "drizzle-orm";
import type { Db } from "@twins/database";

/**
 * Research-assessment re-check of approval eligibility (Stage 5 / Task 8, closing D-066 a). A decision may be presented for approval only if the LATEST research assessment of its lineage is acceptable.
 * The assessment is bound to the decision version the agent engine ran on (the worker runs it on the version that records source intelligence, before sizing), while the version that later becomes
 * APPROVED_FOR_REVIEW is a newer row of the same subject; so the assessment looked up is the most recent run among the versions of the same signal / options claim that are not newer than the decision.
 * A BLOCKED, INCOMPLETE or ADVERSE assessment refuses approval; CAUTION, NEUTRAL and SUPPORTIVE leave the existing rules in charge. The same refusal is enforced AGAIN inside the database
 * (`twins_record_risk_approval`, migration 0027) at the instant an approval is recorded - the application check below adds the configurable "missing assessment" rule and the early, readable reason.
 * This module reads only; it never writes and never grants approval.
 *
 *   TWINS_RESEARCH_ELIGIBILITY_ENFORCED            true | false (default true: the application-layer re-check; the database floor below is not configurable)
 *   TWINS_RESEARCH_ELIGIBILITY_ON_MISSING          REFUSE | ALLOW (default REFUSE: no assessment exists although the engine is enabled)
 *   TWINS_RESEARCH_ELIGIBILITY_WHEN_ENGINE_DISABLED IGNORE | REQUIRE (default IGNORE: with the engine disabled and no assessment, behaviour is exactly as before)
 *   TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON           comma list of assessments that refuse (default RESEARCH_BLOCKED,RESEARCH_INCOMPLETE,RESEARCH_ADVERSE; these three are mandatory, RESEARCH_CAUTION / RESEARCH_NEUTRAL may be added)
 *   TWINS_AGENT_ENGINE_ENABLED                     the same switch the engine uses (default false)
 */
export const RESEARCH_ASSESSMENTS = ["RESEARCH_SUPPORTIVE", "RESEARCH_NEUTRAL", "RESEARCH_CAUTION", "RESEARCH_ADVERSE", "RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE"] as const;
export type ResearchAssessmentName = (typeof RESEARCH_ASSESSMENTS)[number];
export type RefusableAssessment = Exclude<ResearchAssessmentName, "RESEARCH_SUPPORTIVE">;
const MANDATORY: readonly RefusableAssessment[] = ["RESEARCH_ADVERSE", "RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE"];
/** Fixed machine-readable refusal codes (deliberately not configurable: they are also the codes the database function returns). */
export const RESEARCH_REFUSAL_CODES = {
  RESEARCH_BLOCKED: "research_assessment_blocked", RESEARCH_INCOMPLETE: "research_assessment_incomplete", RESEARCH_ADVERSE: "research_assessment_adverse", RESEARCH_CAUTION: "research_assessment_caution", RESEARCH_NEUTRAL: "research_assessment_neutral",
  missing: "research_assessment_missing", unavailable: "research_assessment_unavailable",
  /** HB-01: the approval cites no run although one exists, or cites a run that is no longer the latest. HB-02: a better run did not bring new evidence over an earlier ADVERSE / BLOCKED one. */
  referenceMissing: "research_reference_missing", changed: "research_assessment_changed", adverseNotSuperseded: "research_adverse_not_superseded", blockedNotSuperseded: "research_blocked_not_superseded",
} as const;
export type ResearchRefusalCode = (typeof RESEARCH_REFUSAL_CODES)[keyof typeof RESEARCH_REFUSAL_CODES];

export interface ResearchEligibilityConfig {
  enforced: boolean;
  onMissing: "REFUSE" | "ALLOW";
  whenEngineDisabled: "IGNORE" | "REQUIRE";
  refuseOn: RefusableAssessment[];
  /** Whether the agent engine is enabled (`TWINS_AGENT_ENGINE_ENABLED`). */
  engineEnabled: boolean;
}
export const DEFAULT_RESEARCH_ELIGIBILITY: ResearchEligibilityConfig = { enforced: true, onMissing: "REFUSE", whenEngineDisabled: "IGNORE", refuseOn: [...MANDATORY], engineEnabled: false };

const bool = (env: Record<string, string | undefined>, name: string, def: boolean): boolean => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (v !== "true" && v !== "false") throw new Error(`${name} must be true or false`);
  return v === "true";
};
const pick = <T extends string>(env: Record<string, string | undefined>, name: string, allowed: readonly T[], def: T): T => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
};
/** A malformed value THROWS (the process does not start with a silently weaker eligibility rule). */
export function loadResearchEligibilityConfig(env: Record<string, string | undefined> = process.env): ResearchEligibilityConfig {
  const raw = env["TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON"];
  let refuseOn: RefusableAssessment[] = [...MANDATORY];
  if (raw !== undefined && raw.trim() !== "") {
    const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (list.some((x) => !(RESEARCH_ASSESSMENTS as readonly string[]).includes(x))) throw new Error("TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON contains an unknown assessment");
    if (list.includes("RESEARCH_SUPPORTIVE")) throw new Error("TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON may not refuse RESEARCH_SUPPORTIVE");
    if (MANDATORY.some((m) => !list.includes(m))) throw new Error("TWINS_RESEARCH_ELIGIBILITY_REFUSE_ON must include RESEARCH_BLOCKED, RESEARCH_INCOMPLETE and RESEARCH_ADVERSE");
    refuseOn = [...new Set(list)].sort() as RefusableAssessment[];
  }
  return {
    enforced: bool(env, "TWINS_RESEARCH_ELIGIBILITY_ENFORCED", true), onMissing: pick(env, "TWINS_RESEARCH_ELIGIBILITY_ON_MISSING", ["REFUSE", "ALLOW"], "REFUSE"),
    whenEngineDisabled: pick(env, "TWINS_RESEARCH_ELIGIBILITY_WHEN_ENGINE_DISABLED", ["IGNORE", "REQUIRE"], "IGNORE"), refuseOn, engineEnabled: bool(env, "TWINS_AGENT_ENGINE_ENABLED", false),
  };
}

export interface LatestResearchAssessment { runId: string; assessment: ResearchAssessmentName; runDecisionVersion: number; createdAt: Date; synthesisSha256: string; /** The database function's refusal (BLOCKED / INCOMPLETE / ADVERSE, or an adverse result not superseded by new evidence); null = does not stand in the way. */ refusal: ResearchRefusalCode | null }
/**
 * The research assessment that stands for the decision: computed by the DATABASE function `twins_research_assessment` (migration 0028), the same function the approval function uses, so both layers
 * agree. It is the latest run among the versions of the subject that are not newer than the decision, and carries the HB-02 rule: a later, better run does not clear an earlier ADVERSE / BLOCKED run
 * unless the agents that were adverse now cite different evidence. Null = no run.
 */
export async function latestResearchAssessment(db: Db, decision: { signalId: string | null; optionsClaimId: string | null; decisionVersion: number }): Promise<LatestResearchAssessment | null> {
  const r = await db.execute(sql`
    select a.run_id as run_id, a.assessment as assessment, a.synthesis_sha256 as sha, a.refusal as refusal, o.decision_version as run_version, o.created_at as created_at
    from twins_research_assessment(${decision.signalId}::uuid, ${decision.optionsClaimId}::uuid, ${decision.decisionVersion}::int) a
    join agent_orchestrator_runs o on o.id = a.run_id`);
  const row = r.rows[0] as { run_id: string; assessment: string; sha: string; refusal: string | null; run_version: number; created_at: string | Date } | undefined;
  if (!row) return null;
  if (!(RESEARCH_ASSESSMENTS as readonly string[]).includes(row.assessment)) throw new Error("unknown research assessment");
  const known = Object.values(RESEARCH_REFUSAL_CODES) as string[];
  if (row.refusal !== null && !known.includes(row.refusal)) throw new Error("unknown research refusal code");
  return { runId: row.run_id, assessment: row.assessment as ResearchAssessmentName, runDecisionVersion: Number(row.run_version), createdAt: new Date(row.created_at), synthesisSha256: row.sha, refusal: row.refusal as ResearchRefusalCode | null };
}

/** The refusal codes for a decision (empty = the research assessment does not stand in the way). An unreadable assessment store fails closed whenever a check applies. */
export async function researchEligibilityReasons(db: Db, decision: { signalId: string | null; optionsClaimId: string | null; decisionVersion: number }, cfg: ResearchEligibilityConfig = loadResearchEligibilityConfig(), cited?: string | null): Promise<ResearchRefusalCode[]> {
  if (!cfg.enforced) return [];
  const applies = cfg.engineEnabled || cfg.whenEngineDisabled === "REQUIRE";
  let latest: LatestResearchAssessment | null;
  try { latest = await latestResearchAssessment(db, decision); } catch { return applies ? [RESEARCH_REFUSAL_CODES.unavailable] : []; }
  if (latest) {
    if (latest.refusal) return [latest.refusal];
    if ((cfg.refuseOn as string[]).includes(latest.assessment)) return [RESEARCH_REFUSAL_CODES[latest.assessment as RefusableAssessment]];
    // HB-01: the approval must cite the exact run it relied on (`cited` is passed whenever an approval is being recorded)
    if (cited !== undefined) { if (cited === null || cited === "") return [RESEARCH_REFUSAL_CODES.referenceMissing]; if (cited !== latest.runId) return [RESEARCH_REFUSAL_CODES.changed]; }
    return [];
  }
  return applies && cfg.onMissing === "REFUSE" ? [RESEARCH_REFUSAL_CODES.missing] : [];
}
