import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, fin } from "./common";
import { validateCalendarEvent } from "./calendarProviders";
import type { MacroContextProvider, MacroSnapshot } from "./macroProvider";
import type { AgentRulesConfig } from "./rules";

/**
 * Macro / Global Market Agent (`macro-global-v1`, Stage 5 / Task 3). Compares broad market conditions with the direction of the signal using an INJECTED context provider (no external API).
 * It describes what the data shows - alignment, volatility, gap, breadth, global moves, scheduled releases - and does not infer causation. Deterministic thresholds only (no model), parsed
 * fields only (never message text), and it never approves anything.
 *
 *   direction : BUY equity / future / CE or SELL PE = BULLISH exposure; SELL equity / future / CE or BUY PE = BEARISH (a derived label of the signal's own fields, not a forecast)
 *   UNAVAILABLE (never a pass): no provider, no context, no index level, too little history for the configured lookback, malformed data, a context older than the maximum age
 *   BLOCKING: an extreme one-day index move; the volatility index at the block level; a CRITICAL release inside its window (configurable BLOCKING | ADVERSE)
 *   ADVERSE : trend against the signal direction beyond the adverse threshold; elevated volatility index; a volatility spike; a large one-day move or gap; a global index moving against the
 *             direction beyond the adverse threshold; a HIGH release inside its window; breadth risk-off together with a volatility spike against a bullish signal
 *   CAUTION : milder versions of the above; stale (but usable) context; thin context (no optional sections); a large currency move; risk-off / risk-on contradicting the direction
 *   NEUTRAL : nothing adverse and the trend is not clearly aligned;  SUPPORTIVE: nothing adverse and the trend over the lookback is aligned with the direction.
 */
export const MACRO_GLOBAL_AGENT_ID = "macro-global-v1";
const MIN = 60_000;

export function macroGlobalContract(): AgentContract {
  return {
    agentId: MACRO_GLOBAL_AGENT_ID, agentName: "Macro / Global Market Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_features", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, direction: { type: "string" }, provider: { type: "string" }, indexSymbol: { type: "string" }, trendLookbackSessions: { type: "number" }, trendPct: { type: "number" }, changePct1d: { type: "number" },
      gapPct: { type: "number" }, volatilityLevel: { type: "number" }, contextAgeMinutes: { type: "number" }, optionalMissing: { type: "string[]" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; side?: string | null; optionType?: string | null };
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };
const malformed = (): never => unavailable("MACRO_DATA_MALFORMED", "the macro context provider returned malformed data");

/** +1 bullish exposure, -1 bearish, null when the side / option type does not determine it. */
export function signalDirection(type: string, side: string, optionType: string | null | undefined): 1 | -1 | null {
  const s = side.toUpperCase();
  if (s !== "BUY" && s !== "SELL") return null;
  const buy = s === "BUY" ? 1 : -1;
  if (type === "equity" || type === "future") return buy;
  if (type === "option") return optionType === "CE" ? buy : optionType === "PE" ? ((-buy) as 1 | -1) : null;
  return null;
}
/** Structural validation of whatever a provider returned (a provider is not trusted to be well-formed). */
function checkSnapshot(s: MacroSnapshot | null): MacroSnapshot {
  if (!s || typeof s !== "object" || typeof s.asOf !== "string" || Number.isNaN(Date.parse(s.asOf)) || !Array.isArray(s.global) || !Array.isArray(s.releases)) return malformed();
  const i = s.index;
  if (i !== null) {
    if (!i || !fin(i.level) || i.level <= 0 || !Array.isArray(i.recentCloses) || i.recentCloses.some((x) => !fin(x) || x <= 0)) malformed();
    for (const x of [i.previousClose, i.open]) if (x !== null && (!fin(x) || x <= 0)) malformed();
  }
  if (s.breadth !== null && (!s.breadth || !fin(s.breadth.advancers) || !fin(s.breadth.decliners) || s.breadth.advancers < 0 || s.breadth.decliners < 0)) malformed();
  if (s.volatilityIndex !== null && (!s.volatilityIndex || !fin(s.volatilityIndex.level) || s.volatilityIndex.level < 0 || (s.volatilityIndex.changePct1d !== null && !fin(s.volatilityIndex.changePct1d)))) malformed();
  if (s.currency !== null && (!s.currency || !fin(s.currency.changePct1d))) malformed();
  for (const g of s.global) if (!g || !fin(g.changePct1d) || (g.sessionStatus !== "open" && g.sessionStatus !== "closed")) malformed();
  return s;
}

export function macroGlobalAgent(rules: AgentRulesConfig, provider: MacroContextProvider | null): AgentDefinition {
  const m = rules.macro;
  return {
    contract: macroGlobalContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      if (!provider) throw new AgentUnavailableError("MACRO_PROVIDER_NOT_CONFIGURED", "no macro context provider is configured; market conditions cannot be assessed");
      const market = (rd.market ?? "").trim().toUpperCase(), underlying = (rd.symbol ?? "").trim().toUpperCase();
      if (!market || !underlying || underlying === "UNKNOWN") throw new AgentUnavailableError("MISSING_CONTEXT", "the market or underlying is missing");
      let raw: MacroSnapshot | null;
      try { raw = await provider.context({ market, underlying }); } catch { return unavailable("MACRO_PROVIDER_UNAVAILABLE", "the macro context provider is unavailable"); } // the provider's own message is never stored
      if (raw === null) return unavailable("MACRO_CONTEXT_NOT_AVAILABLE", "the macro context provider has no context for this market");
      const snap = checkSnapshot(raw);
      const now = ctx.now.getTime();
      const ageMin = (now - Date.parse(snap.asOf)) / MIN;
      if (ageMin < -5) return unavailable("MACRO_CONTEXT_FROM_FUTURE", "the macro context is dated in the future");
      if (ageMin > m.unavailableMinutes) return unavailable("MACRO_CONTEXT_TOO_OLD", "the macro context is too old to use");
      const idx = snap.index;
      if (idx === null) return unavailable("MACRO_INDEX_MISSING", "the macro context has no index level");
      if (idx.recentCloses.length < m.trendLookbackSessions) return unavailable("MACRO_TREND_HISTORY_INSUFFICIENT", "the macro context has too little history for the configured trend lookback");
      for (const e of snap.releases) if (validateCalendarEvent(e) === null) malformed();

      const c = new Collector();
      const type = (rd.instrumentType ?? "").toLowerCase();
      const dir = signalDirection(type, rd.side ?? "", rd.optionType);
      c.check();
      if (ageMin > m.staleCautionMinutes) c.add("CAUTION", "MACRO_CONTEXT_STALE", `The macro context is ${Math.round(ageMin)} minutes old.`, { ageMinutes: Math.round(ageMin) });

      // ── index move and gap (direction-agnostic: they describe how unsettled the market is) ──
      const prev = idx.previousClose ?? (idx.recentCloses[idx.recentCloses.length - 1] as number);
      const change1d = (idx.level / prev - 1) * 100;
      c.check();
      const absMove = Math.abs(change1d);
      if (absMove >= m.moveBlock) c.add("BLOCKING", "EXTREME_INDEX_MOVE", `The reference index moved ${r4(change1d)}% in one session.`, { changePct1d: r4(change1d) });
      else if (absMove >= m.moveAdverse) c.add("ADVERSE", "LARGE_INDEX_MOVE", `The reference index moved ${r4(change1d)}% in one session.`, { changePct1d: r4(change1d) });
      else if (absMove >= m.moveCaution) c.add("CAUTION", "NOTABLE_INDEX_MOVE", `The reference index moved ${r4(change1d)}% in one session.`, { changePct1d: r4(change1d) });
      let gapPct: number | undefined;
      c.check();
      if (idx.open !== null && idx.previousClose !== null) {
        gapPct = (idx.open / idx.previousClose - 1) * 100;
        const g = Math.abs(gapPct);
        if (g >= m.gapAdverse) c.add("ADVERSE", "GAP_RISK_HIGH", `The index opened ${r4(gapPct)}% from the previous close.`, { gapPct: r4(gapPct) });
        else if (g >= m.gapCaution) c.add("CAUTION", "GAP_RISK", `The index opened ${r4(gapPct)}% from the previous close.`, { gapPct: r4(gapPct) });
      } else c.add("INFO", "GAP_DATA_MISSING", "The opening gap cannot be computed (open or previous close missing).");

      // ── trend alignment ──
      const base = idx.recentCloses[idx.recentCloses.length - m.trendLookbackSessions] as number;
      const trendPct = (idx.level / base - 1) * 100;
      let supportive = false;
      c.check();
      if (dir === null) c.add("CAUTION", "DIRECTION_UNKNOWN", "The signal direction cannot be derived from its side and option type, so alignment is not assessed.");
      else {
        const aligned = dir * trendPct;
        if (aligned <= -m.trendAdversePct) c.add("ADVERSE", "TREND_CONFLICT_STRONG", `The index moved ${r4(trendPct)}% over ${m.trendLookbackSessions} session(s), against the signal direction.`, { trendPct: r4(trendPct), lookbackSessions: m.trendLookbackSessions });
        else if (aligned <= -m.trendCautionPct) c.add("CAUTION", "TREND_CONFLICT_MILD", `The index moved ${r4(trendPct)}% over ${m.trendLookbackSessions} session(s), against the signal direction.`, { trendPct: r4(trendPct), lookbackSessions: m.trendLookbackSessions });
        else if (aligned >= m.trendSupportivePct) { supportive = true; c.add("INFO", "TREND_ALIGNED", `The index moved ${r4(trendPct)}% over ${m.trendLookbackSessions} session(s), in the signal direction.`, { trendPct: r4(trendPct) }); }
        else c.add("INFO", "TREND_FLAT", `The index moved ${r4(trendPct)}% over ${m.trendLookbackSessions} session(s), no clear alignment.`, { trendPct: r4(trendPct) });
      }

      // ── volatility ──
      const missing: string[] = [];
      let volLevel: number | undefined, volSpike = false;
      c.check();
      const vi = snap.volatilityIndex;
      if (vi === null) missing.push("volatility_index");
      else {
        volLevel = vi.level;
        if (vi.level >= m.volBlock) c.add("BLOCKING", "VOLATILITY_EXTREME", `The volatility index (${vi.name}) is at ${r4(vi.level)}.`, { level: r4(vi.level) });
        else if (vi.level >= m.volAdverse) c.add("ADVERSE", "VOLATILITY_HIGH", `The volatility index (${vi.name}) is at ${r4(vi.level)}.`, { level: r4(vi.level) });
        else if (vi.level >= m.volCaution) c.add("CAUTION", "VOLATILITY_ELEVATED", `The volatility index (${vi.name}) is at ${r4(vi.level)}.`, { level: r4(vi.level) });
        if (vi.changePct1d !== null && vi.changePct1d >= m.volSpikePct) { volSpike = true; c.add("ADVERSE", "VOLATILITY_SPIKE", `The volatility index rose ${r4(vi.changePct1d)}% in one session.`, { changePct1d: r4(vi.changePct1d) }); }
      }

      // ── risk-off / risk-on ──
      const b = snap.breadth;
      c.check();
      if (b === null || b.advancers + b.decliners === 0) missing.push("breadth");
      else {
        const share = b.advancers / (b.advancers + b.decliners);
        const breadthOff = share <= m.breadthRiskOff, riskOff = breadthOff || (volSpike && change1d < 0), riskOn = !riskOff && share >= m.breadthRiskOn;
        if (dir !== null) {
          if (dir > 0 && riskOff) c.add(breadthOff && volSpike ? "ADVERSE" : "CAUTION", "RISK_OFF_CONTEXT", `Market breadth is weak (${r4(share)} advancing) against a bullish signal.`, { advanceShare: r4(share) });
          else if (dir < 0 && riskOn) c.add("CAUTION", "RISK_ON_CONTEXT", `Market breadth is strong (${r4(share)} advancing) against a bearish signal.`, { advanceShare: r4(share) });
          else c.add("INFO", "BREADTH_NO_CONFLICT", `Market breadth shows ${r4(share)} advancing.`, { advanceShare: r4(share) });
        }
      }

      // ── global markets and currency ──
      c.check();
      if (snap.global.length === 0) missing.push("global_markets");
      else if (dir !== null) {
        for (const g of snap.global) {
          const aligned = dir * g.changePct1d;
          const detail = { name: g.name.slice(0, 40), changePct1d: r4(g.changePct1d), sessionStatus: g.sessionStatus };
          if (aligned <= -m.globalAdverse) c.add("ADVERSE", "GLOBAL_MARKET_CONFLICT", `${g.name} moved ${r4(g.changePct1d)}%, against the signal direction.`, detail);
          else if (aligned <= -m.globalCaution) c.add("CAUTION", "GLOBAL_MARKET_CONFLICT_MILD", `${g.name} moved ${r4(g.changePct1d)}%, against the signal direction.`, detail);
        }
      }
      c.check();
      if (snap.currency === null) missing.push("currency");
      else if (Math.abs(snap.currency.changePct1d) >= m.currencyCaution) c.add("CAUTION", "CURRENCY_MOVE", `${snap.currency.pair} moved ${r4(snap.currency.changePct1d)}% in one session.`, { changePct1d: r4(snap.currency.changePct1d) });

      // ── scheduled macro releases ──
      c.check();
      for (const raw of snap.releases) {
        const e = validateCalendarEvent(raw) as NonNullable<ReturnType<typeof validateCalendarEvent>>;
        if (!e.markets.includes(market) && !e.markets.includes("ALL")) continue;
        const dt = (Date.parse(e.at) - now) / MIN;
        if (dt < -m.releaseAfter || dt > m.releaseBefore) continue;
        const detail = { eventId: e.id, impact: e.impact, minutesAhead: Math.round(dt) };
        const name = e.name.replace(/[^A-Za-z0-9 .,&()/'-]/g, "_").slice(0, 60);
        if (e.impact === "CRITICAL") c.add(m.criticalRelease, "MACRO_RELEASE_IMMINENT", `A major macro release (${name}) is inside its window.`, detail);
        else if (e.impact === "HIGH") c.add("ADVERSE", "MACRO_RELEASE_NEAR", `A high-impact macro release (${name}) is inside its window.`, detail);
        else if (e.impact === "MEDIUM") c.add("CAUTION", "MACRO_RELEASE_NOTED", `A medium-impact macro release (${name}) is inside its window.`, detail);
      }

      // ── completeness ──
      c.check();
      if (missing.length > 0) c.add(missing.length >= 4 ? "CAUTION" : "INFO", missing.length >= 4 ? "CONTEXT_THIN" : "OPTIONAL_CONTEXT_MISSING", `Optional context not supplied: ${missing.join(", ")}.`, { missing: missing.join(",") });

      const ref = `${provider.name}@${snap.asOf}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150);
      const out = c.output([...evidenceRef("risk_decision", rd.id), ...evidenceRef("macro_context", ref)], {
        direction: dir === null ? "UNKNOWN" : dir > 0 ? "BULLISH" : "BEARISH", provider: provider.name.slice(0, 80), indexSymbol: idx.symbol.slice(0, 40), trendLookbackSessions: m.trendLookbackSessions, trendPct: r4(trendPct),
        changePct1d: r4(change1d), contextAgeMinutes: Math.max(0, Math.round(ageMin)), optionalMissing: missing, sourceIntelligenceStatus: typeof si?.status === "string" ? si.status.slice(0, 30) : "none",
        ...(gapPct === undefined ? {} : { gapPct: r4(gapPct) }), ...(volLevel === undefined ? {} : { volatilityLevel: r4(volLevel) }),
      });
      if (out.verdict === "SUPPORTIVE" && !supportive) return { ...out, verdict: "NEUTRAL", confidence: 70 };
      return out;
    },
  };
}
