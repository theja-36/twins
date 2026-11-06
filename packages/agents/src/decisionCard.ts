import type { SynthesisResult } from "./synthesis";

/**
 * Explainable decision card (P0 #6). A pure, read-only view assembled ONLY from records that already exist: the stored synthesis result, optionally the sizing record and the source-health
 * profile. It computes no decision, writes nothing, contains no model-generated prose and never carries agent finding text, inputs or message text: every sentence is a fixed template over
 * stored fields and codes. It is evidence for the human reviewer; `grantsApproval` is always false.
 */
export const DECISION_CARD_FORMAT = "twins-decision-card-v1";
/** A numeric rule counts as a "close call" when the value is within this distance of its threshold (the score runs from -1 to 1). */
export const CLOSE_CALL_MARGIN = 0.15;

export interface CardSizing { status: string; reasonCode: string | null; quantity: number; maxLossPercent: number | null; riskReward: number | null; trustTier: string | null }
export interface CardSourceHealth { overall: string; providers: ReadonlyArray<{ provider: string; status: string; reasons: readonly string[]; usable: boolean }> }
export interface CardInput {
  riskDecisionId: string;
  decisionVersion: number | null;
  runId: string | null;
  /** The stored synthesis `result` (jsonb). Read defensively: a malformed value yields `null`, never a guess. */
  synthesis: unknown;
  sizing?: CardSizing | null;
  sourceHealth?: CardSourceHealth | null;
}
export interface CloseCall { rule: string; threshold: number; value: number; met: boolean; margin: number }
export interface DecisionCard {
  format: typeof DECISION_CARD_FORMAT;
  riskDecisionId: string;
  decisionVersion: number | null;
  runId: string | null;
  headline: { assessment: string; decidedBy: string; score: number | null; halts: boolean; haltReason: string };
  agents: Array<{ agentId: string; verdict: string; status: string; confidence: number | null; weight: number; required: boolean; scored: boolean; reasonCodes: string[]; errorCode: string | null }>;
  blockers: Array<{ agentId: string; findingCodes: string[] }>;
  unavailable: Array<{ agentId: string; status: string; errorCode: string | null; required: boolean }>;
  closeCalls: CloseCall[];
  sizing: CardSizing | null;
  sourceHealth: { overall: string; notUsable: Array<{ provider: string; status: string; reasons: string[] }> } | null;
  statements: string[];
  /** Always false: the card explains a research assessment; it never approves anything. */
  grantsApproval: false;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length <= 200 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const codes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(x)) : []);
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Builds the card, or `null` when the stored synthesis cannot be read (the caller reports "no readable assessment", never an invented one). */
export function buildDecisionCard(input: CardInput): DecisionCard | null {
  const s = input.synthesis;
  if (!isObj(s)) return null;
  const assessment = str(s["assessment"]), te = isObj(s["thresholdEvaluation"]) ? s["thresholdEvaluation"] : null, decidedBy = str(te?.["decidedBy"]);
  if (assessment === null || decidedBy === null || !Array.isArray(s["agentSummaries"])) return null;
  const halt = isObj(s["halt"]) ? s["halt"] : {};
  const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);

  const agents = rows(s["agentSummaries"]).flatMap((a) => {
    const agentId = str(a["agentId"]), verdict = str(a["verdict"]), status = str(a["status"]), weight = num(a["weight"]);
    return agentId && verdict && status && weight !== null
      ? [{ agentId, verdict, status, confidence: num(a["confidence"]), weight, required: a["required"] === true, scored: a["scored"] === true, reasonCodes: codes(a["reasonCodes"]), errorCode: str(a["errorCode"]) }]
      : [];
  });
  const blockers = rows(s["blockers"]).flatMap((b) => { const agentId = str(b["agentId"]); return agentId ? [{ agentId, findingCodes: codes(b["findingCodes"]) }] : []; });
  const reasons = isObj(s["reasons"]) ? s["reasons"] : {};
  const unavailable = rows(reasons["unavailable"]).flatMap((u) => { const agentId = str(u["agentId"]), status = str(u["status"]); return agentId && status ? [{ agentId, status, errorCode: str(u["errorCode"]), required: u["required"] === true }] : []; });

  // Close calls: the numeric score rules that were actually evaluated and whose value sits near the threshold. This is arithmetic over stored numbers, not a prediction.
  const closeCalls: CloseCall[] = rows(te?.["checks"]).flatMap((c) => {
    const rule = str(c["rule"]), threshold = num(c["threshold"]), value = num(c["value"]);
    if (!rule || !rule.startsWith("score_") || c["reached"] !== true || threshold === null || value === null) return [];
    const margin = r3(value - threshold);
    return Math.abs(margin) <= CLOSE_CALL_MARGIN ? [{ rule, threshold, value, met: c["met"] === true, margin }] : [];
  });

  const health = input.sourceHealth ?? null;
  const notUsable = health === null ? [] : health.providers.filter((p) => !p.usable).map((p) => ({ provider: p.provider, status: p.status, reasons: [...p.reasons] }));
  const score = num(s["score"]);

  const statements: string[] = [`Research assessment ${assessment} was decided by ${decidedBy}${score === null ? " (no score)" : ` (score ${r3(score)})`}.`];
  if (blockers.length) statements.push(`Blocking verdict from: ${blockers.map((b) => b.agentId).join(", ")}.`);
  if (unavailable.length) statements.push(`${unavailable.length} agent(s) produced no result: ${unavailable.map((u) => `${u.agentId}${u.required ? " (required)" : ""}`).join(", ")}.`);
  for (const c of closeCalls) statements.push(`Close call on ${c.rule}: value ${c.value} against threshold ${c.threshold} (margin ${c.margin}, rule ${c.met ? "met" : "not met"}).`);
  if (input.sizing) statements.push(`Decision ${input.sizing.status}${input.sizing.reasonCode ? ` (${input.sizing.reasonCode})` : ""}: planned quantity ${input.sizing.quantity}${input.sizing.maxLossPercent === null ? "" : `, maximum loss ${input.sizing.maxLossPercent}% of capital`}${input.sizing.trustTier ? `, source trust tier ${input.sizing.trustTier}` : ""}.`);
  if (health !== null && notUsable.length) statements.push(`Source health is ${health.overall}; not usable now: ${notUsable.map((p) => `${p.provider} (${p.status})`).join(", ")}.`);
  statements.push("This card explains a research assessment. It is not an approval.");

  return {
    format: DECISION_CARD_FORMAT, riskDecisionId: input.riskDecisionId, decisionVersion: input.decisionVersion, runId: input.runId,
    headline: { assessment, decidedBy, score, halts: halt["halt"] === true, haltReason: str(halt["reason"]) ?? "" },
    agents, blockers, unavailable, closeCalls, sizing: input.sizing ?? null,
    sourceHealth: health === null ? null : { overall: health.overall, notUsable }, statements, grantsApproval: false,
  };
}

/** Type guard used by tests to show the card reads the real synthesis shape. */
export type CardSynthesisSource = Pick<SynthesisResult, "assessment" | "score" | "agentSummaries" | "thresholdEvaluation" | "halt" | "blockers" | "reasons">;
