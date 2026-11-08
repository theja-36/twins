import { createHash } from "node:crypto";
import type { ResearchPackage } from "@twins/agents";

/**
 * Confidence scoring and signal strength (Module 09). PURE and deterministic. The score is a 0-100 STRENGTH / research score built from explainable components; it is NOT a probability of winning and is
 * labelled UNCALIBRATED until a separate calibration run (calibration.ts) validates it on enough out-of-sample outcomes. It carries no sizing tier and it is not an input to any risk limit:
 * the risk engine does not accept it, so it can never relax a restriction. Correlated evidence families are capped so the same price series cannot be counted twice. Missing, stale or fixture-backed
 * evidence is listed, scores zero for its component, dilutes the score toward neutral and caps how strong the score can look.
 */
export const CONFIDENCE_MODEL_VERSION = "confidence-strength-v1";
export type Verdict = "SUPPORTIVE" | "NEUTRAL" | "CAUTION" | "ADVERSE" | "BLOCKING" | "INCOMPLETE";
const VERDICT_VALUE: Record<Exclude<Verdict, "INCOMPLETE">, number> = { SUPPORTIVE: 1, NEUTRAL: 0, CAUTION: -0.4, ADVERSE: -0.8, BLOCKING: -1 };
export interface ComponentDef { id: string; group: string; weight: number; agents: readonly string[]; label: string }
/** Weights sum to 100. Groups: components in one group share evidence (the same price series, or the same news flow) and are capped together. */
export const COMPONENTS: readonly ComponentDef[] = [
  { id: "TECHNICAL_STRUCTURE", group: "PRICE_SERIES", weight: 14, agents: ["technical-structure-v1"], label: "Technical structure" },
  { id: "PRICE_ACTION", group: "PRICE_SERIES", weight: 12, agents: ["price-action-v1"], label: "Price action" },
  { id: "MARKET_CONTEXT", group: "PRICE_SERIES", weight: 14, agents: ["market-context-v1"], label: "Market regime" },
  { id: "HISTORICAL_PATTERN", group: "HISTORY", weight: 14, agents: ["historical-pattern-v1"], label: "Historical patterns" },
  { id: "NEWS_SENTIMENT", group: "INFORMATION", weight: 8, agents: ["news-sentiment-v1", "index-constituent-impact-v1"], label: "News and index drivers" },
  { id: "CALENDAR_MACRO", group: "INFORMATION", weight: 6, agents: ["market-calendar-v1", "macro-global-v1"], label: "Calendar and macro" },
  { id: "LIQUIDITY", group: "EXECUTION", weight: 10, agents: ["liquidity-v1", "options-risk-v1"], label: "Liquidity and option risk" },
  { id: "SIGNAL_INTEGRITY", group: "INTEGRITY", weight: 8, agents: ["signal-integrity-v1", "instrument-verification-v1"], label: "Signal and instrument integrity" },
  { id: "CHALLENGER", group: "CHALLENGE", weight: 6, agents: ["independent-challenger-v1"], label: "Independent challenge" },
  { id: "STRATEGY_PERFORMANCE", group: "STRATEGY", weight: 8, agents: [], label: "Strategy / playbook performance" },
];
export const MIN_STRATEGY_SAMPLE = 30;
export interface RegimeEvidence { underlying: string; version?: string; asOf: string | null; direction: string; regime: string; volatilityRegime: string; eventRisk: string; riskOff: boolean; dataSource: string; freshness: { stale: boolean } }
export interface StrategyEvidence { playbookId: string; version: number; resolvedOutcomes: number; averageR: number | null; winRate: number | null; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL" }
export interface ConfidenceInput {
  candidate: { id: string; side: "BUY" | "SELL"; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; rankScore: number | null };
  research: ResearchPackage | null; regime: RegimeEvidence | null; strategy: StrategyEvidence | null;
}
export interface ScoreComponent { id: string; label: string; group: string; weight: number; value: number | null; contribution: number; cappedContribution: number; status: "SCORED" | "MISSING" | "STALE_OR_UNUSABLE"; reasons: string[]; evidenceRefs: string[]; versions: Record<string, string>; fixtureBacked: boolean }
export interface ConfidenceCap { code: string; maxScore: number; reason: string }
export interface ConfidenceResult {
  modelVersion: string; score: number; band: "WEAK" | "MIXED" | "MODERATE" | "STRONG"; strengthOnly: true; calibrationStatus: "UNCALIBRATED"; winProbability: null;
  components: ScoreComponent[]; supporting: string[]; contradicting: string[]; missing: string[]; riskFlags: string[]; caps: ConfidenceCap[]; completeness: number; uncappedScore: number;
  explanation: string; provenance: { candidateId: string; researchPackageVersion: number | null; researchPackageSha256: string | null; agentVersions: Record<string, string>; regimeRef: string | null; strategyRef: string | null }; inputSha256: string; neverOverridesRisk: true; grantsApproval: false;
}
const r2 = (n: number): number => Math.round(n * 100) / 100;
const band = (s: number): ConfidenceResult["band"] => (s >= 75 ? "STRONG" : s >= 60 ? "MODERATE" : s >= 45 ? "MIXED" : "WEAK");
const regimeValue = (r: RegimeEvidence, side: "BUY" | "SELL"): { v: number; why: string[] } => {
  const want = side === "BUY" ? "BULLISH" : "BEARISH", why: string[] = [];
  let v = r.direction === want ? 0.8 : r.direction === "NEUTRAL" ? 0 : -0.8; why.push(`regime direction ${r.direction} vs side ${side}`);
  if (r.volatilityRegime === "HIGH") { v -= 0.3; why.push("high volatility"); } else if (r.volatilityRegime === "EXTREME") { v -= 0.6; why.push("extreme volatility"); }
  if (r.eventRisk === "HIGH") { v -= 0.5; why.push("high event risk"); } else if (r.eventRisk === "ELEVATED") { v -= 0.2; why.push("elevated event risk"); }
  if (r.riskOff) { v -= 0.6; why.push("risk-off"); }
  return { v: Math.max(-1, Math.min(1, v)), why };
};

export function scoreConfidence(inp: ConfidenceInput): ConfidenceResult {
  const pkg = inp.research, reports = new Map((pkg?.reports ?? []).map((r) => [r.agentId, r]));
  const comps: ScoreComponent[] = [], supporting: string[] = [], contradicting: string[] = [], missing: string[] = [];
  const flags = new Set<string>();
  for (const d of COMPONENTS) {
    const c: ScoreComponent = { id: d.id, label: d.label, group: d.group, weight: d.weight, value: null, contribution: 0, cappedContribution: 0, status: "MISSING", reasons: [], evidenceRefs: [], versions: {}, fixtureBacked: false };
    if (d.id === "MARKET_CONTEXT" && inp.regime) {
      const rg = inp.regime;
      if (rg.freshness.stale || rg.regime === "UNKNOWN" || rg.underlying === undefined) { c.status = "STALE_OR_UNUSABLE"; c.reasons.push("the regime is stale or unknown"); }
      else { const x = regimeValue(rg, inp.candidate.side); c.value = x.v; c.status = "SCORED"; c.reasons.push(...x.why); c.evidenceRefs.push(`market_regime:${rg.version ?? "unknown"}:${rg.underlying}:${rg.asOf ?? "unknown"}`); if (rg.version) c.versions["market-regime"] = rg.version; c.fixtureBacked = rg.dataSource === "FIXTURE"; }
    } else if (d.id === "STRATEGY_PERFORMANCE") {
      const s = inp.strategy;
      if (!s) c.reasons.push("no playbook performance is available");
      else if (s.resolvedOutcomes < MIN_STRATEGY_SAMPLE || s.averageR === null) { c.status = "STALE_OR_UNUSABLE"; c.reasons.push(`only ${s.resolvedOutcomes} resolved outcomes (minimum ${MIN_STRATEGY_SAMPLE}); not used`); }
      else { c.value = Math.max(-1, Math.min(1, s.averageR)); c.status = "SCORED"; c.reasons.push(`average ${s.averageR}R over ${s.resolvedOutcomes} resolved outcomes (${s.dataSource})`); c.evidenceRefs.push(`playbook:${s.playbookId}:v${s.version}`); c.versions["playbook"] = String(s.version); c.fixtureBacked = s.dataSource === "FIXTURE"; }
    } else {
      const got = d.agents.map((a) => reports.get(a)).filter((r): r is NonNullable<typeof r> => !!r);
      const done = got.filter((r) => r.verdict !== "INCOMPLETE");
      for (const r of got) { c.versions[r.agentId] = r.agentVersion; for (const f of r.riskFlags) flags.add(f); }
      if (d.id === "TECHNICAL_STRUCTURE" && inp.candidate.rankScore !== null) { /* the independent rank is derived from the same bars: shown, not scored */ c.reasons.push(`independent setup rank ${inp.candidate.rankScore} shown for context only (same price series; not double counted)`); }
      if (done.length === 0) { c.reasons.push(got.length ? "every contributing agent was incomplete" : "no contributing agent ran"); if (got.length) c.status = "STALE_OR_UNUSABLE"; }
      else {
        const vals = done.map((r) => VERDICT_VALUE[r.verdict as Exclude<Verdict, "INCOMPLETE">]);
        c.value = vals.reduce((a, b) => a + b, 0) / vals.length; c.status = "SCORED";
        for (const r of done) { c.reasons.push(`${r.agentId} ${r.verdict}`); c.evidenceRefs.push(...r.evidenceRefs); }
      }
    }
    // the challenger can only subtract: an unchallenged candidate gets no credit for the absence of objections
    if (d.id === "CHALLENGER" && c.value !== null && c.value > 0) { c.value = 0; c.reasons.push("a supportive challenger earns no credit"); }
    c.evidenceRefs = [...new Set(c.evidenceRefs)].sort();
    comps.push(c);
  }
  for (const c of comps) c.contribution = r2(c.weight * (c.value ?? 0));
  // correlated families: positive contributions in one group cannot exceed the heaviest single weight in that group
  const groups = new Map<string, ScoreComponent[]>();
  for (const c of comps) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  for (const [, g] of groups) {
    const cap = Math.max(...g.map((c) => c.weight)), pos = g.reduce((a, c) => a + Math.max(0, c.contribution), 0), k = pos > cap ? cap / pos : 1;
    for (const c of g) { c.cappedContribution = r2(c.contribution > 0 ? c.contribution * k : c.contribution); if (k < 1 && c.contribution > 0) c.reasons.push(`positive contribution scaled by ${r2(k)} because ${g.map((x) => x.id).join(" + ")} share one evidence family`); }
  }
  const totalW = comps.reduce((a, c) => a + c.weight, 0), presentW = comps.filter((c) => c.status === "SCORED").reduce((a, c) => a + c.weight, 0);
  const completeness = r2(presentW / totalW), uncapped = r2(Math.max(0, Math.min(100, 50 + 50 * (comps.reduce((a, c) => a + c.cappedContribution, 0) / totalW))));
  for (const c of comps) { if (c.status !== "SCORED") missing.push(`${c.id}${c.status === "STALE_OR_UNUSABLE" ? " (stale/unusable)" : ""}`); else if (c.value! >= 0.3) supporting.push(`${c.id}: ${c.reasons[0] ?? ""}`.trim()); else if (c.value! <= -0.3) contradicting.push(`${c.id}: ${c.reasons[0] ?? ""}`.trim()); }
  for (const x of pkg?.contradictions ?? []) contradicting.push(`agents disagree: ${x.supportive.join(", ")} support, ${x.opposing.join(", ")} ${x.opposingVerdict}`);
  const caps: ConfidenceCap[] = [];
  if (!pkg) caps.push({ code: "NO_RESEARCH_PACKAGE", maxScore: 40, reason: "no research package exists for this candidate" });
  else {
    if (pkg.halt) caps.push({ code: "RESEARCH_HALTED", maxScore: 20, reason: `research halted (${pkg.haltReason ?? "unspecified"})` });
    if (pkg.missingRequired.length > 0) caps.push({ code: "REQUIRED_AGENTS_MISSING", maxScore: 45, reason: `required agents missing: ${pkg.missingRequired.join(", ")}` });
    if ((pkg.contradictions ?? []).length > 0) caps.push({ code: "CONTRADICTIONS", maxScore: 60, reason: "completed agents disagree" });
  }
  if (completeness < 0.6) caps.push({ code: "EVIDENCE_INCOMPLETE", maxScore: 55, reason: `only ${Math.round(completeness * 100)}% of the evidence weight is available` });
  if (inp.candidate.dataSource === "FIXTURE" || comps.some((c) => c.fixtureBacked) || pkg?.dataSource === "FIXTURE") caps.push({ code: "FIXTURE_BACKED", maxScore: 55, reason: "some evidence is fixture data, which cannot support a strong score" });
  if (comps.some((c) => c.status === "STALE_OR_UNUSABLE")) caps.push({ code: "STALE_OR_UNUSABLE_EVIDENCE", maxScore: 65, reason: "some evidence was stale, unknown or unusable" });
  const score = r2(caps.reduce((a, c) => Math.min(a, c.maxScore), uncapped));
  const agentVersions = { ...(pkg?.agentVersions ?? {}) };
  const explanation = `Strength ${score}/100 (${band(score)}), not a probability. Evidence completeness ${Math.round(completeness * 100)}%. ${caps.length ? "Capped by: " + caps.map((c) => c.code).join(", ") + ". " : ""}${missing.length ? "Missing: " + missing.join(", ") + ". " : ""}Uncalibrated: no out-of-sample validation exists.`;
  const provenance = { candidateId: inp.candidate.id, researchPackageVersion: pkg?.version ?? null, researchPackageSha256: pkg?.packageSha256 ?? null, agentVersions, regimeRef: inp.regime ? `market_regime:${inp.regime.version ?? "unknown"}:${inp.regime.underlying}:${inp.regime.asOf ?? "unknown"}` : null, strategyRef: inp.strategy ? `playbook:${inp.strategy.playbookId}:v${inp.strategy.version}` : null };
  return {
    modelVersion: CONFIDENCE_MODEL_VERSION, score, band: band(score), strengthOnly: true, calibrationStatus: "UNCALIBRATED", winProbability: null, components: comps, supporting, contradicting, missing, riskFlags: [...flags].sort(), caps, completeness, uncappedScore: uncapped,
    explanation, provenance, inputSha256: createHash("sha256").update(JSON.stringify({ c: inp.candidate, p: pkg?.packageSha256 ?? null, r: inp.regime, s: inp.strategy })).digest("hex"), neverOverridesRisk: true, grantsApproval: false,
  };
}
