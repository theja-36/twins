import { sql } from "drizzle-orm";
import type { Db } from "@twins/database";
import { loadResearchEligibilityConfig, type ResearchEligibilityConfig } from "./researchEligibility";

/**
 * Start-up probe for the research-assessment eligibility check (P0 hardening / HB-04 and HB-03). The application-layer check reads the agent tables, `risk_decisions` and
 * `agent_engine_state` with the RUNTIME role. Without those grants it fails closed per request (`research_assessment_unavailable`) when the check applies - and is silently skipped when the
 * engine is disabled. The probe makes a missing grant visible at start-up instead: it reads each table and calls the assessment function once as the runtime role, and compares the
 * database's engine flag with the process's `TWINS_AGENT_ENGINE_ENABLED`. It reads, never writes. It is fatal (the process must not start) only when the check applies: the engine is enabled, or
 * `TWINS_RESEARCH_ELIGIBILITY_WHEN_ENGINE_DISABLED=REQUIRE`; otherwise a failure is reported so it can be logged.
 */
export const RESEARCH_PROBE_RELATIONS = ["agent_orchestrator_runs", "agent_orchestrator_syntheses", "agent_runs", "agent_evidence_references", "risk_decisions", "agent_engine_state"] as const;

export type ResearchProbeCode = "research_access_denied" | "research_function_unavailable" | "engine_state_unreadable" | "engine_enabled_but_database_flag_off";
export class ResearchProbeError extends Error {
  constructor(readonly code: ResearchProbeCode, readonly relation: string | null) {
    super(`research eligibility probe failed: ${code}${relation ? ` (${relation})` : ""}`);
    this.name = "ResearchProbeError";
  }
}
export interface ResearchProbeResult { ok: boolean; fatal: boolean; code: ResearchProbeCode | null; relation: string | null; databaseEngineEnabled: boolean | null }

export async function probeResearchAccess(db: Db, cfg: ResearchEligibilityConfig = loadResearchEligibilityConfig()): Promise<ResearchProbeResult> {
  const applies = cfg.enforced && (cfg.engineEnabled || cfg.whenEngineDisabled === "REQUIRE");
  const fail = (code: ResearchProbeCode, relation: string | null, flag: boolean | null): ResearchProbeResult => ({ ok: false, fatal: applies, code, relation, databaseEngineEnabled: flag });
  for (const rel of RESEARCH_PROBE_RELATIONS) {
    try { await db.execute(sql`select 1 from ${sql.identifier(rel)} limit 1`); } catch { return fail("research_access_denied", rel, null); }
  }
  let flag: boolean | null = null;
  try {
    const r = await db.execute(sql`select enabled from agent_engine_state where id = 1`);
    const row = r.rows[0] as { enabled: unknown } | undefined;
    if (!row || typeof row.enabled !== "boolean") return fail("engine_state_unreadable", "agent_engine_state", null);
    flag = row.enabled;
  } catch { return fail("engine_state_unreadable", "agent_engine_state", null); }
  try { await db.execute(sql`select 1 from twins_research_assessment(null::uuid, null::uuid, 1) limit 1`); } catch { return fail("research_function_unavailable", "twins_research_assessment", flag); }
  if (cfg.engineEnabled && !flag) return { ok: false, fatal: true, code: "engine_enabled_but_database_flag_off", relation: "agent_engine_state", databaseEngineEnabled: flag };
  return { ok: true, fatal: false, code: null, relation: null, databaseEngineEnabled: flag };
}

/** Throws ResearchProbeError when the probe is fatal; returns the result otherwise (the caller logs a non-fatal failure). */
export async function assertResearchAccess(db: Db, cfg?: ResearchEligibilityConfig): Promise<ResearchProbeResult> {
  const r = await probeResearchAccess(db, cfg);
  if (!r.ok && r.fatal) throw new ResearchProbeError(r.code as ResearchProbeCode, r.relation);
  return r;
}

export interface ProbeLogger { error(event: string, fields?: Record<string, unknown>): void; warn?(event: string, fields?: Record<string, unknown>): void }
/** Process start-up helper: logs `agent_engine.config.invalid` (setting names and codes only) and throws when the probe is fatal. A non-fatal failure is logged and the process starts. */
export async function runResearchProbe(db: Db, logger: ProbeLogger, cfg?: ResearchEligibilityConfig): Promise<ResearchProbeResult> {
  let result: ResearchProbeResult;
  try { result = await probeResearchAccess(db, cfg); } catch { result = { ok: false, fatal: true, code: "research_access_denied", relation: null, databaseEngineEnabled: null }; }
  if (!result.ok) {
    const fields = { setting: "research_eligibility_probe", code: result.code, relation: result.relation, fatal: result.fatal };
    if (result.fatal) logger.error("agent_engine.config.invalid", fields); else (logger.warn ?? logger.error).call(logger, "agent_engine.config.invalid", fields);
    if (result.fatal) throw new ResearchProbeError(result.code as ResearchProbeCode, result.relation);
  }
  return result;
}
