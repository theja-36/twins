import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, fin } from "./common";
import type { LastPriceProvider } from "./ohlcProviders";
import { checkAge, quoteQuery, r2, spreadPct, type Rd } from "./quoteCommon";
import { quoteProblem, type QuoteProvider } from "./quoteProviders";
import type { AgentRulesConfig } from "./rules";

/**
 * Liquidity Agent (`liquidity-v1`, Stage 5 / Task 6). Describes whether the instrument shows enough observable liquidity and reasonable execution conditions for the signal, from an INJECTED
 * quote (no broker, no external API, no model, never message text). Evidence only: it states what the quote shows and infers no cause.
 *
 *   UNAVAILABLE (never a pass): no quote provider, a provider that throws, no quote for the contract, a malformed / crossed quote, no bid and no ask, a quote older than the unavailable limit or dated in the future,
 *     an unsupported instrument type or an incomplete contract
 *   BLOCKING : spread at or beyond the extreme limit, no market on the side the signal needs, no displayed depth on that side (all configurable BLOCKING | ADVERSE)
 *   ADVERSE  : wide spread; low average volume / open interest (poor liquidity); entry price far from the current quote
 *   CAUTION  : moderate spread; thin volume against the average; low open interest; the other side of the market missing; last price outside the quote; stale quote
 *   NEUTRAL  : too few liquidity dimensions could be assessed;  SUPPORTIVE: nothing cautionary and at least two dimensions (spread plus volume, open interest or depth) assessed
 */
export const LIQUIDITY_AGENT_ID = "liquidity-v1";

export function liquidityContract(): AgentContract {
  return {
    agentId: LIQUIDITY_AGENT_ID, agentName: "Liquidity Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context", "signal_features", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, provider: { type: "string" }, instrumentType: { type: "string" }, side: { type: "string" }, bid: { type: "number" }, ask: { type: "number" }, last: { type: "number" }, spreadPct: { type: "number" },
      volume: { type: "number" }, avgVolume: { type: "number" }, volumeRatio: { type: "number" }, openInterest: { type: "number" }, bidDepth: { type: "number" }, askDepth: { type: "number" },
      quoteAgeMinutes: { type: "number" }, dimensionsAssessed: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}

const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };

export function liquidityAgent(rules: AgentRulesConfig, quotes: QuoteProvider | null, prices: LastPriceProvider | null): AgentDefinition {
  const L = rules.liquidity;
  return {
    contract: liquidityContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      const type = (rd.instrumentType ?? "").toLowerCase();
      if (type !== "equity" && type !== "future" && type !== "option") return unavailable("INSTRUMENT_TYPE_UNSUPPORTED", "the instrument type has no liquidity assessment");
      const query = quoteQuery(rd);
      if (query === null) return unavailable("CONTRACT_INCOMPLETE", "the contract (market, symbol, expiry, strike, option type) is not fully specified");
      if (!quotes) return unavailable("QUOTE_PROVIDER_NOT_CONFIGURED", "no quote provider is configured; liquidity cannot be assessed");
      const c = new Collector();
      let q;
      try { q = await quotes.quote(query); } catch { return unavailable("QUOTE_PROVIDER_UNAVAILABLE", "the quote provider is unavailable"); } // the provider's own message is never stored
      if (q === null) return unavailable("QUOTE_NOT_AVAILABLE", "the quote provider has no quote for this contract");
      if (quoteProblem(q) !== null) return unavailable("QUOTE_MALFORMED", "the quote provider returned malformed data");
      if (q.bid === null && q.ask === null) return unavailable("QUOTE_NO_BID_ASK", "the quote has neither a bid nor an ask");
      const nowMs = ctx.now.getTime();
      const age = checkAge(rules, q.asOf, nowMs, c, "quote", "QUOTE");

      const side = rd.side === "BUY" || rd.side === "SELL" ? rd.side : null;
      const isOption = type === "option";
      const sevHigh = L.extremeSeverity;
      let dimensions = 0;

      // the market on the side the signal needs
      c.check();
      const needAsk = side !== "SELL", needBid = side !== "BUY";
      const missing: string[] = [];
      if (needAsk && q.ask === null) missing.push("ask");
      if (needBid && q.bid === null) missing.push("bid");
      if (missing.length > 0) c.add(sevHigh, "NO_MARKET_SIDE", `The quote has no ${missing.join(" or ")}, the side the signal needs.`, { missing: missing.join(",") });
      else if ((q.bid === null || q.ask === null)) c.add("CAUTION", "ONE_SIDED_QUOTE", `The quote has no ${q.bid === null ? "bid" : "ask"}.`);

      // spread
      c.check();
      let sp: number | null = null;
      if (q.bid !== null && q.ask !== null) {
        sp = spreadPct(q.bid, q.ask);
        dimensions++;
        const [cau, adv, ext] = isOption ? [L.optionSpreadCautionPct, L.optionSpreadAdversePct, L.optionSpreadExtremePct] : [L.spreadCautionPct, L.spreadAdversePct, L.spreadExtremePct];
        if (sp >= ext) c.add(sevHigh, "SPREAD_EXTREME", `The bid/ask spread is ${r2(sp)}% of the mid price.`, { spreadPct: r2(sp), limitPct: ext });
        else if (sp >= adv) c.add("ADVERSE", "SPREAD_WIDE", `The bid/ask spread is ${r2(sp)}% of the mid price.`, { spreadPct: r2(sp), limitPct: adv });
        else if (sp >= cau) c.add("CAUTION", "SPREAD_MODERATE", `The bid/ask spread is ${r2(sp)}% of the mid price.`, { spreadPct: r2(sp), limitPct: cau });
        else c.add("INFO", "SPREAD_TIGHT", `The bid/ask spread is ${r2(sp)}% of the mid price.`, { spreadPct: r2(sp) });
      }

      // depth on the needed side
      c.check();
      const depth = side === "SELL" ? q.bidDepth : q.askDepth;
      if (side !== null && q.bid !== null && q.ask !== null) {
        if (depth === null) c.add("INFO", "DEPTH_NOT_PROVIDED", "The feed does not provide displayed depth.");
        else { dimensions++; if (depth < L.minDepthQuantity) c.add(sevHigh, "NO_DEPTH", `The displayed quantity at the best ${side === "SELL" ? "bid" : "ask"} is ${depth}.`, { depth, minimum: L.minDepthQuantity }); }
      }

      // volume against the average
      c.check();
      let ratio: number | null = null;
      if (q.avgVolume === null) c.add("INFO", "AVG_VOLUME_MISSING", "No average volume is available for comparison.");
      else {
        dimensions++;
        if (q.avgVolume < L.poorAvgVolume) c.add("ADVERSE", "POOR_LIQUIDITY", `The average volume is ${q.avgVolume}, below ${L.poorAvgVolume}.`, { avgVolume: q.avgVolume, minimum: L.poorAvgVolume });
        if (q.volume !== null && q.avgVolume > 0) {
          ratio = q.volume / q.avgVolume;
          if (ratio < L.volumeThinRatio) c.add("CAUTION", "THIN_VOLUME", `Volume is ${r2(ratio)} of the average (${q.volume} against ${q.avgVolume}).`, { ratio: r2(ratio), minimum: L.volumeThinRatio });
          else c.add("INFO", "VOLUME_ADEQUATE", `Volume is ${r2(ratio)} of the average.`, { ratio: r2(ratio) });
        }
      }

      // open interest (derivatives)
      c.check();
      if (type !== "equity") {
        if (q.openInterest === null) c.add("CAUTION", "OPEN_INTEREST_MISSING", "The quote carries no open interest for a derivative.");
        else {
          dimensions++;
          if (q.openInterest < L.poorOpenInterest) c.add("ADVERSE", "OPEN_INTEREST_POOR", `Open interest is ${q.openInterest}, below ${L.poorOpenInterest}.`, { openInterest: q.openInterest, minimum: L.poorOpenInterest });
          else if (q.openInterest < L.minOpenInterest) c.add("CAUTION", "OPEN_INTEREST_LOW", `Open interest is ${q.openInterest}, below ${L.minOpenInterest}.`, { openInterest: q.openInterest, minimum: L.minOpenInterest });
        }
      }

      // price sanity
      c.check();
      if (q.last !== null && q.bid !== null && q.ask !== null && (q.last < q.bid * (1 - L.lastOutsideQuotePct / 100) || q.last > q.ask * (1 + L.lastOutsideQuotePct / 100))) {
        c.add("CAUTION", "LAST_OUTSIDE_QUOTE", `The last price (${r2(q.last)}) is outside the bid/ask (${r2(q.bid)} / ${r2(q.ask)}) by more than ${L.lastOutsideQuotePct}%.`, { last: q.last, bid: q.bid, ask: q.ask });
      }
      const ref = q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : (q.last ?? q.bid ?? q.ask);
      if (fin(rd.entryPrice) && rd.entryPrice > 0 && ref !== null) {
        const dev = Math.abs(ref / rd.entryPrice - 1) * 100, m = isOption ? L.optionDeviationMultiplier : 1;
        if (dev >= L.entryDeviationAdversePct * m) c.add("ADVERSE", "ENTRY_FAR_FROM_QUOTE", `The entry price differs from the current quote by ${r2(dev)}%.`, { deviationPct: r2(dev), entry: rd.entryPrice, quote: r2(ref) });
        else if (dev >= L.entryDeviationCautionPct * m) c.add("CAUTION", "ENTRY_AWAY_FROM_QUOTE", `The entry price differs from the current quote by ${r2(dev)}%.`, { deviationPct: r2(dev), entry: rd.entryPrice, quote: r2(ref) });
      }
      if (type === "equity" && prices && ref !== null) {
        let p;
        try { p = await prices.price({ market: query.market, symbol: query.symbol }); } catch { p = undefined; }
        if (p === undefined) c.add("CAUTION", "LAST_PRICE_UNAVAILABLE", "The last-price provider is unavailable; the quote could not be cross-checked.");
        else if (p !== null) {
          if (!p || typeof p.price !== "number" || !Number.isFinite(p.price) || p.price <= 0) c.add("CAUTION", "LAST_PRICE_MALFORMED", "The last-price provider returned malformed data; the quote could not be cross-checked.");
          else {
            const dis = Math.abs(ref / p.price - 1) * 100;
            if (dis > L.lastPriceDisconnectPct) c.add("CAUTION", "QUOTE_PRICE_DISCONNECT", `The quote mid differs from the last price by ${r2(dis)}%.`, { differencePct: r2(dis) });
          }
        }
      }

      const out: Record<string, number | string> = {};
      const setNum = (k: string, v: number | null): void => { if (v !== null) out[k] = v; };
      setNum("bid", q.bid); setNum("ask", q.ask); setNum("last", q.last); setNum("volume", q.volume); setNum("avgVolume", q.avgVolume); setNum("openInterest", q.openInterest); setNum("bidDepth", q.bidDepth); setNum("askDepth", q.askDepth);
      if (sp !== null) out["spreadPct"] = r2(sp);
      if (ratio !== null) out["volumeRatio"] = r2(ratio);
      const base = c.output([...evidenceRef("risk_decision", rd.id), ...evidenceRef("quote", `${quotes.name}@${q.asOf}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150))], {
        provider: quotes.name.slice(0, 80), instrumentType: type, side: side ?? "UNKNOWN", quoteAgeMinutes: age, dimensionsAssessed: dimensions, sourceIntelligenceStatus: typeof si?.status === "string" ? si.status.slice(0, 30) : "none", ...out,
      });
      if (base.verdict === "SUPPORTIVE" && dimensions < 2) return { ...base, verdict: "NEUTRAL", confidence: 70 };
      return base;
    },
  };
}
