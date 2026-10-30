import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, fin } from "./common";
import { signalDirection } from "./macroGlobal";
import { loadMarketBars, r4 } from "./ohlcCommon";
import type { LastPriceProvider, OhlcProvider } from "./ohlcProviders";
import type { AgentRulesConfig } from "./rules";

/**
 * Technical Structure Agent (`technical-structure-v1`, Stage 5 / Task 5). Describes whether the underlying's recent structure agrees with, conflicts with, or complicates the signal
 * direction, from INJECTED candles (no external API, no model, never message text). Evidence only: it states what the series shows and infers no cause or forecast.
 *
 *   UNAVAILABLE (never a pass): no OHLC provider, a provider that throws, no / too little / malformed / too-old / future-dated candles, a snapshot older than the unavailable limit, a symbol mismatch
 *   BLOCKING : price already through the signal's stop-loss (equity / future; configurable BLOCKING | ADVERSE)
 *   ADVERSE  : trend over the long lookback against the direction beyond the adverse threshold; a break of the prior range against the direction (configurable ADVERSE | BLOCKING)
 *   CAUTION  : milder trend conflict; lower-high / lower-low structure against a long (or the mirror); price within the proximity of the nearest opposing swing level; moving averages stacked against
 *              the direction; momentum against or stretched; short and long lookbacks disagreeing; stale snapshot / last price
 *   NEUTRAL  : no clear support;  SUPPORTIVE: nothing cautionary, a trending (not range-bound) regime and at least two aligned signals (trend, structure, break, moving averages, momentum)
 */
export const TECHNICAL_STRUCTURE_AGENT_ID = "technical-structure-v1";

export function technicalStructureContract(): AgentContract {
  return {
    agentId: TECHNICAL_STRUCTURE_AGENT_ID, agentName: "Technical Structure Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context", "signal_features", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, direction: { type: "string" }, provider: { type: "string" }, barsUsed: { type: "number" }, intervalSeconds: { type: "number" }, referencePrice: { type: "number" }, priceSource: { type: "string" },
      trendShortPct: { type: "number" }, trendLongPct: { type: "number" }, regime: { type: "string" }, structure: { type: "string" }, smaFast: { type: "number" }, smaSlow: { type: "number" }, rsi: { type: "number" },
      supportiveSignals: { type: "number" }, lastBarAgeMinutes: { type: "number" }, providerAgeMinutes: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; side?: string | null; optionType?: string | null; stopLoss?: number | null };

const sma = (v: number[], n: number): number => v.slice(-n).reduce((a, x) => a + x, 0) / n;
/** Wilder RSI over the whole series. */
export function rsi(closes: number[], period: number): number {
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = (closes[i] as number) - (closes[i - 1] as number); if (d >= 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) { const d = (closes[i] as number) - (closes[i - 1] as number); gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period; }
  return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
}
/** Swing highs / lows: a bar whose high (low) is strictly beyond the `k` bars before it and at least as extreme as the `k` bars after it (the first of equal extremes counts). */
export function swings(highs: number[], lows: number[], k: number): { highs: Array<{ i: number; v: number }>; lows: Array<{ i: number; v: number }> } {
  const h: Array<{ i: number; v: number }> = [], l: Array<{ i: number; v: number }> = [];
  for (let i = k; i < highs.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!((highs[i] as number) > (highs[i - j] as number) && (highs[i] as number) >= (highs[i + j] as number))) isH = false;
      if (!((lows[i] as number) < (lows[i - j] as number) && (lows[i] as number) <= (lows[i + j] as number))) isL = false;
    }
    if (isH) h.push({ i, v: highs[i] as number });
    if (isL) l.push({ i, v: lows[i] as number });
  }
  return { highs: h, lows: l };
}

export function technicalStructureAgent(rules: AgentRulesConfig, ohlc: OhlcProvider | null, price: LastPriceProvider | null): AgentDefinition {
  const t = rules.technical;
  return {
    contract: technicalStructureContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      const underlying = (rd.symbol ?? "").trim().toUpperCase(), market = (rd.market ?? "").trim();
      if (!market || !underlying || underlying === "UNKNOWN") throw new AgentUnavailableError("MISSING_CONTEXT", "the market or underlying is missing");
      const c = new Collector();
      const d = await loadMarketBars({ rules, ohlc, price, symbol: underlying, nowMs: ctx.now.getTime(), minBars: t.minBars, c });
      const { bars } = d, ref = d.refPrice, n = bars.length;
      const closes = bars.map((b) => b.close), highs = bars.map((b) => b.high), lows = bars.map((b) => b.low);
      const type = (rd.instrumentType ?? "").toLowerCase();
      const dir = signalDirection(type, rd.side ?? "", rd.optionType);
      const out: Record<string, number | string> = {};
      let evidence = 0;
      const pct = (lb: number): number => (ref / (closes[n - 1 - lb] as number) - 1) * 100;
      const trendShort = pct(t.shortLookback), trendLong = pct(t.longLookback);
      // regime: Kaufman efficiency ratio over the long lookback
      let path = 0;
      for (let i = n - t.longLookback; i < n; i++) path += Math.abs((closes[i] as number) - (closes[i - 1] as number));
      const er = path === 0 ? 0 : Math.abs((closes[n - 1] as number) - (closes[n - 1 - t.longLookback] as number)) / path;
      const regime = er < t.rangeEfficiency ? "RANGE" : "TRENDING";
      c.check();
      c.add("INFO", regime === "RANGE" ? "REGIME_RANGE" : "REGIME_TRENDING", `Price efficiency over ${t.longLookback} bars is ${r4(er)} (${regime === "RANGE" ? "range-bound" : "directional"}).`, { efficiency: r4(er) });

      const sw = swings(highs, lows, t.swingStrength);
      const lastH = sw.highs.slice(-2), lastL = sw.lows.slice(-2);
      let structure = "UNDEFINED";
      if (lastH.length === 2 && lastL.length === 2) {
        const hh = (lastH[1] as { v: number }).v > (lastH[0] as { v: number }).v, hl = (lastL[1] as { v: number }).v > (lastL[0] as { v: number }).v;
        const lh = (lastH[1] as { v: number }).v < (lastH[0] as { v: number }).v, ll = (lastL[1] as { v: number }).v < (lastL[0] as { v: number }).v;
        structure = hh && hl ? "HIGHER_HIGHS_HIGHER_LOWS" : lh && ll ? "LOWER_HIGHS_LOWER_LOWS" : "MIXED";
      }
      c.check();
      if (dir === null) c.add("CAUTION", "DIRECTION_UNKNOWN", "The signal direction cannot be derived from its side and option type, so alignment is not assessed.");
      else {
        const aL = dir * trendLong, aS = dir * trendShort;
        if (aL <= -t.trendAdversePct) c.add("ADVERSE", "TREND_AGAINST_STRONG", `Price moved ${r4(trendLong)}% over ${t.longLookback} bars, against the signal direction.`, { trendPct: r4(trendLong), lookbackBars: t.longLookback });
        else if (aL <= -t.trendCautionPct) c.add("CAUTION", "TREND_AGAINST", `Price moved ${r4(trendLong)}% over ${t.longLookback} bars, against the signal direction.`, { trendPct: r4(trendLong), lookbackBars: t.longLookback });
        else if (aL >= t.trendCautionPct) { evidence++; c.add("INFO", "TREND_ALIGNED", `Price moved ${r4(trendLong)}% over ${t.longLookback} bars, in the signal direction.`, { trendPct: r4(trendLong) }); }
        else c.add("INFO", "TREND_FLAT", `Price moved ${r4(trendLong)}% over ${t.longLookback} bars.`, { trendPct: r4(trendLong) });
        if ((aS <= -t.trendCautionPct && aL >= t.trendCautionPct) || (aS >= t.trendCautionPct && aL <= -t.trendCautionPct)) c.add("CAUTION", "TREND_TIMEFRAMES_DISAGREE", `The ${t.shortLookback}-bar move (${r4(trendShort)}%) and the ${t.longLookback}-bar move (${r4(trendLong)}%) point in opposite directions relative to the signal.`, { shortPct: r4(trendShort), longPct: r4(trendLong) });

        // swing structure
        if (structure === "UNDEFINED") c.add("INFO", "STRUCTURE_INSUFFICIENT", "Too few swing points to describe the high / low sequence.");
        else {
          const up = structure === "HIGHER_HIGHS_HIGHER_LOWS", down = structure === "LOWER_HIGHS_LOWER_LOWS";
          if ((dir > 0 && down) || (dir < 0 && up)) c.add("CAUTION", "STRUCTURE_AGAINST", `The recent swing sequence is ${down ? "lower highs and lower lows" : "higher highs and higher lows"}, against the signal direction.`);
          else if ((dir > 0 && up) || (dir < 0 && down)) { evidence++; c.add("INFO", "STRUCTURE_ALIGNED", `The recent swing sequence is ${up ? "higher highs and higher lows" : "lower highs and lower lows"}, in the signal direction.`); }
          else c.add("INFO", "STRUCTURE_MIXED", "The recent swing sequence is mixed.");
        }

        // breakout / breakdown of the prior range
        c.check();
        const prior = bars.slice(n - 1 - t.breakoutLookback, n - 1);
        const hi = Math.max(...prior.map((b) => b.high)), lo = Math.min(...prior.map((b) => b.low));
        if (ref > hi) { if (dir > 0) { evidence++; c.add("INFO", "BREAKOUT_ALIGNED", `Price is above the ${t.breakoutLookback}-bar high.`, { level: r4(hi) }); } else c.add(t.breakdownAgainst, "BREAKOUT_AGAINST", `Price is above the ${t.breakoutLookback}-bar high, against the signal direction.`, { level: r4(hi) }); }
        else if (ref < lo) { if (dir < 0) { evidence++; c.add("INFO", "BREAKDOWN_ALIGNED", `Price is below the ${t.breakoutLookback}-bar low.`, { level: r4(lo) }); } else c.add(t.breakdownAgainst, "BREAKDOWN_AGAINST", `Price is below the ${t.breakoutLookback}-bar low, against the signal direction.`, { level: r4(lo) }); }

        // support / resistance proximity (swing levels of the recent history)
        c.check();
        const res = sw.highs.filter((s) => s.v > ref).map((s) => s.v).sort((a, b) => a - b)[0];
        const sup = sw.lows.filter((s) => s.v < ref).map((s) => s.v).sort((a, b) => b - a)[0];
        const near = (lvl: number | undefined): boolean => lvl !== undefined && Math.abs(lvl / ref - 1) * 100 <= t.srProximityPct;
        if (dir > 0 && near(res)) c.add("CAUTION", "NEAR_RESISTANCE", `Price is within ${t.srProximityPct}% of a swing high above (${r4(res as number)}).`, { level: r4(res as number) });
        if (dir < 0 && near(sup)) c.add("CAUTION", "NEAR_SUPPORT", `Price is within ${t.srProximityPct}% of a swing low below (${r4(sup as number)}).`, { level: r4(sup as number) });
        if (dir > 0 && near(sup)) c.add("INFO", "SUPPORT_NEARBY", `A swing low (${r4(sup as number)}) is within ${t.srProximityPct}% below price.`, { level: r4(sup as number) });
        if (dir < 0 && near(res)) c.add("INFO", "RESISTANCE_NEARBY", `A swing high (${r4(res as number)}) is within ${t.srProximityPct}% above price.`, { level: r4(res as number) });

        // moving averages
        c.check();
        const fast = sma(closes, t.fastMa), slow = sma(closes, t.slowMa);
        out["smaFast"] = r4(fast); out["smaSlow"] = r4(slow);
        const stackedUp = ref > fast && fast > slow, stackedDown = ref < fast && fast < slow;
        if ((dir > 0 && stackedDown) || (dir < 0 && stackedUp)) c.add("CAUTION", "MA_CONFLICT", `Price and the ${t.fastMa}/${t.slowMa}-bar averages are stacked ${stackedDown ? "downward" : "upward"}, against the signal direction.`, { fast: r4(fast), slow: r4(slow) });
        else if ((dir > 0 && stackedUp) || (dir < 0 && stackedDown)) { evidence++; c.add("INFO", "MA_ALIGNED", `Price and the ${t.fastMa}/${t.slowMa}-bar averages are stacked in the signal direction.`, { fast: r4(fast), slow: r4(slow) }); }
        else c.add("INFO", "MA_MIXED", "Price and the moving averages are not stacked in one direction.");

        // momentum (RSI)
        c.check();
        const rs = rsi(closes, t.rsiPeriod);
        out["rsi"] = r4(rs);
        if ((dir > 0 && rs >= t.rsiStretched) || (dir < 0 && rs <= 100 - t.rsiStretched)) c.add("CAUTION", "MOMENTUM_STRETCHED", `RSI(${t.rsiPeriod}) is ${r4(rs)}, stretched in the signal direction.`, { rsi: r4(rs) });
        else if (dir * (rs - 50) <= -t.momentumAgainst) c.add("CAUTION", "MOMENTUM_AGAINST", `RSI(${t.rsiPeriod}) is ${r4(rs)}, against the signal direction.`, { rsi: r4(rs) });
        else if (dir * (rs - 50) >= t.momentumAgainst) { evidence++; c.add("INFO", "MOMENTUM_ALIGNED", `RSI(${t.rsiPeriod}) is ${r4(rs)}, in the signal direction.`, { rsi: r4(rs) }); }

        // invalidation: price already through the signal's stop-loss (only comparable for equity / future)
        c.check();
        if ((type === "equity" || type === "future") && fin(rd.stopLoss) && rd.stopLoss > 0) {
          if ((dir > 0 && ref <= rd.stopLoss) || (dir < 0 && ref >= rd.stopLoss)) c.add(t.invalidation, "PRICE_THROUGH_STOP", "Price is already beyond the signal's stop-loss level.", { stopLoss: r4(rd.stopLoss), price: r4(ref) });
        }
      }
      const base = c.output([...evidenceRef("risk_decision", rd.id), ...evidenceRef("ohlc_series", d.evidenceRef)], {
        direction: dir === null ? "UNKNOWN" : dir > 0 ? "BULLISH" : "BEARISH", provider: (ohlc as OhlcProvider).name.slice(0, 80), barsUsed: n, intervalSeconds: d.intervalSeconds, referencePrice: r4(ref), priceSource: d.priceSource,
        trendShortPct: r4(trendShort), trendLongPct: r4(trendLong), regime, structure, supportiveSignals: evidence, lastBarAgeMinutes: d.lastBarAgeMinutes, sourceIntelligenceStatus: typeof si?.status === "string" ? si.status.slice(0, 30) : "none",
        ...(d.providerAgeMinutes === null ? {} : { providerAgeMinutes: d.providerAgeMinutes }), ...out,
      });
      if (base.verdict === "SUPPORTIVE" && (evidence < 2 || regime === "RANGE")) return { ...base, verdict: "NEUTRAL", confidence: 70 };
      return base;
    },
  };
}
