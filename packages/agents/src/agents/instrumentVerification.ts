import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, fin, isRealDate, nonEmpty } from "./common";
import type { HistoricalInstrumentReference, InstrumentQuery, InstrumentReference, RefInstrumentType } from "./instrumentReference";
import type { AgentRulesConfig } from "./rules";

/**
 * Instrument Verification Agent (`instrument-verification-v1`, Stage 5 / Task 2). Verifies that the market, underlying and contract exist and are internally consistent, using an
 * INJECTED instrument reference (no live API, no broker). It works on parsed fields only, never guesses a missing value and never approves anything.
 *
 *   BLOCKING: unknown / unsupported market, unsupported instrument type, unrecognized underlying, malformed equity symbol, invalid or past expiry, expiry not listed, invalid strike /
 *             option type, contract not found or inactive, no reference configured is UNAVAILABLE (not a pass)
 *   configured (default): expiry beyond the horizon -> ADVERSE; missing lot size (options) / multiplier (futures) -> BLOCKING
 *   CAUTION: expiry today, stale reference snapshot, reference without a snapshot date
 *   INFO: contract seen / not seen in historical datasets (supporting evidence only)
 *   verdict = the worst level; a fully verified instrument = SUPPORTIVE. A failing reference THROWS (retried per the retry policy, then FAILED): an unverifiable instrument is never a pass.
 */
export const INSTRUMENT_VERIFICATION_AGENT_ID = "instrument-verification-v1";
const TYPES: RefInstrumentType[] = ["equity", "future", "option"];
const TZ: Record<string, number> = { NSE: 330, BSE: 330, NFO: 330, BFO: 330 };
const DAY = 86_400_000;

export function instrumentVerificationContract(): AgentContract {
  return {
    agentId: INSTRUMENT_VERIFICATION_AGENT_ID, agentName: "Instrument Verification Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_features", "signal_context"],
    outputSchema: { fields: { ...COMMON_OUTPUT_FIELDS, referenceName: { type: "string" }, contractFound: { type: "boolean" }, daysToExpiry: { type: "number" } } },
    timeoutMs: 5000, retry: { maxAttempts: 2, backoffMs: 50 }, weight: 60, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; expiry?: string | null; strike?: number | null; optionType?: string | null };
/** Today's calendar day (as a day number) in the market's local time. */
const localDay = (now: Date, market: string): number => Math.floor((now.getTime() + (TZ[market] ?? 0) * 60_000) / DAY);

export function instrumentVerificationAgent(rules: AgentRulesConfig, reference: InstrumentReference | null, historical?: HistoricalInstrumentReference): AgentDefinition {
  const r = rules.instrument;
  return {
    contract: instrumentVerificationContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      if (!reference) throw new AgentUnavailableError("INSTRUMENT_REFERENCE_NOT_CONFIGURED", "no instrument reference is configured; the instrument cannot be verified");
      const c = new Collector();
      const market = (rd.market ?? "").trim().toUpperCase();
      const type = (rd.instrumentType ?? "").trim().toLowerCase();
      const underlying = (rd.symbol ?? "").trim().toUpperCase();
      const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
        try { return await fn(); } catch { throw Object.assign(new Error("the instrument reference failed"), { code: "INSTRUMENT_REFERENCE_ERROR" }); } // the provider's own message is never stored
      };
      let contractFound = false, daysToExpiry: number | undefined;

      c.check();
      let marketOk = false;
      if (!market) c.add("BLOCKING", "MARKET_MISSING", "The market is not stated.");
      else if (!(await guard(() => reference.supportsMarket(market)))) c.add("BLOCKING", "MARKET_UNSUPPORTED", "The market is not supported by the instrument reference.");
      else marketOk = true;
      c.check();
      const typeOk = (TYPES as string[]).includes(type);
      if (!type) c.add("BLOCKING", "INSTRUMENT_TYPE_MISSING", "The instrument type is not stated."); else if (!typeOk) c.add("BLOCKING", "INSTRUMENT_TYPE_UNSUPPORTED", "The instrument type is not equity, future or option.");
      c.check();
      let underlyingOk = false;
      if (!underlying || underlying === "UNKNOWN") c.add("BLOCKING", "UNDERLYING_MISSING", "The underlying is not identified.");
      else if (type === "equity" && !/^[A-Z0-9&._-]{1,30}$/.test(underlying)) c.add("BLOCKING", "EQUITY_SYMBOL_INVALID", "The equity symbol is malformed.");
      else if (marketOk && !(await guard(() => reference.underlyingKnown(market, underlying)))) c.add("BLOCKING", "UNDERLYING_UNKNOWN", "The underlying is not recognized in this market.");
      else underlyingOk = marketOk;

      const derivative = type === "future" || type === "option";
      let expiry: string | null = null;
      if (typeOk && derivative) {
        c.check();
        if (!nonEmpty(rd.expiry)) c.add("BLOCKING", "EXPIRY_MISSING", "A derivative needs an expiry date.");
        else if (!isRealDate(rd.expiry)) c.add("BLOCKING", "EXPIRY_INVALID", "The expiry is not a real YYYY-MM-DD date.");
        else {
          expiry = rd.expiry;
          const [y, m, d] = expiry.split("-").map(Number) as [number, number, number];
          const days = Math.round(Date.UTC(y, m - 1, d) / DAY) - localDay(ctx.now, market);
          daysToExpiry = days;
          c.check();
          if (days < 0) c.add("BLOCKING", "EXPIRY_IN_PAST", "The contract has already expired.", { daysToExpiry: days });
          else {
            if (days === 0) c.add("CAUTION", "EXPIRY_TODAY", "The contract expires today.");
            if (days > r.maxExpiryHorizonDays) c.add(r.beyondHorizon, "EXPIRY_BEYOND_HORIZON", `The expiry is more than ${r.maxExpiryHorizonDays} days away.`, { daysToExpiry: days });
          }
        }
      }
      let strike: number | null = null;
      let optionType: "CE" | "PE" | null = null;
      if (type === "option") {
        c.check(); if (!fin(rd.strike) || rd.strike <= 0) c.add("BLOCKING", "STRIKE_INVALID", "The option strike is missing or not a positive number."); else strike = rd.strike;
        c.check(); if (rd.optionType !== "CE" && rd.optionType !== "PE") c.add("BLOCKING", "OPTION_TYPE_INVALID", "The option type is neither CE nor PE."); else optionType = rd.optionType;
      } else if (typeOk) {
        c.check(); if (rd.strike != null || rd.optionType != null) c.add("ADVERSE", "OPTION_FIELDS_ON_NON_OPTION", "A strike or option type is present on an instrument that is not an option.");
      }

      // ── the contract itself ──
      const identified = marketOk && typeOk && underlyingOk && (!derivative || expiry !== null) && (type !== "option" || (strike !== null && optionType !== null));
      if (identified) {
        const q: InstrumentQuery = { market, underlying, instrumentType: type as RefInstrumentType, expiry, strike, optionType };
        c.check();
        const rec = await guard(() => reference.lookup(q));
        if (!rec) {
          if (type === "equity") c.add("BLOCKING", "INSTRUMENT_NOT_FOUND", "The equity symbol is not listed.");
          else {
            const listed = await guard(() => reference.listedExpiries(market, underlying, type as RefInstrumentType));
            if (expiry !== null && !listed.includes(expiry)) c.add("BLOCKING", "EXPIRY_NOT_LISTED", "No contract with this expiry is listed for the underlying.");
            else c.add("BLOCKING", type === "option" ? "STRIKE_NOT_LISTED" : "CONTRACT_NOT_FOUND", type === "option" ? "No option with this strike and type is listed for that expiry." : "The futures contract is not listed.");
          }
        } else {
          contractFound = true;
          c.check(); if (!rec.active) c.add("BLOCKING", "CONTRACT_INACTIVE", "The reference marks the contract as inactive.");
          if (type === "option") { c.check(); if (rec.lotSize === null) c.add(r.missingLotSize, "MISSING_LOT_SIZE", "The option has no lot size, so it cannot be sized."); }
          if (type === "future") { c.check(); if (rec.multiplier === null && rec.lotSize === null) c.add(r.missingLotSize, "MISSING_MULTIPLIER", "The futures contract has no multiplier or lot size, so it cannot be sized."); else if (rec.multiplier === null) c.add("INFO", "MULTIPLIER_FROM_LOT_SIZE", "No multiplier is listed; the lot size is used."); }
        }
        c.check();
        if (reference.asOf === null) c.add("CAUTION", "REFERENCE_AS_OF_UNKNOWN", "The instrument reference carries no snapshot date.");
        else if (ctx.now.getTime() - Date.parse(reference.asOf) > r.referenceMaxAgeDays * DAY) c.add("CAUTION", "REFERENCE_STALE", `The instrument reference snapshot is older than ${r.referenceMaxAgeDays} days.`);
        if (historical && type === "option") {
          const seen = await guard(() => historical.contractSeen(q));
          c.add("INFO", seen ? "CONTRACT_SEEN_IN_HISTORY" : "CONTRACT_NOT_SEEN_IN_HISTORY", seen ? "The contract appears in imported historical data." : "The contract does not appear in imported historical data (supporting evidence only).");
        }
      }
      const evidence = [...evidenceRef("risk_decision", rd.id), ...evidenceRef("instrument_reference", `${reference.name}${reference.asOf ? `@${reference.asOf}` : ""}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150))];
      return c.output(evidence, { referenceName: reference.name.slice(0, 80), contractFound, ...(daysToExpiry === undefined ? {} : { daysToExpiry }) });
    },
  };
}
