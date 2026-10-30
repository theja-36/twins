import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, fin } from "./common";
import { loadMarketBars } from "./ohlcCommon";
import type { LastPriceProvider, OhlcProvider } from "./ohlcProviders";
import { checkAge, quoteQuery, r2, spreadPct, type Rd } from "./quoteCommon";
import { chainProblem, optionQuoteProblem, type OptionChain, type OptionsChainProvider, type OptionsQuoteProvider } from "./quoteProviders";
import type { AgentRulesConfig } from "./rules";

/**
 * Options Risk Agent (`options-risk-v1`, Stage 5 / Task 6). Describes the option-specific risk profile of an option signal (premium, spread, implied volatility, theta, gamma, vega, delta, strike distance,
 * expiry proximity, open interest, volume, premium stop-loss) from INJECTED option quotes and chain (no broker, no external API, no model, never message text). Evidence only: no cause is inferred.
 * Signals on any other instrument are NEUTRAL with `applicable: false`.
 *
 *   UNAVAILABLE (never a pass): no option-quote provider, a provider that throws, no quote for the contract, a malformed quote / chain, no usable price, no underlying price from any source, a quote older than the
 *     unavailable limit or dated in the future, an incomplete contract
 *   BLOCKING : expired contract; extreme IV level or IV rise; extreme theta / gamma within the final hours; premium already through the stop-loss (extreme and stop behaviour configurable BLOCKING | ADVERSE)
 *   ADVERSE  : high IV / IV spike; expiry within the day; high theta decay (long); high gamma inside the gamma window; wide premium spread; no market on the side the signal needs; poor open interest; no traded volume;
 *              deep out-of-the-money long; entry premium far from the quote; stop-loss inside the spread
 *   CAUTION  : elevated IV / rising IV / IV above the at-the-money level; expiry within the caution window; moderate theta / gamma / vega; delta near 0 or 1; deep ITM; low OI / volume; unlisted strike;
 *              premium below intrinsic value or very low; missing greeks; stale quote; unusable chain
 *   NEUTRAL  : too few dimensions could be assessed;  SUPPORTIVE: nothing cautionary and at least four dimensions assessed
 */
export const OPTIONS_RISK_AGENT_ID = "options-risk-v1";

export function optionsRiskContract(): AgentContract {
  return {
    agentId: OPTIONS_RISK_AGENT_ID, agentName: "Options Risk Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context", "signal_features", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, applicable: { type: "boolean" }, provider: { type: "string" }, chainProvider: { type: "string" }, side: { type: "string" }, optionType: { type: "string" }, strike: { type: "number" },
      expiry: { type: "string" }, hoursToExpiry: { type: "number" }, premium: { type: "number" }, spreadPct: { type: "number" }, iv: { type: "number" }, ivChangePct: { type: "number" }, delta: { type: "number" },
      thetaPct: { type: "number" }, gammaDeltaPer1Pct: { type: "number" }, vegaPct: { type: "number" }, openInterest: { type: "number" }, volume: { type: "number" }, underlyingPrice: { type: "number" },
      underlyingSource: { type: "string" }, moneynessPct: { type: "number" }, quoteAgeMinutes: { type: "number" }, dimensionsAssessed: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}

const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };
const HOUR = 3_600_000;

export function optionsRiskAgent(rules: AgentRulesConfig, quotes: OptionsQuoteProvider | null, chains: OptionsChainProvider | null, ohlc: OhlcProvider | null, prices: LastPriceProvider | null): AgentDefinition {
  const O = rules.optionsRisk;
  return {
    contract: optionsRiskContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      const siStatus = typeof si?.status === "string" ? si.status.slice(0, 30) : "none";
      if ((rd.instrumentType ?? "").toLowerCase() !== "option") {
        const na = new Collector();
        na.add("INFO", "NOT_AN_OPTION", "The signal is not an option; option risk does not apply.");
        return { ...na.output(evidenceRef("risk_decision", rd.id), { applicable: false, sourceIntelligenceStatus: siStatus }), verdict: "NEUTRAL", confidence: 70 };
      }
      const query = quoteQuery(rd);
      if (query === null || query.expiry === null || query.strike === null || query.optionType === null) return unavailable("CONTRACT_INCOMPLETE", "the option contract (market, underlying, expiry, strike, CE/PE) is not fully specified");
      if (!quotes) return unavailable("OPTION_QUOTE_PROVIDER_NOT_CONFIGURED", "no option-quote provider is configured; option risk cannot be assessed");
      const c = new Collector();
      let q;
      try { q = await quotes.quote(query); } catch { return unavailable("OPTION_QUOTE_PROVIDER_UNAVAILABLE", "the option-quote provider is unavailable"); } // the provider's own message is never stored
      if (q === null) return unavailable("OPTION_QUOTE_NOT_AVAILABLE", "the option-quote provider has no quote for this contract");
      if (optionQuoteProblem(q, query.optionType) !== null) return unavailable("OPTION_QUOTE_MALFORMED", "the option-quote provider returned malformed data");
      const nowMs = ctx.now.getTime();
      const age = checkAge(rules, q.asOf, nowMs, c, "option quote", "OPTION_QUOTE");
      const both = q.bid !== null && q.ask !== null;
      const premium = both ? ((q.bid as number) + (q.ask as number)) / 2 : q.premium;
      if (premium === null) return unavailable("OPTION_QUOTE_NO_PRICE", "the option quote has no premium and no two-sided market");

      const side = rd.side === "BUY" || rd.side === "SELL" ? rd.side : null;
      const long = side === "BUY";
      const sevHigh = O.extremeSeverity;
      const strike = query.strike, isCall = query.optionType === "CE";
      let dims = 0;

      // chain (optional context)
      let chain: OptionChain | null = null;
      c.check();
      if (!chains) c.add("INFO", "CHAIN_NOT_CONFIGURED", "No option-chain provider is configured; the strike could not be compared with the chain.");
      else {
        let ch;
        try { ch = await chains.chain({ market: query.market, underlying: query.symbol, expiry: query.expiry }); } catch { ch = undefined; }
        if (ch === undefined) c.add("CAUTION", "CHAIN_UNAVAILABLE", "The option-chain provider is unavailable.");
        else if (ch === null) c.add("CAUTION", "CHAIN_NOT_AVAILABLE", "The option-chain provider has no chain for this underlying and expiry.");
        else if (chainProblem(ch) !== null) return unavailable("CHAIN_MALFORMED", "the option-chain provider returned malformed data");
        else {
          try { checkAge(rules, ch.asOf, nowMs, c, "option chain", "CHAIN"); chain = ch; } catch { c.add("CAUTION", "CHAIN_UNUSABLE", "The option chain is too old or dated in the future to be used."); }
        }
      }

      // underlying price: quote, then chain, then the OHLC / last-price providers
      let u: number | null = q.underlyingPrice, uSource = "quote";
      if (u === null && chain?.underlyingPrice != null) { u = chain.underlyingPrice; uSource = "chain"; }
      if (u === null && ohlc) {
        try { u = (await loadMarketBars({ rules, ohlc, price: prices, symbol: query.symbol, nowMs, minBars: 2, c })).refPrice; uSource = "ohlc"; } catch (e) { if (!(e instanceof AgentUnavailableError)) throw e; }
      }
      if (u === null) return unavailable("UNDERLYING_PRICE_UNAVAILABLE", "no underlying price is available from the quote, the chain or the OHLC provider");

      // contract time to expiry
      c.check();
      const closeMs = Date.parse(`${query.expiry}T${O.expiryCloseUtc}:00Z`);
      const hours = (closeMs - nowMs) / HOUR;
      if (hours <= 0) c.add("BLOCKING", "OPTION_EXPIRED", "The contract's expiry time has passed.", { expiry: query.expiry });
      else if (hours <= O.expiryExtremeHours) c.add(sevHigh, "EXPIRY_IMMINENT", `The contract expires in ${r2(hours)} hours.`, { hoursToExpiry: r2(hours) });
      else if (hours <= O.expiryAdverseHours) c.add("ADVERSE", "EXPIRY_WITHIN_DAY", `The contract expires in ${r2(hours)} hours.`, { hoursToExpiry: r2(hours) });
      else if (hours <= O.expiryCautionDays * 24) c.add("CAUTION", "EXPIRY_NEAR", `The contract expires in ${r2(hours / 24)} days.`, { daysToExpiry: r2(hours / 24) });
      else c.add("INFO", "EXPIRY_DISTANT", `The contract expires in ${r2(hours / 24)} days.`, { daysToExpiry: r2(hours / 24) });
      dims++;

      // premium sanity
      c.check();
      if (premium >= u) return unavailable("OPTION_PREMIUM_IMPLAUSIBLE", "the option premium is not below the underlying price");
      const intrinsic = isCall ? Math.max(u - strike, 0) : Math.max(strike - u, 0);
      if (premium < O.minPremium) c.add("CAUTION", "PREMIUM_VERY_LOW", `The premium is ${r2(premium)}, below ${O.minPremium}.`, { premium: r2(premium) });
      if (intrinsic > 0 && premium < intrinsic * 0.98) c.add("CAUTION", "PREMIUM_BELOW_INTRINSIC", `The premium (${r2(premium)}) is below the intrinsic value (${r2(intrinsic)}).`, { premium: r2(premium), intrinsic: r2(intrinsic) });
      if (fin(rd.entryPrice) && rd.entryPrice > 0) {
        const dev = Math.abs(premium / rd.entryPrice - 1) * 100;
        if (dev >= O.entryDeviationAdversePct) c.add("ADVERSE", "ENTRY_FAR_FROM_QUOTE", `The entry premium differs from the current option quote by ${r2(dev)}%.`, { deviationPct: r2(dev), entry: rd.entryPrice, quote: r2(premium) });
        else if (dev >= O.entryDeviationCautionPct) c.add("CAUTION", "ENTRY_AWAY_FROM_QUOTE", `The entry premium differs from the current option quote by ${r2(dev)}%.`, { deviationPct: r2(dev), entry: rd.entryPrice, quote: r2(premium) });
      }

      // spread and the side the signal needs
      c.check();
      let sp: number | null = null;
      if (both) {
        sp = spreadPct(q.bid as number, q.ask as number);
        dims++;
        if (sp >= O.spreadAdversePct) c.add("ADVERSE", "PREMIUM_SPREAD_WIDE", `The option bid/ask spread is ${r2(sp)}% of the mid price.`, { spreadPct: r2(sp), limitPct: O.spreadAdversePct });
        else if (sp >= O.spreadCautionPct) c.add("CAUTION", "PREMIUM_SPREAD_MODERATE", `The option bid/ask spread is ${r2(sp)}% of the mid price.`, { spreadPct: r2(sp), limitPct: O.spreadCautionPct });
      } else if ((side !== "SELL" && q.ask === null) || (side !== "BUY" && q.bid === null)) c.add("ADVERSE", "NO_MARKET_SIDE", "The option quote has no market on the side the signal needs.");
      else c.add("CAUTION", "ONE_SIDED_QUOTE", "The option quote is one-sided.");

      // implied volatility: level and change
      c.check();
      if (q.iv === null) c.add("CAUTION", "IV_MISSING", "The option quote carries no implied volatility.");
      else {
        dims++;
        if (q.iv >= O.ivExtreme) c.add(sevHigh, "IV_EXTREME", `Implied volatility is ${r2(q.iv)}%.`, { iv: r2(q.iv), limit: O.ivExtreme });
        else if (q.iv >= O.ivAdverse) c.add("ADVERSE", "IV_HIGH", `Implied volatility is ${r2(q.iv)}%.`, { iv: r2(q.iv), limit: O.ivAdverse });
        else if (q.iv >= O.ivCaution) c.add("CAUTION", "IV_ELEVATED", `Implied volatility is ${r2(q.iv)}%.`, { iv: r2(q.iv), limit: O.ivCaution });
        if (q.ivPrevious !== null) {
          const chg = (q.iv / q.ivPrevious - 1) * 100;
          if (chg >= O.ivSpikeExtremePct) c.add(sevHigh, "IV_SPIKE_EXTREME", `Implied volatility is ${r2(chg)}% above the previous session (${r2(q.iv)}% against ${r2(q.ivPrevious)}%).`, { changePct: r2(chg) });
          else if (chg >= O.ivSpikeAdversePct) c.add("ADVERSE", "IV_SPIKE", `Implied volatility is ${r2(chg)}% above the previous session (${r2(q.iv)}% against ${r2(q.ivPrevious)}%).`, { changePct: r2(chg) });
          else if (chg >= O.ivSpikeCautionPct) c.add("CAUTION", "IV_RISING", `Implied volatility is ${r2(chg)}% above the previous session (${r2(q.iv)}% against ${r2(q.ivPrevious)}%).`, { changePct: r2(chg) });
        }
      }

      // chain: listed strike, IV against the at-the-money level
      c.check();
      if (chain) {
        dims++;
        if (!chain.rows.some((r) => r.strike === strike && r.optionType === query.optionType)) c.add("CAUTION", "STRIKE_NOT_IN_CHAIN", `The strike ${strike} is not listed in the option chain.`, { strike });
        const atm = chain.rows.filter((r) => r.iv !== null).sort((a, b) => Math.abs(a.strike - (u as number)) - Math.abs(b.strike - (u as number)) || a.strike - b.strike)[0];
        if (atm && atm.iv !== null && q.iv !== null && q.iv / atm.iv >= O.ivAtmRatioCaution) c.add("CAUTION", "IV_ABOVE_ATM", `Implied volatility (${r2(q.iv)}%) is ${r2(q.iv / atm.iv)} times the at-the-money level (${r2(atm.iv)}%).`, { ratio: r2(q.iv / atm.iv) });
      }

      // greeks
      c.check();
      const miss = (["delta", "gamma", "theta", "vega"] as const).filter((k) => q[k] === null);
      if (miss.length > 0) c.add("CAUTION", "GREEKS_INCOMPLETE", `The option quote carries no ${miss.join(", ")}.`, { missing: miss.join(",") });
      else dims++;
      let thetaPct: number | null = null, gammaMove: number | null = null, vegaPct: number | null = null;
      if (q.theta !== null) {
        thetaPct = Math.abs(q.theta) / premium * 100;
        if (long) {
          if (thetaPct >= O.thetaAdversePct && hours > 0 && hours <= O.expiryExtremeHours) c.add(sevHigh, "THETA_DECAY_EXTREME", `Time decay is ${r2(thetaPct)}% of the premium per day with ${r2(hours)} hours to expiry.`, { thetaPct: r2(thetaPct), hoursToExpiry: r2(hours) });
          else if (thetaPct >= O.thetaAdversePct) c.add("ADVERSE", "THETA_DECAY_HIGH", `Time decay is ${r2(thetaPct)}% of the premium per day.`, { thetaPct: r2(thetaPct) });
          else if (thetaPct >= O.thetaCautionPct) c.add("CAUTION", "THETA_DECAY_MODERATE", `Time decay is ${r2(thetaPct)}% of the premium per day.`, { thetaPct: r2(thetaPct) });
        } else c.add("INFO", "THETA_DECAY_FOR_SELLER", `Time decay is ${r2(thetaPct)}% of the premium per day (the position is a sale).`, { thetaPct: r2(thetaPct) });
      }
      if (q.gamma !== null) {
        gammaMove = q.gamma * u * 0.01;
        if (hours > 0 && hours <= O.gammaWindowDays * 24) {
          if (gammaMove >= O.gammaAdverse && hours <= O.expiryExtremeHours) c.add(sevHigh, "GAMMA_RISK_EXTREME", `Delta changes by ${r2(gammaMove)} for a 1% underlying move, with ${r2(hours)} hours to expiry.`, { deltaChange: r2(gammaMove), hoursToExpiry: r2(hours) });
          else if (gammaMove >= O.gammaAdverse) c.add("ADVERSE", "GAMMA_RISK_HIGH", `Delta changes by ${r2(gammaMove)} for a 1% underlying move, with ${r2(hours)} hours to expiry.`, { deltaChange: r2(gammaMove), hoursToExpiry: r2(hours) });
          else if (gammaMove >= O.gammaCaution) c.add("CAUTION", "GAMMA_RISK_MODERATE", `Delta changes by ${r2(gammaMove)} for a 1% underlying move, with ${r2(hours)} hours to expiry.`, { deltaChange: r2(gammaMove), hoursToExpiry: r2(hours) });
        } else if (gammaMove >= O.gammaCaution) c.add("INFO", "GAMMA_OUTSIDE_WINDOW", `Delta changes by ${r2(gammaMove)} for a 1% underlying move (expiry is beyond the ${O.gammaWindowDays}-day gamma window).`, { deltaChange: r2(gammaMove) });
      }
      if (q.vega !== null) {
        vegaPct = q.vega / premium * 100;
        if (vegaPct >= O.vegaCautionPct && q.iv !== null && q.iv >= O.ivCaution) c.add("CAUTION", "VEGA_EXPOSURE", `A one-point change in implied volatility moves the premium by ${r2(vegaPct)}%, with implied volatility at ${r2(q.iv)}%.`, { vegaPct: r2(vegaPct) });
      }
      if (q.delta !== null) {
        const ad = Math.abs(q.delta);
        if (ad < O.deltaLow) c.add("CAUTION", "DELTA_LOW", `The absolute delta is ${r2(ad)}.`, { delta: r2(q.delta) });
        else if (ad > O.deltaHigh) c.add("CAUTION", "DELTA_HIGH", `The absolute delta is ${r2(ad)}.`, { delta: r2(q.delta) });
      }

      // strike distance
      c.check();
      const otmPct = (isCall ? strike / u - 1 : 1 - strike / u) * 100;
      if (otmPct > 0) {
        if (!long) c.add("INFO", "STRIKE_OTM_FOR_SELLER", `The strike is ${r2(otmPct)}% out of the money (the position is a sale).`, { otmPct: r2(otmPct) });
        else if (otmPct >= O.otmAdversePct) c.add("ADVERSE", "STRIKE_FAR_OTM", `The strike is ${r2(otmPct)}% out of the money.`, { otmPct: r2(otmPct) });
        else if (otmPct >= O.otmCautionPct) c.add("CAUTION", "STRIKE_OTM", `The strike is ${r2(otmPct)}% out of the money.`, { otmPct: r2(otmPct) });
      } else if (-otmPct >= O.itmCautionPct) c.add("CAUTION", "STRIKE_DEEP_ITM", `The strike is ${r2(-otmPct)}% in the money.`, { itmPct: r2(-otmPct) });

      // open interest and volume
      c.check();
      if (q.openInterest === null) c.add("CAUTION", "OPEN_INTEREST_MISSING", "The option quote carries no open interest.");
      else {
        dims++;
        if (q.openInterest < O.poorOpenInterest) c.add("ADVERSE", "OPEN_INTEREST_POOR", `Open interest is ${q.openInterest}, below ${O.poorOpenInterest}.`, { openInterest: q.openInterest, minimum: O.poorOpenInterest });
        else if (q.openInterest < O.minOpenInterest) c.add("CAUTION", "OPEN_INTEREST_LOW", `Open interest is ${q.openInterest}, below ${O.minOpenInterest}.`, { openInterest: q.openInterest, minimum: O.minOpenInterest });
      }
      if (q.volume === null) c.add("INFO", "VOLUME_MISSING", "The option quote carries no traded volume.");
      else {
        dims++;
        if (q.volume <= O.poorVolume) c.add("ADVERSE", "NO_TRADED_VOLUME", `Traded volume is ${q.volume}.`, { volume: q.volume });
        else if (q.volume < O.minVolume) c.add("CAUTION", "VOLUME_LOW", `Traded volume is ${q.volume}, below ${O.minVolume}.`, { volume: q.volume, minimum: O.minVolume });
      }

      // premium stop-loss coherence
      c.check();
      const stop = rd.stopLoss, entry = rd.entryPrice;
      if (fin(stop) && stop > 0 && fin(entry) && entry > 0 && side !== null) {
        if (side === "BUY" ? stop >= entry : stop <= entry) c.add("ADVERSE", "STOP_INCOHERENT", `The stop-loss premium (${stop}) is not on the loss side of the entry premium (${entry}).`, { stop, entry });
        else {
          const dist = Math.abs(entry - stop);
          if (side === "BUY" ? premium <= stop : premium >= stop) c.add(O.stopInvalidation, "PREMIUM_THROUGH_STOP", `The current premium (${r2(premium)}) is already beyond the stop-loss premium (${stop}).`, { stop, premium: r2(premium) });
          if (both && (q.ask as number) - (q.bid as number) >= dist) c.add("ADVERSE", "STOP_INSIDE_SPREAD", `The stop-loss distance (${r2(dist)}) is not larger than the bid/ask spread (${r2((q.ask as number) - (q.bid as number))}).`, { stopDistance: r2(dist), spread: r2((q.ask as number) - (q.bid as number)) });
          if (long && q.theta !== null && Math.abs(q.theta) >= dist) c.add("CAUTION", "STOP_WITHIN_DAILY_DECAY", `One day of time decay (${r2(Math.abs(q.theta))}) is not smaller than the stop-loss distance (${r2(dist)}).`, { theta: r2(Math.abs(q.theta)), stopDistance: r2(dist) });
          if (q.delta !== null && Math.abs(q.delta) > 0) c.add("INFO", "STOP_IMPLIED_UNDERLYING_MOVE", `With a delta of ${r2(Math.abs(q.delta))}, the stop-loss distance corresponds to about ${r2((dist / Math.abs(q.delta) / u) * 100)}% of the underlying.`, { impliedMovePct: r2((dist / Math.abs(q.delta) / u) * 100) });
        }
      }

      const out: Record<string, number | string> = {};
      const setNum = (k: string, v: number | null): void => { if (v !== null) out[k] = r2(v); };
      setNum("iv", q.iv); setNum("delta", q.delta); setNum("openInterest", q.openInterest); setNum("volume", q.volume); setNum("spreadPct", sp); setNum("thetaPct", thetaPct); setNum("gammaDeltaPer1Pct", gammaMove); setNum("vegaPct", vegaPct);
      if (q.iv !== null && q.ivPrevious !== null) out["ivChangePct"] = r2((q.iv / q.ivPrevious - 1) * 100);
      const base = c.output([...evidenceRef("risk_decision", rd.id), ...evidenceRef("option_quote", `${quotes.name}@${q.asOf}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150))], {
        applicable: true, provider: quotes.name.slice(0, 80), ...(chains ? { chainProvider: chains.name.slice(0, 80) } : {}), side: side ?? "UNKNOWN", optionType: query.optionType, strike, expiry: query.expiry, hoursToExpiry: r2(hours),
        premium: r2(premium), underlyingPrice: r2(u), underlyingSource: uSource, moneynessPct: r2(-otmPct) || 0, quoteAgeMinutes: age, dimensionsAssessed: dims, sourceIntelligenceStatus: siStatus, ...out,
      });
      if (base.verdict === "SUPPORTIVE" && dims < 4) return { ...base, verdict: "NEUTRAL", confidence: 70 };
      return base;
    },
  };
}
