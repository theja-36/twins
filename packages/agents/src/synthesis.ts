import type { AgentEngineConfig, ResearchAssessment, SynthesisThresholds } from "./config";
import type { AgentRunResult, AgentStatus, AgentVerdict } from "./contract";
import { hashOf } from "./sanitize";

/**
 * Synthesis (Stage 5 / Task 1): a PURE, deterministic function of the agent results and the configuration. It produces a RESEARCH ASSESSMENT - never an approval. The result
 * carries the literal `grantsApproval: false`; it creates no APPROVED_FOR_REVIEW and bypasses no sizing, portfolio, market, breaker, expiry, kill-switch or approval gate.
 *
 *   1. a COMPLETED BLOCKING verdict from an agent that may block (and is not advisory)          -> RESEARCH_BLOCKED   (evidence of a block wins over missing data)
 *   2. a required agent without a COMPLETED result, or no scoring result at all                 -> RESEARCH_INCOMPLETE (fail closed)
 *   3. a COMPLETED ADVERSE verdict from a scoring agent with weight >= adverseVetoWeight        -> RESEARCH_ADVERSE
 *   4. otherwise the weighted mean score  sum(weight x confidence/100 x verdictScore) / sum(weight)  vs the thresholds
 *      (SUPPORTIVE +1, NEUTRAL 0, CAUTION -0.5, ADVERSE -1; low confidence pulls an agent toward neutral).
 * Advisory-only agents are reported but never scored and never block. Timestamps and durations are NOT part of the synthesis input, so identical agent results always synthesize
 * identically.
 */
export const SYNTHESIS_ALGORITHM_VERSION = "research-synthesis-v1";
const VERDICT_SCORE: Partial<Record<AgentVerdict, number>> = { SUPPORTIVE: 1, NEUTRAL: 0, CAUTION: -0.5, ADVERSE: -1 };

export interface AgentMeta { agentId: string; agentVersion: string; weight: number; canBlock: boolean; advisoryOnly: boolean; required: boolean }
export interface SynthesisInputAgent extends AgentMeta {
  status: AgentStatus; verdict: AgentVerdict; confidence: number | null; findings: Array<{ code: string; severity: string }>; outputSha256: string; errorCode: string | null;
}
export interface SynthesisInput {
  algorithmVersion: string;
  riskDecisionId: string;
  decisionVersion: number;
  thresholds: SynthesisThresholds;
  requiredAgents: string[];
  agents: SynthesisInputAgent[];
}
export interface SynthesisResult {
  algorithmVersion: string;
  assessment: ResearchAssessment;
  /** Weighted mean in [-1, 1]; null when nothing was scored. */
  score: number | null;
  contributions: Array<{ agentId: string; weight: number; confidence: number; verdict: AgentVerdict; contribution: number }>;
  blockers: Array<{ agentId: string; findingCodes: string[] }>;
  missingRequired: Array<{ agentId: string; status: AgentStatus; errorCode: string | null }>;
  unavailableOptional: string[];
  advisory: Array<{ agentId: string; verdict: AgentVerdict; confidence: number | null }>;
  notes: string[];
  /** Always false: a research assessment is evidence for the later gates, never an approval. */
  grantsApproval: false;
  inputSha256: string;
}
const round = (x: number): number => Math.round(x * 1e6) / 1e6;

export function buildSynthesisInput(ref: { riskDecisionId: string; decisionVersion: number }, results: AgentRunResult[], metas: AgentMeta[], config: Pick<AgentEngineConfig, "requiredAgents" | "thresholds">): SynthesisInput {
  const meta = new Map(metas.map((m) => [m.agentId, m]));
  const agents = results.map((r): SynthesisInputAgent => {
    const m = meta.get(r.agentId) as AgentMeta;
    return { ...m, status: r.status, verdict: r.verdict, confidence: r.confidence, findings: r.findings.map((f) => ({ code: f.code, severity: f.severity })).sort((a, b) => (a.code < b.code ? -1 : 1)), outputSha256: hashOf(r.outputSnapshot), errorCode: r.errorCode };
  }).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  return { algorithmVersion: SYNTHESIS_ALGORITHM_VERSION, riskDecisionId: ref.riskDecisionId, decisionVersion: ref.decisionVersion, thresholds: config.thresholds, requiredAgents: [...config.requiredAgents].sort(), agents };
}

export function synthesize(input: SynthesisInput): SynthesisResult {
  const notes: string[] = [];
  const completed = input.agents.filter((a) => a.status === "COMPLETED");
  const blockers = completed.filter((a) => a.canBlock && !a.advisoryOnly && a.verdict === "BLOCKING");
  const missingRequired = input.agents.filter((a) => a.required && a.status !== "COMPLETED").map((a) => ({ agentId: a.agentId, status: a.status, errorCode: a.errorCode }));
  const scoring = completed.filter((a) => !a.advisoryOnly && a.weight > 0 && VERDICT_SCORE[a.verdict] !== undefined);
  const advisory = input.agents.filter((a) => a.advisoryOnly).map((a) => ({ agentId: a.agentId, verdict: a.verdict, confidence: a.confidence }));
  const unavailableOptional = input.agents.filter((a) => !a.required && !a.advisoryOnly && a.status !== "COMPLETED").map((a) => a.agentId);
  const contributions = scoring.map((a) => ({ agentId: a.agentId, weight: a.weight, confidence: a.confidence ?? 0, verdict: a.verdict, contribution: round(a.weight * ((a.confidence ?? 0) / 100) * (VERDICT_SCORE[a.verdict] as number)) }));
  const totalWeight = scoring.reduce((s, a) => s + a.weight, 0);
  const score = totalWeight > 0 ? round(contributions.reduce((s, c) => s + c.contribution, 0) / totalWeight) : null;
  const base = { algorithmVersion: SYNTHESIS_ALGORITHM_VERSION, score, contributions, blockers: blockers.map((b) => ({ agentId: b.agentId, findingCodes: b.findings.map((f) => f.code) })), missingRequired, unavailableOptional, advisory, grantsApproval: false as const, inputSha256: hashOf(input) };
  const done = (assessment: ResearchAssessment): SynthesisResult => ({ ...base, assessment, notes });
  if (unavailableOptional.length > 0) notes.push("OPTIONAL_AGENTS_UNAVAILABLE");
  if (blockers.length > 0) { notes.push("BLOCKING_VERDICT"); return done("RESEARCH_BLOCKED"); }
  if (missingRequired.length > 0) { notes.push("REQUIRED_AGENT_RESULT_MISSING"); return done("RESEARCH_INCOMPLETE"); }
  if (scoring.length === 0) { notes.push("NO_SCORING_RESULTS"); return done("RESEARCH_INCOMPLETE"); }
  if (scoring.some((a) => a.verdict === "ADVERSE" && a.weight >= input.thresholds.adverseVetoWeight)) { notes.push("ADVERSE_VETO"); return done("RESEARCH_ADVERSE"); }
  const s = score as number;
  const t = input.thresholds;
  return done(s >= t.supportiveMin ? "RESEARCH_SUPPORTIVE" : s >= t.neutralMin ? "RESEARCH_NEUTRAL" : s >= t.cautionMin ? "RESEARCH_CAUTION" : "RESEARCH_ADVERSE");
}
