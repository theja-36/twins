import { patternKeys, wilsonInterval, type Features } from "@twins/historical";
import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef } from "./common";
import { outcomeProblem, patternProblem, type HistoricalOutcomeProvider, type HistoricalPatternProvider, type OutcomeDistribution, type PatternMatch } from "./historicalProviders";
import { loadMarketBars, r4 } from "./ohlcCommon";
import type { LastPriceProvider, OhlcProvider } from "./ohlcProviders";
import type { AgentRulesConfig } from "./rules";

/**
 * Historical Pattern Agent (`historical-pattern-v1`, Stage 5 / Task 7). Describes whether the evaluated historical outcomes of signals that matched this signal's setup (exact pattern keys of the Stage 4
 * pattern library: market, instrument type, side, underlying, time of day, expiry proximity, stop distance, reward/risk) support, conflict with or do not bear on it, from INJECTED providers (no database
 * read, no external API, no model, never message text). Evidence only: historical association, no cause and no forecast.
 *
 *   UNAVAILABLE (never a pass): no provider, a provider that throws, no matching pattern, a sample below the minimum (evaluable outcomes), malformed data, library / outcome data older than the unavailable limit
 *     or dated in the future, no entered outcomes, incomplete signal features
 *   ADVERSE (or BLOCKING when configured): a critical adverse pattern (large sample, very low win rate upper bound and strongly negative expectancy; configurable ADVERSE | BLOCKING, default ADVERSE)
 *   ADVERSE  : win-rate upper bound below the adverse limit with a non-positive expectancy; net expectancy at or below the adverse limit with a negative lower bound
 *   CAUTION  : win rate below even; non-positive / missing expectancy; many unverifiable outcomes or a low-quality pattern; library older than the caution limit; pattern not recently observed;
 *              regime or volatility share of the historical sample below the minimum; market conditions that cannot be compared
 *   NEUTRAL  : no clear support (fewer than two supportive measures, a pattern broader than the minimum level, conditions not compared);  SUPPORTIVE: nothing cautionary and the above satisfied
 */
export const HISTORICAL_PATTERN_AGENT_ID = "historical-pattern-v1";

export function historicalPatternContract(): AgentContract {
  return {
    agentId: HISTORICAL_PATTERN_AGENT_ID, agentName: "Historical Pattern Agent", version: "1.0.0",
    requiredInputs: ["risk_decision", "signal_features"], optionalInputs: ["signal_context", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, patternProvider: { type: "string" }, outcomeProvider: { type: "string" }, patternKey: { type: "string" }, patternLevel: { type: "number" }, evidenceStatus: { type: "string" }, sampleSize: { type: "number" },
      entered: { type: "number" }, wins: { type: "number" }, losses: { type: "number" }, winRate: { type: "number" }, winRateLower: { type: "number" }, winRateUpper: { type: "number" }, netExpectancyR: { type: "number" },
      netExpectancyLowerBoundR: { type: "number" }, payoffRatio: { type: "number" }, unverifiableShare: { type: "number" }, dataAgeDays: { type: "number" }, currentRegime: { type: "string" }, regimeShare: { type: "number" },
      currentVolatility: { type: "string" }, volatilityShare: { type: "number" }, matchedLevels: { type: "string" }, supportiveMeasures: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}

const DAY = 86_400_000;
const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };
const FEATURE_KEYS: Array<keyof Features> = ["market", "instrumentType", "underlying", "optionType", "side", "timeOfDay", "dayOfWeek", "expiryProximity", "entryType", "stopDistance", "rewardRisk", "targetStructure"];

export function historicalPatternAgent(rules: AgentRulesConfig, patterns: HistoricalPatternProvider | null, outcomes: HistoricalOutcomeProvider | null, ohlc: OhlcProvider | null, price: LastPriceProvider | null): AgentDefinition {
  const H = rules.historical;
  return {
    contract: historicalPatternContract(),
    async run(ctx) {
      const sf = ctx.inputs["signal_features"] as Record<string, unknown> | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      const rd = ctx.inputs["risk_decision"] as { id?: string } | null;
      if (!rd || !sf) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision or signal-feature context is missing");
      if (FEATURE_KEYS.some((k) => typeof sf[k] !== "string" || (sf[k] as string).length === 0 || (sf[k] as string).length > 60)) return unavailable("FEATURES_INCOMPLETE", "the signal features do not describe a complete setup");
      const f = Object.fromEntries(FEATURE_KEYS.map((k) => [k, sf[k] as string])) as unknown as Features;
      if ((f.side !== "BUY" && f.side !== "SELL") || f.underlying === "UNKNOWN" || f.market === "UNKNOWN") return unavailable("FEATURES_INCOMPLETE", "the signal features do not describe a complete setup");
      if (!patterns) return unavailable("PATTERN_PROVIDER_NOT_CONFIGURED", "no historical pattern provider is configured; historical evidence cannot be assessed");
      if (!outcomes) return unavailable("OUTCOME_PROVIDER_NOT_CONFIGURED", "no historical outcome provider is configured; historical evidence cannot be assessed");
      const keys = patternKeys(f);
      const keyTexts = keys.map((k) => k.keyText);
      const nowMs = ctx.now.getTime();
      const c = new Collector();

      let matches: PatternMatch[];
      try { matches = await patterns.patterns({ keys: keyTexts }); } catch { return unavailable("PATTERN_PROVIDER_UNAVAILABLE", "the historical pattern provider is unavailable"); } // the provider's own message is never stored
      if (!Array.isArray(matches)) return unavailable("PATTERN_DATA_MALFORMED", "the historical pattern provider returned malformed data");
      const seen = new Set<string>();
      for (const m of matches) {
        if (patternProblem(m) !== null || !keyTexts.includes(m.keyText) || seen.has(m.keyText)) return unavailable("PATTERN_DATA_MALFORMED", "the historical pattern provider returned malformed data");
        seen.add(m.keyText);
      }
      if (matches.length === 0) return unavailable("NO_MATCHING_PATTERN", "the pattern library has no pattern matching this setup");
      const usable = matches.filter((m) => m.status !== "INSUFFICIENT_EVIDENCE" && m.sampleSize >= H.minSample).sort((a, b) => b.level - a.level);
      const chosen = usable[0];
      if (!chosen) return unavailable("INSUFFICIENT_SAMPLE", "no matching pattern has the minimum sample of evaluated outcomes");

      let o: OutcomeDistribution | null;
      try { o = await outcomes.outcomes({ keyText: chosen.keyText }); } catch { return unavailable("OUTCOME_PROVIDER_UNAVAILABLE", "the historical outcome provider is unavailable"); }
      if (o === null) return unavailable("OUTCOME_DATA_NOT_AVAILABLE", "the historical outcome provider has no outcomes for the matching pattern");
      if (outcomeProblem(o) !== null || o.keyText !== chosen.keyText) return unavailable("OUTCOME_DATA_MALFORMED", "the historical outcome provider returned malformed data");
      if (o.evaluable < H.minSample || o.entered < 1) return unavailable("INSUFFICIENT_SAMPLE", "the evaluated outcomes are below the minimum sample");

      // staleness: the older of the pattern run and the outcome data decides
      c.check();
      const ageDays = Math.max((nowMs - Date.parse(chosen.asOf)) / DAY, (nowMs - Date.parse(o.asOf)) / DAY);
      const future = Math.min((nowMs - Date.parse(chosen.asOf)), (nowMs - Date.parse(o.asOf))) < -H.futureToleranceMinutes * 60_000;
      if (future) return unavailable("HISTORICAL_DATA_FROM_FUTURE", "the historical data is dated in the future");
      if (ageDays > H.unavailableDays) return unavailable("HISTORICAL_DATA_TOO_OLD", "the historical data is too old to describe the setup");
      if (ageDays > H.staleCautionDays) c.add("CAUTION", "HISTORICAL_DATA_STALE", `The historical data is ${Math.floor(ageDays)} days old.`, { ageDays: Math.floor(ageDays) });
      if (chosen.lastObserved !== null && (nowMs - Date.parse(chosen.lastObserved)) / DAY > H.lastObservedMaxDays) c.add("CAUTION", "PATTERN_NOT_RECENT", `The pattern was last observed more than ${H.lastObservedMaxDays} days ago.`);
      if (chosen.status === "LOW_QUALITY_EVIDENCE") c.add("CAUTION", "LOW_QUALITY_EVIDENCE", "The pattern library marks this pattern's evidence as low quality.");
      const unverifiableShare = o.unverifiable / (o.evaluable + o.unverifiable);
      if (unverifiableShare > H.maxUnverifiableRate) c.add("CAUTION", "UNVERIFIABLE_SHARE_HIGH", `${r4(unverifiableShare * 100)}% of the pattern's outcomes could not be verified.`, { share: r4(unverifiableShare) });

      // outcome distribution
      c.check();
      let support = 0;
      const winRate = o.wins / o.entered;
      const w = wilsonInterval(o.wins, o.entered, H.wilsonZ) as { lower: number; upper: number };
      const exp = o.netExpectancyR, lb = o.netExpectancyLowerBoundR;
      const critical = o.evaluable >= H.criticalMinSample && w.upper < H.criticalWinUpper && exp !== null && exp <= H.criticalExpectancyR;
      if (critical) c.add(H.criticalSeverity, "HISTORICAL_CRITICAL_ADVERSE", `Of ${o.entered} entered historical outcomes ${o.wins} reached a target (${r4(winRate * 100)}%, upper bound ${r4(w.upper * 100)}%) with a net expectancy of ${r4(exp as number)}R.`, { entered: o.entered, wins: o.wins, netExpectancyR: r4(exp as number) });
      else if (w.upper < H.winUpperAdverse && (exp === null || exp <= H.expectancyCautionR)) c.add("ADVERSE", "WIN_RATE_ADVERSE", `Of ${o.entered} entered historical outcomes ${o.wins} reached a target (${r4(winRate * 100)}%, upper bound ${r4(w.upper * 100)}%).`, { entered: o.entered, wins: o.wins, upper: r4(w.upper) });
      else if (w.upper < H.winUpperCaution) c.add("CAUTION", "WIN_RATE_BELOW_EVEN", `Of ${o.entered} entered historical outcomes ${o.wins} reached a target (${r4(winRate * 100)}%, upper bound ${r4(w.upper * 100)}%).`, { entered: o.entered, wins: o.wins, upper: r4(w.upper) });
      else if (w.lower >= H.winLowerSupportive) { support++; c.add("INFO", "WIN_RATE_SUPPORTIVE", `Of ${o.entered} entered historical outcomes ${o.wins} reached a target (${r4(winRate * 100)}%, lower bound ${r4(w.lower * 100)}%).`, { entered: o.entered, wins: o.wins, lower: r4(w.lower) }); }
      else c.add("INFO", "WIN_RATE_UNDETERMINED", `Of ${o.entered} entered historical outcomes ${o.wins} reached a target (${r4(winRate * 100)}%, interval ${r4(w.lower * 100)}%-${r4(w.upper * 100)}%).`, { entered: o.entered, wins: o.wins });
      if (!critical) {
        if (exp === null) c.add("CAUTION", "EXPECTANCY_MISSING", "The pattern's net expectancy is not available.");
        else if (exp <= H.expectancyAdverseR && lb !== null && lb < 0) c.add("ADVERSE", "EXPECTANCY_NEGATIVE", `The pattern's net expectancy is ${r4(exp)}R per evaluated outcome (lower bound ${r4(lb)}R).`, { netExpectancyR: r4(exp), lowerBound: r4(lb) });
        else if (exp <= H.expectancyCautionR) c.add("CAUTION", "EXPECTANCY_NOT_POSITIVE", `The pattern's net expectancy is ${r4(exp)}R per evaluated outcome.`, { netExpectancyR: r4(exp) });
        else if (lb !== null && lb > H.expectancyLowerSupportiveR) { support++; c.add("INFO", "EXPECTANCY_SUPPORTIVE", `The pattern's net expectancy is ${r4(exp)}R (lower bound ${r4(lb)}R).`, { netExpectancyR: r4(exp), lowerBound: r4(lb) }); }
        else c.add("INFO", "EXPECTANCY_UNCERTAIN", `The pattern's net expectancy is ${r4(exp)}R but its lower bound is not above ${H.expectancyLowerSupportiveR}R.`, { netExpectancyR: r4(exp) });
      }
      let payoff: number | null = null;
      if (o.averageWinnerR !== null && o.averageLoserR !== null && o.averageLoserR < 0) { payoff = o.averageWinnerR / Math.abs(o.averageLoserR); c.add("INFO", "PAYOFF_RATIO", `The average winner (${r4(o.averageWinnerR)}R) is ${r4(payoff)} times the average loser (${r4(o.averageLoserR)}R).`, { payoff: r4(payoff) }); }
      if (chosen.level < H.minLevelForSupport) c.add("INFO", "PATTERN_BROAD", `Only a level ${chosen.level} pattern matched; the minimum level for support is ${H.minLevelForSupport}.`);

      // regime and volatility similarity with the historical sample
      c.check();
      let regime: string | null = null, vol: string | null = null, regimeShare: number | null = null, volShare: number | null = null;
      if (ohlc) {
        try {
          const need = Math.max(H.regimeLookback + 1, H.atrPeriod + 1);
          const d = await loadMarketBars({ rules, ohlc, price, symbol: f.underlying, nowMs, minBars: need, c });
          const closes = d.bars.map((b) => b.close), n = closes.length;
          let path = 0;
          for (let i = n - H.regimeLookback; i < n; i++) path += Math.abs((closes[i] as number) - (closes[i - 1] as number));
          const er = path === 0 ? 0 : Math.abs((closes[n - 1] as number) - (closes[n - 1 - H.regimeLookback] as number)) / path;
          regime = er < H.regimeEfficiency ? "RANGE" : "TRENDING";
          let tr = 0;
          for (let i = n - H.atrPeriod; i < n; i++) { const b = d.bars[i]!, pc = closes[i - 1] as number; tr += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)); }
          const atrPct = (tr / H.atrPeriod / d.refPrice) * 100;
          vol = atrPct < H.volatilityLowPct ? "LOW" : atrPct >= H.volatilityHighPct ? "HIGH" : "NORMAL";
        } catch (e) { if (!(e instanceof AgentUnavailableError)) throw e; }
      }
      if (regime === null || vol === null) c.add("INFO", "CONDITIONS_NOT_COMPARED", "The current market regime and volatility could not be determined, so similarity with the historical sample is not assessed.");
      else if (chosen.regimeMix === null || chosen.volatilityMix === null) c.add("INFO", "CONDITIONS_NOT_RECORDED", "The pattern records no regime or volatility mix, so similarity is not assessed.");
      else {
        regimeShare = chosen.regimeMix[regime] ?? 0; volShare = chosen.volatilityMix[vol] ?? 0;
        if (regimeShare < H.minRegimeShare) c.add("CAUTION", "REGIME_MISMATCH", `The current regime is ${regime}; ${r4(regimeShare * 100)}% of the historical sample was in that regime.`, { regime, share: r4(regimeShare) });
        if (volShare < H.minVolatilityShare) c.add("CAUTION", "VOLATILITY_MISMATCH", `Current volatility is ${vol}; ${r4(volShare * 100)}% of the historical sample was in that bucket.`, { volatility: vol, share: r4(volShare) });
      }

      const out: Record<string, number | string> = {};
      if (exp !== null) out["netExpectancyR"] = r4(exp);
      if (lb !== null) out["netExpectancyLowerBoundR"] = r4(lb);
      if (payoff !== null) out["payoffRatio"] = r4(payoff);
      if (regime !== null) out["currentRegime"] = regime;
      if (vol !== null) out["currentVolatility"] = vol;
      if (regimeShare !== null) out["regimeShare"] = r4(regimeShare);
      if (volShare !== null) out["volatilityShare"] = r4(volShare);
      const base = c.output([...evidenceRef("risk_decision", rd.id), ...evidenceRef("historical_pattern", `${patterns.name}#${chosen.keyText}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150))], {
        patternProvider: patterns.name.slice(0, 80), outcomeProvider: outcomes.name.slice(0, 80), patternKey: chosen.keyText.slice(0, 300), patternLevel: chosen.level, evidenceStatus: chosen.status, sampleSize: o.evaluable, entered: o.entered, wins: o.wins, losses: o.losses,
        winRate: r4(winRate), winRateLower: r4(w.lower), winRateUpper: r4(w.upper), unverifiableShare: r4(unverifiableShare), dataAgeDays: Math.max(0, Math.floor(ageDays)), matchedLevels: matches.map((m) => m.level).sort().join(","), supportiveMeasures: support,
        sourceIntelligenceStatus: typeof si?.status === "string" ? si.status.slice(0, 30) : "none", ...out,
      });
      const comparable = regime !== null && vol !== null && chosen.regimeMix !== null && chosen.volatilityMix !== null;
      if (base.verdict === "SUPPORTIVE" && (support < 2 || chosen.level < H.minLevelForSupport || chosen.status !== "SUFFICIENT" || !comparable)) return { ...base, verdict: "NEUTRAL", confidence: 70 };
      return base;
    },
  };
}
