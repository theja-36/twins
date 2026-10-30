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

export interface LatestResearchAssessment { runId: string; assessment: ResearchAssessmentName; runDecisionVersion: number; createdAt: Date }
/** The most recent research assessment among the versions of the decision's subject that are not newer than the decision, or null. */
export async function latestResearchAssessment(db: Db, decision: { signalId: string | null; optionsClaimId: string | null; decisionVersion: number }): Promise<LatestResearchAssessment | null> {
  const r = await db.execute(sql`
    select o.id as run_id, s.assessment as assessment, o.decision_version as run_version, o.created_at as created_at
    from agent_orchestrator_runs o
    join agent_orchestrator_syntheses s on s.orchestrator_run_id = o.id
    join risk_decisions d on d.id = o.risk_decision_id
    where d.signal_id is not distinct from ${decision.signalId}::uuid and d.options_claim_id is not distinct from ${decision.optionsClaimId}::uuid and d.decision_version <= ${decision.decisionVersion}
    order by o.created_at desc, o.id desc limit 1`);
  const row = r.rows[0] as { run_id: string; assessment: string; run_version: number; created_at: string | Date } | undefined;
  if (!row) return null;
  if (!(RESEARCH_ASSESSMENTS as readonly string[]).includes(row.assessment)) throw new Error("unknown research assessment");
  return { runId: row.run_id, assessment: row.assessment as ResearchAssessmentName, runDecisionVersion: Number(row.run_version), createdAt: new Date(row.created_at) };
}

/** The refusal codes for a decision (empty = the research assessment does not stand in the way). An unreadable assessment store fails closed whenever a check applies. */
export async function researchEligibilityReasons(db: Db, decision: { signalId: string | null; optionsClaimId: string | null; decisionVersion: number }, cfg: ResearchEligibilityConfig = loadResearchEligibilityConfig()): Promise<ResearchRefusalCode[]> {
  if (!cfg.enforced) return [];
  const applies = cfg.engineEnabled || cfg.whenEngineDisabled === "REQUIRE";
  let latest: LatestResearchAssessment | null;
  try { latest = await latestResearchAssessment(db, decision); } catch { return applies ? [RESEARCH_REFUSAL_CODES.unavailable] : []; }
  if (latest) return (cfg.refuseOn as string[]).includes(latest.assessment) ? [RESEARCH_REFUSAL_CODES[latest.assessment as RefusableAssessment]] : [];
  return applies && cfg.onMissing === "REFUSE" ? [RESEARCH_REFUSAL_CODES.missing] : [];
}
