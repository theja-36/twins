import { synthesize, type SynthesisInput, type SynthesisInputAgent, type SynthesisResult } from "./synthesis";

/**
 * Multi-agent debate record (P1 #13). PURE and deterministic: turns one synthesis input into a structured, auditable "debate" between the agents that argue FOR and AGAINST the trade, without any model,
 * free text or randomness. It adds three things the plain synthesis does not show: the two sides' weighted strength, the codes each side cites against the other (challenge and rebuttal), and the PIVOTAL
 * agents (the ones whose verdict, if neutralised, would change the research assessment, found by re-running the real `synthesize`). Only agent ids, verdicts, confidences and finding CODES pass through.
 * It is evidence about disagreement, never an approval (`grantsApproval: false`) and never changes the assessment.
 */
export const DEBATE_VERSION = "agent-debate-v1";
export type Side = "FOR" | "AGAINST" | "NEUTRAL" | "ABSENT";
export interface Position { agentId: string; verdict: string; weight: number; confidence: number; strength: number; findingCodes: string[]; canBlock: boolean }
export interface DebateRound { round: 1 | 2 | 3; title: string; points: string[] }
export interface Debate {
  version: typeof DEBATE_VERSION; assessment: SynthesisResult["assessment"]; decidedBy: string; score: number | null;
  sides: Record<Side, Position[]>;
  strength: { for: number; against: number; neutral: number; total: number };
  /** (for - against) / (for + against) in [-1, 1]; null when neither side has weight. */
  agreementIndex: number | null;
  /** Both sides carry real weight (each at least `contestedShare` of the decided weight). */
  contested: boolean;
  challenges: Array<{ from: string; against: string[]; codes: string[] }>;
  rebuttals: Array<{ from: string; supports: string[]; codes: string[] }>;
  pivotalAgents: Array<{ agentId: string; flipsTo: SynthesisResult["assessment"] }>;
  rounds: DebateRound[];
  grantsApproval: false;
}
const SCORING = new Set(["SUPPORTIVE", "NEUTRAL", "CAUTION", "ADVERSE", "BLOCKING"]);
const round = (x: number): number => Math.round(x * 1e4) / 1e4;
const codesOf = (a: SynthesisInputAgent): string[] => a.findings.map((f) => f.code).sort();

export function buildDebate(input: SynthesisInput, opts: { contestedShare?: number } = {}): Debate {
  const contestedShare = opts.contestedShare ?? 0.25;
  const base = synthesize(input);
  const sides: Record<Side, Position[]> = { FOR: [], AGAINST: [], NEUTRAL: [], ABSENT: [] };
  const sorted = [...input.agents].sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  for (const a of sorted) {
    const completed = a.status === "COMPLETED" && SCORING.has(a.verdict);
    const conf = a.confidence ?? 0;
    const pos: Position = { agentId: a.agentId, verdict: a.verdict, weight: a.weight, confidence: conf, strength: round(a.weight * (conf / 100)), findingCodes: codesOf(a), canBlock: a.canBlock && !a.advisoryOnly };
    if (!completed) sides.ABSENT.push(pos);
    else if (a.verdict === "SUPPORTIVE") sides.FOR.push(pos);
    else if (a.verdict === "NEUTRAL") sides.NEUTRAL.push(pos);
    else sides.AGAINST.push(pos); // CAUTION, ADVERSE, BLOCKING
  }
  const sum = (ps: Position[]): number => round(ps.reduce((s, p) => s + p.strength, 0));
  const f = sum(sides.FOR), ag = sum(sides.AGAINST), ne = sum(sides.NEUTRAL);
  const agreementIndex = f + ag === 0 ? null : round((f - ag) / (f + ag));
  const total = round(f + ag + ne);
  const contested = total > 0 && f / total >= contestedShare && ag / total >= contestedShare;

  const challenges = sides.AGAINST.filter((p) => p.findingCodes.length > 0).map((p) => ({ from: p.agentId, against: sides.FOR.map((x) => x.agentId), codes: p.findingCodes }));
  const rebuttals = sides.FOR.filter((p) => p.findingCodes.length > 0).map((p) => ({ from: p.agentId, supports: sides.AGAINST.map((x) => x.agentId), codes: p.findingCodes }));

  // Pivotal agents: neutralise one completed, scoring agent at a time (verdict NEUTRAL, confidence 0) and re-run the real synthesis.
  const pivotalAgents: Debate["pivotalAgents"] = [];
  for (const a of sorted) {
    if (a.status !== "COMPLETED" || a.advisoryOnly || a.verdict === "NEUTRAL") continue;
    const alt = synthesize({ ...input, agents: input.agents.map((x) => (x.agentId === a.agentId ? { ...x, verdict: "NEUTRAL" as const, confidence: 0, findings: [] } : x)) });
    if (alt.assessment !== base.assessment) pivotalAgents.push({ agentId: a.agentId, flipsTo: alt.assessment });
  }

  const names = (ps: Position[]): string => (ps.length ? ps.map((p) => p.agentId).join(", ") : "none");
  const rounds: DebateRound[] = [
    { round: 1, title: "Opening positions", points: [`FOR (${f}): ${names(sides.FOR)}`, `AGAINST (${ag}): ${names(sides.AGAINST)}`, `NEUTRAL (${ne}): ${names(sides.NEUTRAL)}`, `NO RESULT: ${names(sides.ABSENT)}`] },
    { round: 2, title: "Challenge and rebuttal (finding codes only)", points: [...challenges.map((c) => `${c.from} cites ${c.codes.join(", ")}`), ...rebuttals.map((r) => `${r.from} cites ${r.codes.join(", ")}`)] },
    { round: 3, title: "Outcome", points: [`assessment ${base.assessment}, decided by ${base.thresholdEvaluation.decidedBy}`, contested ? "the agents are genuinely split" : "one side carries most of the weight", `pivotal: ${pivotalAgents.length ? pivotalAgents.map((p) => `${p.agentId}->${p.flipsTo}`).join(", ") : "none"}`] },
  ];
  return { version: DEBATE_VERSION, assessment: base.assessment, decidedBy: base.thresholdEvaluation.decidedBy, score: base.score, sides, strength: { for: f, against: ag, neutral: ne, total }, agreementIndex, contested, challenges, rebuttals, pivotalAgents, rounds, grantsApproval: false };
}
