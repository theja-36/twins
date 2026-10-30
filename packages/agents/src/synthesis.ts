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
 * Task 8 (v2) makes the result transparent without changing a single decision rule: per-agent summaries, the reasons grouped by verdict class, the weighted-score breakdown, the evaluation of every rule and
 * threshold in order, and a clear halt reason. All of it is derived from the same inputs (agent ids, verdicts, confidences, finding CODES - never free text), so it is as deterministic as the assessment.
 * Advisory-only agents are reported but never scored and never block. Timestamps and durations are NOT part of the synthesis input, so identical agent results always synthesize
 * identically.
 */
export const SYNTHESIS_ALGORITHM_VERSION = "research-synthesis-v2";
/** The assessments that stop the risk flow before sizing, unless the configuration says otherwise (mirrors `DEFAULT_HALT_ON` of the engine configuration). */
const DEFAULT_HALT_ON: ResearchAssessment[] = ["RESEARCH_BLOCKED", "RESEARCH_INCOMPLETE", "RESEARCH_ADVERSE"];
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
  /** Assessments that halt the flow (explains the halt reason); defaults to BLOCKED, INCOMPLETE and ADVERSE. */
  haltOn?: ResearchAssessment[];
  agents: SynthesisInputAgent[];
}
export type DecidedBy = "BLOCKING_VERDICT" | "REQUIRED_AGENT_MISSING" | "NO_SCORING_RESULTS" | "ADVERSE_VETO" | "WEIGHTED_SCORE";
export interface AgentSummary { agentId: string; agentVersion: string; status: AgentStatus; verdict: AgentVerdict; confidence: number | null; weight: number; required: boolean; canBlock: boolean; advisoryOnly: boolean; scored: boolean; reasonCodes: string[]; errorCode: string | null }
export interface VerdictReason { agentId: string; verdict: AgentVerdict; weight: number; confidence: number; findingCodes: string[]; /** false when the verdict does not count (an agent that cannot block, or an advisory one). */ counted: boolean }
export interface UnavailableReason { agentId: string; status: AgentStatus; errorCode: string | null; required: boolean }
export interface ThresholdCheck { rule: string; assessmentIfMet: ResearchAssessment; threshold: number | null; value: number | null; met: boolean; /** false when an earlier rule had already decided the assessment. */ reached: boolean }
export interface HaltDecision { halt: boolean; haltOn: ResearchAssessment[]; assessment: ResearchAssessment; reasonCode: string; reason: string }
export interface SynthesisResult {
  algorithmVersion: string;
  assessment: ResearchAssessment;
  /** Weighted mean in [-1, 1]; null when nothing was scored. */
  score: number | null;
  contributions: Array<{ agentId: string; weight: number; confidence: number; verdict: AgentVerdict; contribution: number }>;
  /** One row per agent that took part (scored or not), with the codes that explain its verdict or its absence. */
  agentSummaries: AgentSummary[];
  /** The reasons grouped by verdict class: blocking, adverse, caution, neutral (SUPPORTIVE / NEUTRAL) and unavailable (no COMPLETED result). */
  reasons: { blocking: VerdictReason[]; adverse: VerdictReason[]; caution: VerdictReason[]; neutral: VerdictReason[]; unavailable: UnavailableReason[] };
  /** The arithmetic of the weighted mean: score = sum(weight x confidence/100 x verdictScore) / sum(weight). */
  scoreBreakdown: { formula: string; verdictScores: Record<string, number>; totalWeight: number; weightedSum: number; score: number | null; rows: Array<{ agentId: string; weight: number; weightShare: number; confidence: number; verdict: AgentVerdict; verdictScore: number; contribution: number }> };
  /** Every rule in evaluation order (blocking, incomplete, adverse veto, weighted mean) and which one decided. */
  thresholdEvaluation: { decidedBy: DecidedBy; thresholds: SynthesisThresholds; checks: ThresholdCheck[] };
  /** Whether the flow halts at the worker halt point, and the clear reason. */
  halt: HaltDecision;
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

export function buildSynthesisInput(ref: { riskDecisionId: string; decisionVersion: number }, results: AgentRunResult[], metas: AgentMeta[], config: Pick<AgentEngineConfig, "requiredAgents" | "thresholds"> & Partial<Pick<AgentEngineConfig, "haltOn">>): SynthesisInput {
  const meta = new Map(metas.map((m) => [m.agentId, m]));
  const agents = results.map((r): SynthesisInputAgent => {
    const m = meta.get(r.agentId) as AgentMeta;
    return { ...m, status: r.status, verdict: r.verdict, confidence: r.confidence, findings: r.findings.map((f) => ({ code: f.code, severity: f.severity })).sort((a, b) => (a.code < b.code ? -1 : 1)), outputSha256: hashOf(r.outputSnapshot), errorCode: r.errorCode };
  }).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  return { algorithmVersion: SYNTHESIS_ALGORITHM_VERSION, riskDecisionId: ref.riskDecisionId, decisionVersion: ref.decisionVersion, thresholds: config.thresholds, requiredAgents: [...config.requiredAgents].sort(), ...(config.haltOn ? { haltOn: [...config.haltOn].sort() } : {}), agents };
}

const codesOf = (a: SynthesisInputAgent): string[] => [...new Set(a.findings.filter((f) => f.severity !== "INFO").map((f) => f.code))].slice(0, 10);
const HALT_TEXT: Record<DecidedBy, string> = {
  BLOCKING_VERDICT: "a COMPLETED BLOCKING verdict from an agent that may block",
  REQUIRED_AGENT_MISSING: "a required agent has no COMPLETED result",
  NO_SCORING_RESULTS: "no agent produced a scoring result",
  ADVERSE_VETO: "an ADVERSE verdict from an agent at or above the veto weight",
  WEIGHTED_SCORE: "the weighted score is below the caution threshold",
};

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
  const weightedSum = round(contributions.reduce((s, c) => s + c.contribution, 0));
  const score = totalWeight > 0 ? round(contributions.reduce((s, c) => s + c.contribution, 0) / totalWeight) : null;
  const t = input.thresholds;
  const vetoAgents = scoring.filter((a) => a.verdict === "ADVERSE" && a.weight >= t.adverseVetoWeight);

  // the decision rules, in their fixed order: blocking, incomplete, adverse veto, weighted mean
  let assessment: ResearchAssessment, decidedBy: DecidedBy;
  if (unavailableOptional.length > 0) notes.push("OPTIONAL_AGENTS_UNAVAILABLE");
  if (blockers.length > 0) { notes.push("BLOCKING_VERDICT"); assessment = "RESEARCH_BLOCKED"; decidedBy = "BLOCKING_VERDICT"; }
  else if (missingRequired.length > 0) { notes.push("REQUIRED_AGENT_RESULT_MISSING"); assessment = "RESEARCH_INCOMPLETE"; decidedBy = "REQUIRED_AGENT_MISSING"; }
  else if (scoring.length === 0) { notes.push("NO_SCORING_RESULTS"); assessment = "RESEARCH_INCOMPLETE"; decidedBy = "NO_SCORING_RESULTS"; }
  else if (vetoAgents.length > 0) { notes.push("ADVERSE_VETO"); assessment = "RESEARCH_ADVERSE"; decidedBy = "ADVERSE_VETO"; }
  else {
    const sc = score as number;
    assessment = sc >= t.supportiveMin ? "RESEARCH_SUPPORTIVE" : sc >= t.neutralMin ? "RESEARCH_NEUTRAL" : sc >= t.cautionMin ? "RESEARCH_CAUTION" : "RESEARCH_ADVERSE";
    decidedBy = "WEIGHTED_SCORE";
  }

  // transparency (derived from the same inputs; changes no decision)
  const order: DecidedBy[] = ["BLOCKING_VERDICT", "REQUIRED_AGENT_MISSING", "NO_SCORING_RESULTS", "ADVERSE_VETO", "WEIGHTED_SCORE"];
  const reached = (rule: DecidedBy): boolean => order.indexOf(rule) <= order.indexOf(decidedBy);
  const scored = new Set(scoring.map((a) => a.agentId));
  const agentSummaries: AgentSummary[] = input.agents.map((a) => ({
    agentId: a.agentId, agentVersion: a.agentVersion, status: a.status, verdict: a.verdict, confidence: a.confidence, weight: a.weight, required: a.required, canBlock: a.canBlock, advisoryOnly: a.advisoryOnly,
    scored: scored.has(a.agentId), reasonCodes: a.status === "COMPLETED" ? codesOf(a) : a.errorCode ? [a.errorCode] : [], errorCode: a.errorCode,
  }));
  const reason = (a: SynthesisInputAgent): VerdictReason => ({ agentId: a.agentId, verdict: a.verdict, weight: a.weight, confidence: a.confidence ?? 0, findingCodes: codesOf(a), counted: a.canBlock && !a.advisoryOnly });
  const scoreSc = score;
  const checks: ThresholdCheck[] = [
    { rule: "blocking_verdict", assessmentIfMet: "RESEARCH_BLOCKED", threshold: null, value: blockers.length, met: blockers.length > 0, reached: reached("BLOCKING_VERDICT") },
    { rule: "required_agent_result", assessmentIfMet: "RESEARCH_INCOMPLETE", threshold: 0, value: missingRequired.length, met: missingRequired.length > 0, reached: reached("REQUIRED_AGENT_MISSING") },
    { rule: "scoring_result_exists", assessmentIfMet: "RESEARCH_INCOMPLETE", threshold: 1, value: scoring.length, met: scoring.length === 0, reached: reached("NO_SCORING_RESULTS") },
    { rule: "adverse_veto", assessmentIfMet: "RESEARCH_ADVERSE", threshold: t.adverseVetoWeight, value: vetoAgents.length > 0 ? Math.max(...vetoAgents.map((a) => a.weight)) : null, met: vetoAgents.length > 0, reached: reached("ADVERSE_VETO") },
    { rule: "score_supportive_min", assessmentIfMet: "RESEARCH_SUPPORTIVE", threshold: t.supportiveMin, value: scoreSc, met: scoreSc !== null && scoreSc >= t.supportiveMin, reached: reached("WEIGHTED_SCORE") },
    { rule: "score_neutral_min", assessmentIfMet: "RESEARCH_NEUTRAL", threshold: t.neutralMin, value: scoreSc, met: scoreSc !== null && scoreSc >= t.neutralMin, reached: reached("WEIGHTED_SCORE") },
    { rule: "score_caution_min", assessmentIfMet: "RESEARCH_CAUTION", threshold: t.cautionMin, value: scoreSc, met: scoreSc !== null && scoreSc >= t.cautionMin, reached: reached("WEIGHTED_SCORE") },
    { rule: "score_below_caution_min", assessmentIfMet: "RESEARCH_ADVERSE", threshold: t.cautionMin, value: scoreSc, met: scoreSc !== null && scoreSc < t.cautionMin, reached: reached("WEIGHTED_SCORE") },
  ];
  const haltOn = input.haltOn ?? DEFAULT_HALT_ON;
  const halts = haltOn.includes(assessment);
  const detail = decidedBy === "BLOCKING_VERDICT" ? ` (${blockers.map((b) => b.agentId).join(", ")})` : decidedBy === "REQUIRED_AGENT_MISSING" ? ` (${missingRequired.map((m) => m.agentId).join(", ")})` : decidedBy === "ADVERSE_VETO" ? ` (${vetoAgents.map((a) => a.agentId).join(", ")})` : decidedBy === "WEIGHTED_SCORE" && score !== null ? ` (score ${score})` : "";
  const halt: HaltDecision = {
    halt: halts, haltOn: [...haltOn], assessment,
    reasonCode: halts ? `HALT_${decidedBy}` : "NO_HALT",
    reason: halts ? `The flow halts: ${assessment} was decided by ${HALT_TEXT[decidedBy]}${detail}.` : `The flow continues: ${assessment} is not in the halt list (${haltOn.join(", ") || "empty"}); every later gate still runs.`,
  };
  const base = {
    algorithmVersion: SYNTHESIS_ALGORITHM_VERSION, score, contributions, agentSummaries,
    reasons: {
      blocking: completed.filter((a) => a.verdict === "BLOCKING").map(reason), adverse: completed.filter((a) => a.verdict === "ADVERSE").map(reason), caution: completed.filter((a) => a.verdict === "CAUTION").map(reason),
      neutral: completed.filter((a) => a.verdict === "NEUTRAL" || a.verdict === "SUPPORTIVE").map(reason), unavailable: input.agents.filter((a) => a.status !== "COMPLETED").map((a) => ({ agentId: a.agentId, status: a.status, errorCode: a.errorCode, required: a.required })),
    },
    scoreBreakdown: {
      formula: "score = sum(weight x confidence/100 x verdictScore) / sum(weight)", verdictScores: { ...VERDICT_SCORE } as Record<string, number>, totalWeight, weightedSum, score,
      rows: scoring.map((a, n) => ({ agentId: a.agentId, weight: a.weight, weightShare: totalWeight > 0 ? round(a.weight / totalWeight) : 0, confidence: a.confidence ?? 0, verdict: a.verdict, verdictScore: VERDICT_SCORE[a.verdict] as number, contribution: (contributions[n] as { contribution: number }).contribution })),
    },
    thresholdEvaluation: { decidedBy, thresholds: { ...t }, checks }, halt,
    blockers: blockers.map((b) => ({ agentId: b.agentId, findingCodes: b.findings.map((f) => f.code) })), missingRequired, unavailableOptional, advisory, grantsApproval: false as const, inputSha256: hashOf(input),
  };
  return { ...base, assessment, notes };
}
