import { AgentContractError } from "./contract";

/**
 * Agent engine configuration (Stage 5 / Task 1). DISABLED BY DEFAULT: until real agents exist the engine does nothing and the risk flow is exactly as before. A malformed override
 * THROWS (the process does not start with a silently wrong configuration), like the sizing and expiry configurations.
 *
 *   TWINS_AGENT_ENGINE_ENABLED         true | false (default false)
 *   TWINS_AGENT_ENGINE_REQUIRED        comma list of agent ids whose COMPLETED result is mandatory (default: signal-integrity-v1, instrument-verification-v1; set to an empty value for none)
 *   TWINS_AGENT_ENGINE_DISABLED_AGENTS comma list of agent ids switched off
 *   TWINS_AGENT_ENGINE_WEIGHTS         JSON {"agent_id": 0-100} overriding contract weights
 *   TWINS_AGENT_ENGINE_MAX_CONCURRENCY 1-16 (default 4)
 *   TWINS_AGENT_ENGINE_HALT_ON         comma list of assessments that stop the risk flow before sizing (default RESEARCH_BLOCKED,RESEARCH_INCOMPLETE,RESEARCH_ADVERSE)
 */
export const AGENT_CONFIG_VERSION = "agent-engine-config-v1";
/** Stage 5 / Task 2: when the engine is enabled and TWINS_AGENT_ENGINE_REQUIRED is not set, both production agents are REQUIRED (a missing result fails closed). */
export const DEFAULT_REQUIRED_AGENTS: readonly string[] = ["instrument-verification-v1", "signal-integrity-v1"];
export const ASSESSMENTS = ["RESEARCH_SUPPORTIVE", "RESEARCH_NEUTRAL", "RESEARCH_CAUTION", "RESEARCH_ADVERSE", "RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE"] as const;
export type ResearchAssessment = (typeof ASSESSMENTS)[number];

export interface SynthesisThresholds {
  /** Weighted mean score (-1..+1) at or above which the assessment is SUPPORTIVE / NEUTRAL / CAUTION; below `cautionMin` it is ADVERSE. */
  supportiveMin: number; neutralMin: number; cautionMin: number;
  /** A COMPLETED ADVERSE verdict from a scoring agent of at least this weight makes the assessment ADVERSE regardless of the mean (101 disables). */
  adverseVetoWeight: number;
}
export interface AgentEngineConfig {
  version: string;
  enabled: boolean;
  requiredAgents: string[];
  disabledAgents: string[];
  weights: Record<string, number>;
  maxConcurrency: number;
  haltOn: ResearchAssessment[];
  thresholds: SynthesisThresholds;
}
export const DEFAULT_THRESHOLDS: SynthesisThresholds = { supportiveMin: 0.35, neutralMin: -0.15, cautionMin: -0.5, adverseVetoWeight: 50 };
export const DEFAULT_AGENT_CONFIG: AgentEngineConfig = {
  version: AGENT_CONFIG_VERSION, enabled: false, requiredAgents: [], disabledAgents: [], weights: {}, maxConcurrency: 4,
  haltOn: ["RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE", "RESEARCH_ADVERSE"], thresholds: DEFAULT_THRESHOLDS,
};
const AGENT_ID = /^[a-z][a-z0-9_-]{2,40}$/;
const bad = (what: string): never => { throw new AgentContractError("INVALID_ENGINE_CONFIG", `invalid agent engine configuration: ${what}`); };
const list = (v: string | undefined, name: string): string[] => {
  if (v === undefined || v.trim() === "") return [];
  const items = v.split(",").map((x) => x.trim());
  if (items.some((x) => !AGENT_ID.test(x)) || new Set(items).size !== items.length) bad(name);
  return items.sort();
};

export function validateAgentEngineConfig(c: AgentEngineConfig): AgentEngineConfig {
  if (typeof c.enabled !== "boolean") bad("enabled");
  if (!Number.isInteger(c.maxConcurrency) || c.maxConcurrency < 1 || c.maxConcurrency > 16) bad("maxConcurrency");
  for (const id of [...c.requiredAgents, ...c.disabledAgents, ...Object.keys(c.weights)]) if (!AGENT_ID.test(id)) bad("agent id");
  if (c.requiredAgents.some((id) => c.disabledAgents.includes(id))) bad("an agent cannot be both required and disabled");
  for (const w of Object.values(c.weights)) if (!Number.isInteger(w) || w < 0 || w > 100) bad("weight");
  if (c.haltOn.some((a) => !(ASSESSMENTS as readonly string[]).includes(a))) bad("haltOn");
  const t = c.thresholds;
  if (![t.supportiveMin, t.neutralMin, t.cautionMin].every((x) => Number.isFinite(x) && x >= -1 && x <= 1) || !(t.supportiveMin > t.neutralMin && t.neutralMin > t.cautionMin) || !Number.isInteger(t.adverseVetoWeight) || t.adverseVetoWeight < 0 || t.adverseVetoWeight > 101) bad("thresholds");
  return c;
}

export function loadAgentEngineConfig(env: Record<string, string | undefined> = process.env): AgentEngineConfig {
  const flag = env["TWINS_AGENT_ENGINE_ENABLED"];
  if (flag !== undefined && flag !== "true" && flag !== "false") bad("TWINS_AGENT_ENGINE_ENABLED must be true or false");
  let weights: Record<string, number> = {};
  const w = env["TWINS_AGENT_ENGINE_WEIGHTS"];
  if (w !== undefined && w.trim() !== "") {
    try { weights = JSON.parse(w) as Record<string, number>; } catch { bad("TWINS_AGENT_ENGINE_WEIGHTS is not JSON"); }
    if (typeof weights !== "object" || weights === null || Array.isArray(weights)) bad("TWINS_AGENT_ENGINE_WEIGHTS must be an object");
  }
  const conc = env["TWINS_AGENT_ENGINE_MAX_CONCURRENCY"];
  if (conc !== undefined && !/^\d{1,2}$/.test(conc)) bad("TWINS_AGENT_ENGINE_MAX_CONCURRENCY");
  const halt = env["TWINS_AGENT_ENGINE_HALT_ON"];
  return validateAgentEngineConfig({
    ...DEFAULT_AGENT_CONFIG, enabled: flag === "true", requiredAgents: env["TWINS_AGENT_ENGINE_REQUIRED"] === undefined ? [...DEFAULT_REQUIRED_AGENTS] : list(env["TWINS_AGENT_ENGINE_REQUIRED"], "TWINS_AGENT_ENGINE_REQUIRED"), disabledAgents: list(env["TWINS_AGENT_ENGINE_DISABLED_AGENTS"], "TWINS_AGENT_ENGINE_DISABLED_AGENTS"),
    weights, maxConcurrency: conc === undefined ? DEFAULT_AGENT_CONFIG.maxConcurrency : Number(conc),
    haltOn: halt === undefined || halt.trim() === "" ? DEFAULT_AGENT_CONFIG.haltOn : (halt.split(",").map((x) => x.trim()) as ResearchAssessment[]),
  });
}
