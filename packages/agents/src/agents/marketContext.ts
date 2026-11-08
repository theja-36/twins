import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import type { MarketRegimeObject } from "../regime/market";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef } from "./common";
import { signalDirection } from "./macroGlobal";

/**
 * Market Context Agent (`market-context-v1`, Stage 04). Places the signal inside the current market regime (trend, volatility, event risk, correlated indices) using an INJECTED regime
 * provider. Evidence only: it never blocks, never grants approval, uses no model and never reads message text.
 *
 *   UNAVAILABLE (never a pass): no provider, a provider that throws, a regime for another underlying, an UNKNOWN / stale regime, an unknown signal direction
 *   ADVERSE : the regime trends against the signal direction
 *   CAUTION : RISK_OFF, HIGH / EXTREME volatility, ELEVATED / HIGH event risk, timeframes or correlated indices disagreeing, regime flags raised
 *   NEUTRAL : range-bound / low-volatility / unclear;  SUPPORTIVE: trend with the signal and nothing cautionary
 */
export const MARKET_CONTEXT_AGENT_ID = "market-context-v1";

/** Supplies the current regime for an underlying. A null return means "no regime available". */
export interface RegimeProvider { readonly name: string; regimeFor(underlying: string, now: Date): Promise<MarketRegimeObject | null> }

export function marketContextContract(): AgentContract {
  return {
    agentId: MARKET_CONTEXT_AGENT_ID, agentName: "Market Context Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, direction: { type: "string" }, regime: { type: "string" }, regimeDirection: { type: "string" }, volatilityRegime: { type: "string" },
      eventRisk: { type: "string" }, correlatedIndexAgreement: { type: "string" }, regimeVersion: { type: "string" }, dataSource: { type: "string" }, provider: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 40, canBlock: false, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; symbol?: string | null; side?: string | null; optionType?: string | null };

export function marketContextAgent(provider: RegimeProvider | null): AgentDefinition {
  return {
    contract: marketContextContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      const underlying = (rd.symbol ?? "").trim().toUpperCase();
      if (!underlying || underlying === "UNKNOWN") throw new AgentUnavailableError("MISSING_CONTEXT", "the underlying is missing");
      if (!provider) throw new AgentUnavailableError("PROVIDER_NOT_CONFIGURED", "no regime provider is configured");
      let reg: MarketRegimeObject | null;
      try { reg = await provider.regimeFor(underlying, ctx.now); } catch { throw new AgentUnavailableError("PROVIDER_ERROR", "the regime provider failed"); }
      if (!reg) throw new AgentUnavailableError("NO_REGIME", "no regime is available for the underlying");
      if (reg.underlying.toUpperCase() !== underlying) throw new AgentUnavailableError("REGIME_UNDERLYING_MISMATCH", "the regime is for a different underlying");
      if (reg.regime === "UNKNOWN" || reg.freshness.stale || reg.freshness.usableTimeframes === 0) throw new AgentUnavailableError("REGIME_UNUSABLE", "the regime is unknown or stale");
      const dir = signalDirection((rd.instrumentType ?? "").toLowerCase(), rd.side ?? "", rd.optionType);
      if (dir === null) throw new AgentUnavailableError("DIRECTION_UNKNOWN", "the signal direction cannot be derived");

      const c = new Collector();
      c.check();
      const rdir = reg.direction === "BULLISH" ? 1 : reg.direction === "BEARISH" ? -1 : 0;
      const trending = reg.regime === "TRENDING_UP" || reg.regime === "TRENDING_DOWN";
      let aligned = false;
      if (trending && rdir !== 0 && rdir !== dir) c.add("ADVERSE", "REGIME_AGAINST", `The ${reg.regime} regime runs against the signal direction.`, { regime: reg.regime });
      else if (trending && rdir === dir) { aligned = true; c.add("INFO", "REGIME_ALIGNED", `The ${reg.regime} regime agrees with the signal direction.`, { regime: reg.regime }); }
      else c.add("INFO", "REGIME_NOT_DIRECTIONAL", `The regime is ${reg.regime}: no directional edge either way.`, { regime: reg.regime });
      c.check();
      if (reg.riskOff || reg.regime === "RISK_OFF") c.add("CAUTION", "RISK_OFF", "The market is risk-off: high volatility with bearish structure on several timeframes.");
      c.check();
      if (reg.volatilityRegime === "HIGH" || reg.volatilityRegime === "EXTREME") c.add("CAUTION", "VOLATILITY_HIGH", `Volatility is ${reg.volatilityRegime}.`, { volatilityRegime: reg.volatilityRegime });
      c.check();
      if (reg.eventRisk === "ELEVATED" || reg.eventRisk === "HIGH") c.add("CAUTION", "EVENT_RISK", `Event risk is ${reg.eventRisk}.`, { eventRisk: reg.eventRisk });
      else if (reg.eventRisk === "UNKNOWN") c.add("INFO", "EVENT_RISK_UNKNOWN", "Event risk is unknown; it is not treated as low.");
      c.check();
      if (reg.correlatedIndexAgreement === "MIXED") c.add("CAUTION", "INDICES_DISAGREE", "Correlated indices do not agree on direction.");
      c.check();
      const usable = reg.timeframes.filter((t) => t.status === "OK" && t.direction !== "UNKNOWN");
      const dirs = new Set(usable.map((t) => t.direction));
      if (dirs.has("BULLISH") && dirs.has("BEARISH")) c.add("CAUTION", "TIMEFRAMES_DISAGREE", "Usable timeframes point in opposite directions.");
      for (const f of reg.flags.slice(0, 6)) c.add("INFO", `REGIME_FLAG_${f.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40)}`, `Regime flag: ${f.slice(0, 120)}.`);

      const base = c.output([...evidenceRef("risk_decision", rd.id), ...evidenceRef("market_regime", `${reg.version}:${reg.underlying}:${reg.asOf ?? "none"}`)], {
        direction: dir > 0 ? "BULLISH" : "BEARISH", regime: reg.regime, regimeDirection: reg.direction, volatilityRegime: reg.volatilityRegime, eventRisk: reg.eventRisk,
        correlatedIndexAgreement: reg.correlatedIndexAgreement, regimeVersion: reg.version, dataSource: reg.dataSource, provider: provider.name.slice(0, 80),
      });
      // a fixture-backed regime can never be positive
      if (base.verdict === "SUPPORTIVE" && (!aligned || reg.dataSource === "FIXTURE")) return { ...base, verdict: "NEUTRAL", confidence: 70 };
      return base;
    },
  };
}
