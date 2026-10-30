import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, type Level } from "./common";
import { signalDirection } from "./macroGlobal";
import { loadMarketBars, r4 } from "./ohlcCommon";
import type { Candle, LastPriceProvider, OhlcProvider } from "./ohlcProviders";
import type { AgentRulesConfig } from "./rules";

/**
 * Price-Action Agent (`price-action-v1`, Stage 5 / Task 5). Describes recent candlestick evidence relative to the signal direction from INJECTED candles (no external API, no model, never
 * message text). Evidence only: a pattern is reported as observed, not as a prediction.
 *
 *   patterns (the last `patternWindow` candles): bullish / bearish engulfing, hammer, shooting star, rejection wicks, inside bar, outside bar; plus the latest gap, the run of same-direction candles,
 *   range expansion / contraction against the average range, and the entry's distance to the recent extreme
 *   UNAVAILABLE (never a pass): no OHLC provider, a provider that throws, no / too little / malformed / too-old / future-dated candles, a symbol mismatch, candles with no range
 *   ADVERSE  : a reversal pattern against the direction on a strong candle (range >= strongRangeAtr x average range); a gap against the direction >= the adverse gap; a run of candles against the
 *              direction >= the adverse run; a range expansion >= the adverse ratio closing against the direction
 *   critical : a strong reversal pattern against the direction right after an exhaustion run, at the recent extreme -> configured severity (default ADVERSE, may be BLOCKING)
 *   CAUTION  : a weaker reversal pattern; gap / run / expansion at the caution levels; aligned and opposing patterns together (mixed); an extended aligned run (exhaustion context)
 *   NEUTRAL  : no clear pattern;  SUPPORTIVE: nothing cautionary and an aligned pattern or an aligned run of candles
 *   Patterns older than the previous candle are capped at CAUTION.
 */
export const PRICE_ACTION_AGENT_ID = "price-action-v1";

export function priceActionContract(): AgentContract {
  return {
    agentId: PRICE_ACTION_AGENT_ID, agentName: "Price-Action Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context", "signal_features", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, direction: { type: "string" }, provider: { type: "string" }, barsUsed: { type: "number" }, intervalSeconds: { type: "number" }, referencePrice: { type: "number" }, priceSource: { type: "string" },
      averageRange: { type: "number" }, lastRangeRatio: { type: "number" }, runLength: { type: "number" }, runDirection: { type: "string" }, patterns: { type: "string[]" }, alignedPatterns: { type: "number" }, opposingPatterns: { type: "number" },
      gapPct: { type: "number" }, distanceToExtremePct: { type: "number" }, lastBarAgeMinutes: { type: "number" }, providerAgeMinutes: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; side?: string | null; optionType?: string | null };
export type PatternName = "BULLISH_ENGULFING" | "BEARISH_ENGULFING" | "HAMMER" | "SHOOTING_STAR" | "REJECTION_WICK_LOW" | "REJECTION_WICK_HIGH" | "INSIDE_BAR" | "OUTSIDE_BAR";
export interface Pattern { name: PatternName; barsAgo: number; bias: 1 | -1 | 0; range: number }
const body = (b: Candle): number => Math.abs(b.close - b.open);
const rng = (b: Candle): number => b.high - b.low;
const upperWick = (b: Candle): number => b.high - Math.max(b.open, b.close);
const lowerWick = (b: Candle): number => Math.min(b.open, b.close) - b.low;
const DEMOTE: Record<Level, Level> = { BLOCKING: "CAUTION", ADVERSE: "CAUTION", CAUTION: "CAUTION", INFO: "INFO" };

/** Detects the single- and two-candle patterns on bar `i` (needs `i >= 3`). `atr` is the average range of the preceding bars. */
export function detectPatterns(bars: Candle[], i: number, atr: number, p: { minBodyAtr: number; wickRatio: number }): Pattern[] {
  const cur = bars[i] as Candle, prev = bars[i - 1] as Candle, before = bars[i - 3] as Candle;
  const out: Pattern[] = [];
  const barsAgo = bars.length - 1 - i, r = rng(cur);
  const push = (name: PatternName, bias: 1 | -1 | 0): void => { out.push({ name, barsAgo, bias, range: r }); };
  if (prev.close < prev.open && cur.close > cur.open && cur.open <= prev.close && cur.close >= prev.open && body(cur) >= p.minBodyAtr * atr) push("BULLISH_ENGULFING", 1);
  if (prev.close > prev.open && cur.close < cur.open && cur.open >= prev.close && cur.close <= prev.open && body(cur) >= p.minBodyAtr * atr) push("BEARISH_ENGULFING", -1);
  let wicked = false;
  if (r > 0 && body(cur) <= 0.35 * r) {
    if (lowerWick(cur) >= 2 * Math.max(body(cur), 1e-9) && upperWick(cur) <= 0.25 * r && cur.close < before.close) { push("HAMMER", 1); wicked = true; }
    else if (upperWick(cur) >= 2 * Math.max(body(cur), 1e-9) && lowerWick(cur) <= 0.25 * r && cur.close > before.close) { push("SHOOTING_STAR", -1); wicked = true; }
  }
  if (!wicked && r >= p.minBodyAtr * atr && r > 0) {
    if (lowerWick(cur) >= p.wickRatio * r) push("REJECTION_WICK_LOW", 1);
    else if (upperWick(cur) >= p.wickRatio * r) push("REJECTION_WICK_HIGH", -1);
  }
  if (cur.high < prev.high && cur.low > prev.low) push("INSIDE_BAR", 0);
  if (cur.high > prev.high && cur.low < prev.low) push("OUTSIDE_BAR", 0);
  return out;
}

export function priceActionAgent(rules: AgentRulesConfig, ohlc: OhlcProvider | null, price: LastPriceProvider | null): AgentDefinition {
  const a = rules.priceAction;
  return {
    contract: priceActionContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      const underlying = (rd.symbol ?? "").trim().toUpperCase(), market = (rd.market ?? "").trim();
      if (!market || !underlying || underlying === "UNKNOWN") throw new AgentUnavailableError("MISSING_CONTEXT", "the market or underlying is missing");
      const c = new Collector();
      const d = await loadMarketBars({ rules, ohlc, price, symbol: underlying, nowMs: ctx.now.getTime(), minBars: a.minBars, c });
      const { bars } = d, n = bars.length, ref = d.refPrice, last = bars[n - 1] as Candle, prev = bars[n - 2] as Candle;
      const dir = signalDirection((rd.instrumentType ?? "").toLowerCase(), rd.side ?? "", rd.optionType);
      const prior = bars.slice(n - 1 - a.atrPeriod, n - 1);
      const atr = prior.reduce((s, b) => s + rng(b), 0) / prior.length;
      if (!(atr > 0)) throw new AgentUnavailableError("OHLC_DATA_DEGENERATE", "the candles have no range, so price action cannot be assessed");
      const lastRatio = rng(last) / atr;
      c.check();
      if (dir === null) c.add("CAUTION", "DIRECTION_UNKNOWN", "The signal direction cannot be derived from its side and option type, so alignment is not assessed.");

      // the recent extreme in the signal's favour (the high for a bullish signal) and the distance to it
      const win = bars.slice(n - a.extremeLookback);
      const extremeHigh = Math.max(...win.map((b) => b.high)), extremeLow = Math.min(...win.map((b) => b.low));
      const distToExtreme = dir === null ? undefined : dir > 0 ? (extremeHigh / ref - 1) * 100 : (1 - extremeLow / ref) * 100;
      // the run of same-colour candles ending at the last bar
      let run = 0, runDir = 0;
      for (let i = n - 1; i >= 0; i--) { const b = bars[i] as Candle; const col = b.close > b.open ? 1 : b.close < b.open ? -1 : 0; if (col === 0 || (runDir !== 0 && col !== runDir)) break; runDir = col; run++; }

      c.check();
      const found: Pattern[] = [];
      for (let i = Math.max(3, n - a.patternWindow); i < n; i++) found.push(...detectPatterns(bars, i, atr, a));
      let aligned = 0, opposing = 0, supportive = false;
      if (dir !== null) {
        for (const p of found) {
          if (p.bias === 0) {
            if (p.name === "INSIDE_BAR") c.add("INFO", "INSIDE_BAR", `An inside bar was observed ${p.barsAgo} bar(s) ago (range compression).`, { barsAgo: p.barsAgo });
            else {
              const bar = bars[n - 1 - p.barsAgo] as Candle;
              if (dir * (bar.close - bar.open) < 0 && p.range >= a.strongRangeAtr * atr) c.add("CAUTION", "OUTSIDE_BAR_AGAINST", `An outside bar closing against the signal direction was observed ${p.barsAgo} bar(s) ago.`, { barsAgo: p.barsAgo });
              else c.add("INFO", "OUTSIDE_BAR", `An outside bar was observed ${p.barsAgo} bar(s) ago (range expansion).`, { barsAgo: p.barsAgo });
            }
          } else if (p.bias === dir) { aligned++; c.add("INFO", `${p.name}_ALIGNED`, `${p.name.toLowerCase().replace(/_/g, " ")} observed ${p.barsAgo} bar(s) ago, in the signal direction.`, { barsAgo: p.barsAgo }); }
          else {
            opposing++;
            const strong = p.range >= a.strongRangeAtr * atr;
            const idx = n - 1 - p.barsAgo;
            let before = 0;
            for (let j = idx - 1; j >= 0; j--) { const b = bars[j] as Candle; if (dir * (b.close - b.open) > 0) before++; else break; }
            const barExtreme = dir > 0 ? (bars[idx] as Candle).high : (bars[idx] as Candle).low;
            const atExtreme = dir > 0 ? (extremeHigh / barExtreme - 1) * 100 <= a.extremeProximityPct : (barExtreme / extremeLow - 1) * 100 <= a.extremeProximityPct;
            let level: Level = strong ? "ADVERSE" : "CAUTION";
            let code = `${p.name}_AGAINST`;
            if (strong && before >= a.exhaustionRun && atExtreme) { level = a.criticalReversal; code = `${p.name}_EXHAUSTION_AGAINST`; }
            if (p.barsAgo >= 2) level = DEMOTE[level];
            c.add(level, code, `${p.name.toLowerCase().replace(/_/g, " ")} observed ${p.barsAgo} bar(s) ago, against the signal direction${code.endsWith("EXHAUSTION_AGAINST") ? ", after a run of aligned candles and at the recent extreme" : ""}.`, { barsAgo: p.barsAgo, rangeVsAverage: r4(p.range / atr), alignedRunBefore: before });
          }
        }
        if (aligned > 0 && opposing > 0) c.add("CAUTION", "PATTERNS_CONFLICT", "Candlestick patterns both for and against the signal direction were observed in the recent window.", { aligned, opposing });
        if (aligned > 0 && opposing === 0) supportive = true;
      } else for (const p of found) c.add("INFO", `${p.name}_OBSERVED`, `${p.name.toLowerCase().replace(/_/g, " ")} observed ${p.barsAgo} bar(s) ago.`, { barsAgo: p.barsAgo });

      c.check();
      const gap = (last.open / prev.close - 1) * 100;
      if (dir !== null && Math.abs(gap) >= a.gapCautionPct) {
        if (dir * gap > 0) c.add("INFO", "GAP_ALIGNED", `The latest candle opened ${r4(gap)}% from the previous close, in the signal direction.`, { gapPct: r4(gap) });
        else c.add(Math.abs(gap) >= a.gapAdversePct ? "ADVERSE" : "CAUTION", Math.abs(gap) >= a.gapAdversePct ? "GAP_AGAINST_LARGE" : "GAP_AGAINST", `The latest candle opened ${r4(gap)}% from the previous close, against the signal direction.`, { gapPct: r4(gap) });
      }
      c.check();
      if (dir !== null && runDir !== 0) {
        if (dir * runDir < 0) {
          if (run >= a.consecutiveAdverse) c.add("ADVERSE", "CONSECUTIVE_CANDLES_AGAINST_LONG", `${run} consecutive candles closed against the signal direction.`, { run });
          else if (run >= a.consecutiveCaution) c.add("CAUTION", "CONSECUTIVE_CANDLES_AGAINST", `${run} consecutive candles closed against the signal direction.`, { run });
        } else if (run >= a.consecutiveAdverse) c.add("CAUTION", "EXTENDED_RUN_ALIGNED", `${run} consecutive candles closed in the signal direction (an extended run).`, { run });
        else if (run >= a.consecutiveCaution) { supportive = true; c.add("INFO", "CONSECUTIVE_CANDLES_ALIGNED", `${run} consecutive candles closed in the signal direction.`, { run }); }
      }
      c.check();
      if (lastRatio >= a.expansionRatio) {
        const against = dir !== null && dir * (last.close - last.open) < 0;
        c.add(against && lastRatio >= a.expansionAdverseRatio ? "ADVERSE" : "CAUTION", "VOLATILITY_EXPANSION", `The latest candle's range is ${r4(lastRatio)} times the ${a.atrPeriod}-bar average${against ? " and it closed against the signal direction" : ""}.`, { rangeRatio: r4(lastRatio) });
      } else if (lastRatio <= a.contractionRatio) c.add("INFO", "VOLATILITY_CONTRACTION", `The latest candle's range is ${r4(lastRatio)} times the ${a.atrPeriod}-bar average.`, { rangeRatio: r4(lastRatio) });
      if (distToExtreme !== undefined && distToExtreme <= a.extremeProximityPct) c.add("INFO", "ENTRY_NEAR_RECENT_EXTREME", `Price is within ${r4(Math.max(0, distToExtreme))}% of the ${a.extremeLookback}-bar ${dir === 1 ? "high" : "low"}.`, { distancePct: r4(Math.max(0, distToExtreme)) });

      const out = c.output([...evidenceRef("risk_decision", rd.id), ...evidenceRef("ohlc_series", d.evidenceRef)], {
        direction: dir === null ? "UNKNOWN" : dir > 0 ? "BULLISH" : "BEARISH", provider: (ohlc as OhlcProvider).name.slice(0, 80), barsUsed: n, intervalSeconds: d.intervalSeconds, referencePrice: r4(ref), priceSource: d.priceSource,
        averageRange: r4(atr), lastRangeRatio: r4(lastRatio), runLength: run, runDirection: runDir > 0 ? "UP" : runDir < 0 ? "DOWN" : "NONE", patterns: [...new Set(found.map((p) => p.name))].sort(), alignedPatterns: aligned, opposingPatterns: opposing,
        gapPct: r4(gap), lastBarAgeMinutes: d.lastBarAgeMinutes, sourceIntelligenceStatus: typeof si?.status === "string" ? si.status.slice(0, 30) : "none",
        ...(distToExtreme === undefined ? {} : { distanceToExtremePct: r4(distToExtreme) }), ...(d.providerAgeMinutes === null ? {} : { providerAgeMinutes: d.providerAgeMinutes }),
      });
      if (out.verdict === "SUPPORTIVE" && !supportive) return { ...out, verdict: "NEUTRAL", confidence: 70 };
      return out;
    },
  };
}
