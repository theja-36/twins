import { AgentUnavailableError, type AgentContract, type AgentDefinition, type AgentRunResult } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, fin } from "./common";
import { signalDirection } from "./macroGlobal";
import { r4 } from "./ohlcCommon";
import type { AgentRulesConfig } from "./rules";

/**
 * Independent Challenger Agent (`independent-challenger-v1`, Stage 5 / Task 7). Challenges the signal using ONLY evidence that already exists: the signal's parsed fields, the stop-loss validation, the source-
 * intelligence summary and the verdicts, confidences, findings and outputs of the other agents (declared as its dependencies, so it runs after them). It invents no facts, calls no provider, reads no message text
 * and no clock of its own. Evidence only: it states which recorded results disagree or are missing, never why.
 *
 *   BLOCKING (configurable ADVERSE): direction incoherence (an agent's recorded direction differs from the one derived from the signal's side and option type); stop-loss or targets on the wrong side;
 *     stop-loss validation not VALID; a critical contradiction (>= 2 high-confidence SUPPORTIVE agents against >= 2 ADVERSE / BLOCKING agents); an unsupported claim (a SUPPORTIVE agent whose own output counts adverse or blocking findings)
 *   ADVERSE  : adverse evidence weight (confidence-weighted share of ADVERSE / BLOCKING verdicts) of 50% or more; poor reward/risk; many data-quality findings
 *   CAUTION  : any agent contradiction; SUPPORTIVE without evidence references; missing source intelligence / signal context / stop validation; thin evidence; overconfident source; reward/risk below 1; stop risk mismatch;
 *              adverse weight of 30% or more; several data-quality findings
 *   NEUTRAL  : nothing found but too little support;  SUPPORTIVE: nothing found, at least 3 agents assessed and at least half of them SUPPORTIVE
 */
export const INDEPENDENT_CHALLENGER_AGENT_ID = "independent-challenger-v1";

export function independentChallengerContract(dependsOn: string[], softDependsOn: string[] = []): AgentContract {
  return {
    agentId: INDEPENDENT_CHALLENGER_AGENT_ID, agentName: "Independent Challenger Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context", "signal_features", "source_intelligence", "stop_loss_validation"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, expectedDirection: { type: "string" }, dependencyCount: { type: "number" }, assessedCount: { type: "number" }, supportiveAgents: { type: "number" }, neutralAgents: { type: "number" }, cautionAgents: { type: "number" },
      adverseAgents: { type: "number" }, blockingAgents: { type: "number" }, adverseWeightShare: { type: "number" }, rewardRisk: { type: "number" }, dataQualityFindings: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 30, canBlock: true, advisoryOnly: false, dependsOn: [...dependsOn].sort(), ...(softDependsOn.length > 0 ? { softDependsOn: [...softDependsOn].sort() } : {}),
  };
}
type Rd = { id?: string; instrumentType?: string | null; side?: string | null; optionType?: string | null; entryPrice?: number | null; stopLoss?: number | null; targets?: number[] };
type Si = { status?: string; confidence?: { score?: number | null; tier?: string | null } } | null;
type Slv = { result?: string; riskPct?: number | null } | null;
const DATA_QUALITY = /_(STALE|UNUSABLE|MISSING|INCOMPLETE|NOT_CONFIGURED|NOT_AVAILABLE|UNAVAILABLE|NOT_RECORDED|NOT_COMPARED|AS_OF_UNKNOWN|DISCONNECT)$/;
const list = (ids: string[]): string => ids.slice(0, 6).join(",");

export function independentChallengerAgent(rules: AgentRulesConfig, dependsOn: string[], softDependsOn: string[] = []): AgentDefinition {
  const H = rules.challenger;
  return {
    contract: independentChallengerContract(dependsOn, softDependsOn),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as Si;
      const slv = (ctx.inputs["stop_loss_validation"] ?? null) as Slv;
      const sc = ctx.inputs["signal_context"] ?? null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      const deps = Object.values(ctx.dependencies).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
      if (deps.length === 0) throw new AgentUnavailableError("NO_AGENT_EVIDENCE", "there are no other agent results to challenge");
      const c = new Collector();
      const type = (rd.instrumentType ?? "").toLowerCase();
      const dir = signalDirection(type, rd.side ?? "", rd.optionType);
      const expected = dir === null ? "UNKNOWN" : dir > 0 ? "BULLISH" : "BEARISH";
      const completed = deps.filter((d: AgentRunResult) => d.status === "COMPLETED");
      const applicable = completed.filter((d) => d.outputSnapshot["applicable"] !== false);
      const by = (v: string): AgentRunResult[] => applicable.filter((d) => d.verdict === v);
      const sup = by("SUPPORTIVE"), neu = by("NEUTRAL"), cau = by("CAUTION"), adv = by("ADVERSE"), blk = by("BLOCKING");
      const against = [...adv, ...blk];

      // direction coherence: every recorded direction must equal the one derived from the signal
      c.check();
      if (dir === null) c.add("CAUTION", "DIRECTION_UNKNOWN", "The signal direction cannot be derived from its side and option type, so agent directions cannot be compared.");
      else {
        const off = completed.filter((d) => { const x = d.outputSnapshot["direction"]; return (x === "BULLISH" || x === "BEARISH") && x !== expected; }).map((d) => d.agentId);
        if (off.length > 0) c.add(H.incoherenceSeverity, "DIRECTION_INCOHERENT", `${off.length} agent(s) recorded a direction different from the ${expected} direction derived from the signal (${list(off)}).`, { agents: list(off), expected });
      }

      // stop-loss coherence
      c.check();
      const entry = rd.entryPrice, stop = rd.stopLoss, side = rd.side;
      const priced = fin(entry) && entry > 0 && fin(stop) && stop > 0 && (side === "BUY" || side === "SELL");
      if (priced) {
        const e = entry as number, s = stop as number;
        if (side === "BUY" ? s >= e : s <= e) c.add(H.incoherenceSeverity, "STOP_LOSS_INCOHERENT", `The stop-loss (${s}) is not on the loss side of the entry (${e}) for a ${side}.`, { stop: s, entry: e });
        if (slv === null) c.add("CAUTION", "STOP_VALIDATION_MISSING", "There is no stop-loss validation record for this signal.");
        else if (slv.result !== "VALID") c.add(H.incoherenceSeverity, "STOP_LOSS_NOT_VALID", "The stop-loss validation result is not VALID.", { result: typeof slv.result === "string" ? slv.result.slice(0, 30) : null });
        else if (fin(slv.riskPct)) {
          const computed = (Math.abs(e - s) / e) * 100;
          if (Math.abs(computed - slv.riskPct) > H.stopRiskTolerancePts) c.add("CAUTION", "STOP_RISK_PCT_MISMATCH", `The stop distance computed from the levels (${r4(computed)}%) differs from the validated risk (${r4(slv.riskPct)}%).`, { computed: r4(computed), validated: r4(slv.riskPct) });
        }
      } else c.add("CAUTION", "LEVELS_INCOMPLETE", "The entry, stop-loss or side is missing, so the levels cannot be challenged.");

      // risk / reward coherence
      c.check();
      let rr: number | null = null;
      const t1 = Array.isArray(rd.targets) ? rd.targets[0] : undefined;
      if (priced && fin(t1)) {
        const e = entry as number, s = stop as number, risk = Math.abs(e - s);
        if (side === "BUY" ? t1 <= e : t1 >= e) c.add(H.incoherenceSeverity, "TARGET_INCOHERENT", `The first target (${t1}) is not on the profit side of the entry (${e}) for a ${side}.`, { target: t1, entry: e });
        else if (risk > 0) {
          rr = Math.abs(t1 - e) / risk;
          if (rr < H.adverseRewardRisk) c.add("ADVERSE", "REWARD_RISK_POOR", `The first target offers ${r4(rr)} of the risk taken.`, { rewardRisk: r4(rr) });
          else if (rr < H.minRewardRisk) c.add("CAUTION", "REWARD_RISK_LOW", `The first target offers ${r4(rr)} of the risk taken.`, { rewardRisk: r4(rr) });
        }
      } else if (priced) c.add("CAUTION", "NO_TARGETS", "The signal has no target, so reward/risk cannot be challenged.");

      // contradictions between agents
      c.check();
      if (sup.length > 0 && against.length > 0) {
        c.add("CAUTION", "AGENT_CONTRADICTION", `${sup.length} agent(s) are SUPPORTIVE (${list(sup.map((d) => d.agentId))}) while ${against.length} are ADVERSE or BLOCKING (${list(against.map((d) => d.agentId))}).`, { supportive: list(sup.map((d) => d.agentId)), against: list(against.map((d) => d.agentId)) });
        const strong = sup.filter((d) => (d.confidence ?? 0) >= H.criticalConfidence);
        if (strong.length >= H.criticalSupportive && against.length >= H.criticalAdverse) c.add(H.criticalSeverity, "CRITICAL_CONTRADICTION", `${strong.length} high-confidence SUPPORTIVE results stand against ${against.length} ADVERSE or BLOCKING results.`, { supportive: strong.length, against: against.length });
      }

      // unsupported claims
      c.check();
      const noEvidence = sup.filter((d) => d.evidence.length === 0).map((d) => d.agentId);
      if (noEvidence.length > 0) c.add("CAUTION", "SUPPORT_WITHOUT_EVIDENCE", `${noEvidence.length} SUPPORTIVE result(s) carry no evidence reference (${list(noEvidence)}).`, { agents: list(noEvidence) });
      const inconsistent = sup.filter((d) => Number(d.outputSnapshot["blockingCount"] ?? 0) > 0 || Number(d.outputSnapshot["adverseCount"] ?? 0) > 0).map((d) => d.agentId);
      if (inconsistent.length > 0) c.add(H.criticalSeverity, "UNSUPPORTED_CLAIM", `${inconsistent.length} SUPPORTIVE result(s) record adverse or blocking findings of their own (${list(inconsistent)}).`, { agents: list(inconsistent) });

      // missing evidence and overconfidence
      c.check();
      if (si === null) c.add("CAUTION", "SOURCE_INTELLIGENCE_MISSING", "There is no source-intelligence summary for this signal.");
      else if (si.status !== "VALID") c.add("CAUTION", "SOURCE_INTELLIGENCE_NOT_VALID", "The source-intelligence summary is not VALID.", { status: typeof si.status === "string" ? si.status.slice(0, 30) : null });
      if (sc === null) c.add("CAUTION", "SIGNAL_CONTEXT_MISSING", "The signal context (time and revision state) is missing.");
      if (applicable.length > 0 && neu.length / applicable.length >= H.thinEvidenceShare) c.add("CAUTION", "THIN_EVIDENCE", `${neu.length} of ${applicable.length} assessed agents reached no clear view.`, { neutral: neu.length, assessed: applicable.length });
      const score = si?.confidence?.score, tier = si?.confidence?.tier;
      const confident = (fin(score) && score >= H.overconfidenceScore) || tier === "HIGH";
      const unfavourable = cau.length + against.length;
      if (confident && applicable.length > 0 && unfavourable / applicable.length >= H.overconfidenceAdverseShare) c.add("CAUTION", "OVERCONFIDENT_SOURCE", `Source confidence is ${fin(score) ? r4(score) : String(tier)}, while ${unfavourable} of ${applicable.length} assessed agents are CAUTION, ADVERSE or BLOCKING.`, { unfavourable, assessed: applicable.length });

      // data quality across the agents
      c.check();
      const dq = completed.reduce((n, d) => n + d.findings.filter((f) => f.severity !== "INFO" && DATA_QUALITY.test(f.code)).length, 0);
      if (dq >= H.dataQualityAdverse) c.add("ADVERSE", "DATA_QUALITY_POOR", `${dq} stale, missing or unusable data findings across the agents.`, { findings: dq });
      else if (dq >= H.dataQualityCaution) c.add("CAUTION", "DATA_QUALITY_ISSUES", `${dq} stale, missing or unusable data findings across the agents.`, { findings: dq });

      // adverse evidence weight (confidence-weighted)
      c.check();
      const wsum = applicable.reduce((a, d) => a + (d.confidence ?? 0), 0);
      const share = wsum > 0 ? against.reduce((a, d) => a + (d.confidence ?? 0), 0) / wsum : 0;
      if (share >= H.adverseShareAdverse) c.add("ADVERSE", "ADVERSE_EVIDENCE_WEIGHT", `ADVERSE or BLOCKING results carry ${r4(share * 100)}% of the confidence-weighted evidence.`, { share: r4(share) });
      else if (share >= H.adverseShareCaution) c.add("CAUTION", "ADVERSE_EVIDENCE_SHARE", `ADVERSE or BLOCKING results carry ${r4(share * 100)}% of the confidence-weighted evidence.`, { share: r4(share) });

      const base = c.output([...evidenceRef("risk_decision", rd.id), ...deps.slice(0, 12).map((d) => ({ kind: "agent_result", ref: `agent_result:${d.agentId}@${d.agentVersion}` }))], {
        expectedDirection: expected, dependencyCount: deps.length, assessedCount: applicable.length, supportiveAgents: sup.length, neutralAgents: neu.length, cautionAgents: cau.length, adverseAgents: adv.length, blockingAgents: blk.length,
        adverseWeightShare: r4(share), dataQualityFindings: dq, sourceIntelligenceStatus: typeof si?.status === "string" ? si.status.slice(0, 30) : "none", ...(rr !== null ? { rewardRisk: r4(rr) } : {}),
      });
      if (base.verdict === "SUPPORTIVE" && (applicable.length < H.supportMinAgents || sup.length / applicable.length < H.supportShare)) return { ...base, verdict: "NEUTRAL", confidence: 70 };
      return base;
    },
  };
}
