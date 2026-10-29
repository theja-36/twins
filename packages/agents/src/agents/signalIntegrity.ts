import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef, fin, isRealDate, nonEmpty } from "./common";
import type { AgentRulesConfig } from "./rules";

/**
 * Signal Integrity Agent (`signal-integrity-v1`, Stage 5 / Task 2). Detects structural and logical problems in the parsed signal BEFORE deeper research. It works only on parsed
 * fields (never message text), never guesses a missing value, and never approves anything: BLOCKING halts the existing worker flow through the engine's halt rule.
 *
 *   mandatory (BLOCKING): market, instrument type, underlying, side, entry price, stop-loss (present, > 0, VALID in the stop-loss evidence), expiry for derivatives, strike and CE/PE for options
 *   coherence: stop-loss on the wrong side of the entry or a target on the wrong side -> BLOCKING; targets out of order -> configured (default ADVERSE)
 *   revisions: a superseded message -> BLOCKING; an ambiguous revision group -> configured (default BLOCKING); changed levels in an earlier version -> CAUTION
 *   staleness / time: unknown -> CAUTION; > caution -> CAUTION; > adverse -> ADVERSE; > block -> BLOCKING; a time in the future -> BLOCKING
 *   source intelligence: not recorded / unavailable -> CAUTION; inconsistent with its own tiers, or dated after the signal -> ADVERSE
 *   quality warnings (CAUTION): no targets, very tight / very wide stop, reward below 1R
 *   verdict = the worst level; clean = SUPPORTIVE.
 */
export const SIGNAL_INTEGRITY_AGENT_ID = "signal-integrity-v1";
const TYPES = ["equity", "future", "option"];

export function signalIntegrityContract(): AgentContract {
  return {
    agentId: SIGNAL_INTEGRITY_AGENT_ID, agentName: "Signal Integrity Agent", version: "1.0.0",
    requiredInputs: ["risk_decision", "stop_loss_validation", "signal_features", "signal_context"], optionalInputs: ["source_intelligence"],
    outputSchema: { fields: { ...COMMON_OUTPUT_FIELDS, staleSeconds: { type: "number" } } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 60, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}

type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; side?: string | null; entryPrice?: number | null; stopLoss?: number | null; targets?: number[]; expiry?: string | null; strike?: number | null; optionType?: string | null };
type Sc = { signalTimestamp?: string | null; messageLinked?: boolean; revision?: { known?: boolean; otherVersions?: number; state?: string; anyAmbiguous?: boolean; levelsChanged?: boolean | null } };
type Si = { status?: string; reasonCode?: string; trust?: { tier?: string; scorecardRunId?: string | null }; confidence?: { tier?: string }; asOf?: string } | null;

export function signalIntegrityAgent(rules: AgentRulesConfig): AgentDefinition {
  const r = rules.signal;
  return {
    contract: signalIntegrityContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const slv = ctx.inputs["stop_loss_validation"] as { id?: string; result?: string } | null;
      const sf = ctx.inputs["signal_features"] as { market?: string; side?: string; instrumentType?: string; stopDistance?: string; rewardRisk?: string } | null;
      const sc = ctx.inputs["signal_context"] as Sc | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as Si;
      if (!rd || !slv || !sf || !sc) throw new AgentUnavailableError("MISSING_CONTEXT", "required context is missing");
      const c = new Collector();
      const type = (rd.instrumentType ?? "").toLowerCase();
      const side = (rd.side ?? "").toUpperCase();
      const entry = rd.entryPrice, stop = rd.stopLoss;
      const targets = Array.isArray(rd.targets) ? rd.targets : [];

      // ── mandatory fields (never guessed) ──
      c.check(); if (!nonEmpty(rd.market)) c.add("BLOCKING", "MARKET_MISSING", "The market is not stated."); else if (!/^[A-Za-z0-9]{2,20}$/.test(rd.market.trim())) c.add("BLOCKING", "MARKET_MALFORMED", "The market code is malformed.");
      c.check(); if (!nonEmpty(rd.instrumentType)) c.add("BLOCKING", "INSTRUMENT_TYPE_MISSING", "The instrument type is not stated."); else if (!TYPES.includes(type)) c.add("BLOCKING", "INSTRUMENT_TYPE_UNSUPPORTED", "The instrument type is not equity, future or option.");
      c.check(); if (!nonEmpty(rd.symbol) || rd.symbol.trim().toUpperCase() === "UNKNOWN") c.add("BLOCKING", "UNDERLYING_MISSING", "The underlying instrument is not identified.");
      c.check(); if (!nonEmpty(rd.side)) c.add("BLOCKING", "SIDE_MISSING", "The side (BUY / SELL) is not stated."); else if (side !== "BUY" && side !== "SELL") c.add("BLOCKING", "SIDE_INVALID", "The side is neither BUY nor SELL.");
      c.check(); if (entry === null || entry === undefined) c.add("BLOCKING", "ENTRY_MISSING", "There is no entry price."); else if (!fin(entry) || entry <= 0) c.add("BLOCKING", "ENTRY_INVALID", "The entry price is not a positive number.");
      c.check(); if (stop === null || stop === undefined) c.add("BLOCKING", "STOP_LOSS_MISSING", "There is no stop-loss."); else if (!fin(stop) || stop <= 0) c.add("BLOCKING", "STOP_LOSS_INVALID", "The stop-loss is not a positive number.");
      c.check(); if (slv.result !== "VALID") c.add("BLOCKING", "STOP_LOSS_VALIDATION_FAILED", "The stop-loss validation evidence is not VALID.", { result: String(slv.result ?? "none").slice(0, 30) });
      if (type === "future" || type === "option") {
        c.check(); if (!nonEmpty(rd.expiry)) c.add("BLOCKING", "EXPIRY_MISSING", "A derivative needs a complete expiry date."); else if (!isRealDate(rd.expiry)) c.add("BLOCKING", "EXPIRY_FORMAT_INVALID", "The expiry is not a real YYYY-MM-DD date.");
      }
      if (type === "option") {
        c.check(); if (!fin(rd.strike) || rd.strike <= 0) c.add("BLOCKING", "STRIKE_INVALID", "The option strike is missing or not a positive number.");
        c.check(); if (rd.optionType !== "CE" && rd.optionType !== "PE") c.add("BLOCKING", "OPTION_TYPE_INVALID", "The option type is neither CE nor PE.");
      } else if (TYPES.includes(type)) {
        c.check(); if (rd.strike != null || rd.optionType != null) c.add("ADVERSE", "OPTION_FIELDS_ON_NON_OPTION", "A strike or option type is present on an instrument that is not an option.");
      }

      // ── level coherence (only when the inputs are usable) ──
      const usable = (side === "BUY" || side === "SELL") && fin(entry) && entry > 0;
      if (usable && fin(stop) && stop > 0) {
        c.check();
        if (side === "BUY" ? !(stop < (entry as number)) : !(stop > (entry as number))) c.add("BLOCKING", "STOP_LOSS_WRONG_SIDE", `For a ${side} the stop-loss must be ${side === "BUY" ? "below" : "above"} the entry.`);
      }
      c.check(); if (targets.length === 0) c.add("CAUTION", "TARGETS_MISSING", "No target is stated.");
      if (usable && targets.length > 0) {
        const e = entry as number;
        c.check();
        const wrong = targets.filter((t) => !fin(t) || (side === "BUY" ? !(t > e) : !(t < e)));
        if (wrong.length > 0) c.add("BLOCKING", "TARGET_WRONG_SIDE", `${wrong.length} target(s) are not on the profit side of the entry.`, { count: wrong.length });
        else if (targets.length > 1) {
          c.check();
          const ordered = targets.every((t, i) => i === 0 || (side === "BUY" ? (r.targetOrdering === "strict" ? t > (targets[i - 1] as number) : t >= (targets[i - 1] as number)) : (r.targetOrdering === "strict" ? t < (targets[i - 1] as number) : t <= (targets[i - 1] as number))));
          if (!ordered) c.add(r.targetOrderViolation, "TARGETS_OUT_OF_ORDER", `Targets do not move away from the entry in order (${r.targetOrdering} ordering).`);
        }
      }

      // ── internal consistency of the derived features ──
      c.check();
      if ((sf.market ?? "").toUpperCase() !== (rd.market ?? "").trim().toUpperCase() || (sf.side ?? "").toUpperCase() !== side) c.add("ADVERSE", "FEATURES_INCONSISTENT", "The derived signal features disagree with the risk-decision fields.");

      // ── time and staleness ──
      let staleSeconds: number | undefined;
      c.check();
      if (!sc.signalTimestamp) c.add("CAUTION", "SIGNAL_TIME_UNKNOWN", "The time the signal was sent is unknown, so its age cannot be checked.");
      else {
        const ageSec = Math.round((ctx.now.getTime() - Date.parse(sc.signalTimestamp)) / 1000);
        staleSeconds = ageSec;
        if (Number.isNaN(ageSec)) c.add("CAUTION", "SIGNAL_TIME_UNKNOWN", "The signal time is malformed.");
        else if (ageSec < -r.futureToleranceMinutes * 60) c.add("BLOCKING", "SIGNAL_TIME_IN_FUTURE", "The signal time is in the future: an impossible timestamp.", { ageSeconds: ageSec });
        else if (ageSec > r.staleBlockMinutes * 60) c.add("BLOCKING", "SIGNAL_STALE", `The signal is older than ${r.staleBlockMinutes} minutes.`, { ageSeconds: ageSec });
        else if (ageSec > r.staleAdverseMinutes * 60) c.add("ADVERSE", "SIGNAL_STALE", `The signal is older than ${r.staleAdverseMinutes} minutes.`, { ageSeconds: ageSec });
        else if (ageSec > r.staleCautionMinutes * 60) c.add("CAUTION", "SIGNAL_AGING", `The signal is older than ${r.staleCautionMinutes} minutes.`, { ageSeconds: ageSec });
      }

      // ── revisions ──
      c.check();
      const rev = sc.revision ?? {};
      if (!sc.messageLinked || !rev.known) c.add("CAUTION", "REVISION_STATE_UNKNOWN", "The signal is not linked to a stored message, so its revision state cannot be checked.");
      else {
        if (rev.state === "superseded") c.add("BLOCKING", "REVISION_SUPERSEDED", "A newer revision of this message exists; this version is not actionable.");
        else if (rev.state === "ambiguous") c.add(rules.signal.ambiguousRevision, "REVISION_AMBIGUOUS", "The revisions of this message cannot be ordered reliably.");
        else if (rev.anyAmbiguous) c.add(rules.signal.ambiguousRevision, "REVISION_GROUP_AMBIGUOUS", "Another revision of this message is ambiguous.");
        if (rev.levelsChanged === true && rev.state === "current") c.add("CAUTION", "EDITED_LEVELS_CHANGED", "An earlier version of this message had different levels.");
        else if (rev.levelsChanged === true) c.add("ADVERSE", "CONFLICTING_REVISIONS", "Other revisions of this message carry different levels.");
      }

      // ── source intelligence availability and consistency ──
      c.check();
      if (si === null) c.add("CAUTION", "SOURCE_INTELLIGENCE_NOT_RECORDED", "No source intelligence is recorded on the decision.");
      else {
        if (si.status !== "VALID") c.add("CAUTION", "SOURCE_INTELLIGENCE_UNAVAILABLE", "Source intelligence is not valid for this signal.", { reasonCode: String(si.reasonCode ?? "unknown").slice(0, 60) });
        else if (!["A", "B", "C"].includes(String(si.trust?.tier)) || !["HIGH", "MEDIUM", "LOW"].includes(String(si.confidence?.tier))) c.add("ADVERSE", "SOURCE_INTELLIGENCE_INCONSISTENT", "Source intelligence claims to be valid but its trust or confidence tier is unknown.");
        if (si.asOf && sc.signalTimestamp && Date.parse(si.asOf) > Date.parse(sc.signalTimestamp)) c.add("ADVERSE", "SOURCE_INTELLIGENCE_AFTER_SIGNAL", "Source intelligence is dated after the signal (point-in-time violation).");
      }

      // ── quality warnings ──
      c.check();
      if (sf.stopDistance === "LT_1PCT") c.add("CAUTION", "STOP_VERY_TIGHT", "The stop-loss is under 1% from the entry.");
      if (sf.stopDistance === "GTE_10PCT") c.add("CAUTION", "STOP_VERY_WIDE", "The stop-loss is 10% or more from the entry.");
      if (sf.rewardRisk === "LT_1") c.add("CAUTION", "REWARD_BELOW_RISK", "The first target offers less than 1R.");

      const evidence = [...evidenceRef("risk_decision", rd.id), ...evidenceRef("stop_loss_validation", slv.id), ...evidenceRef("scorecard_run", si?.trust?.scorecardRunId)];
      return c.output(evidence, staleSeconds === undefined ? {} : { staleSeconds });
    },
  };
}
