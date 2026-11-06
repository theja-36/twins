import { step } from "./manager";
import type { PaperConfig } from "./config";
import { rMultiple } from "./pnl";
import type { PaperTrade, Tick } from "./types";

/**
 * Adaptive trade management (P0 #1), SHADOW / REPLAY ONLY. A pure function that PROPOSES a safer stop or an earlier partial exit for an open trade, never executes anything and is not wired to the paper
 * cycle. It is strictly reduce-only: a proposed stop is always tighter than the current stop and always on the safe side of the current price; a proposed exit only reduces the position; nothing ever
 * widens a stop, increases a quantity or adds risk. Missing context never produces a proposal (an unknown input is reported, not assumed calm). `replayManagement` compares the fixed rules with the
 * same rules plus the proposals, over a recorded tick series, so the effect can be measured before anything is ever applied.
 */
export const ADAPTIVE_MANAGEMENT_VERSION = "adaptive-management-v1";

export interface ManagementContext {
  /** Current volatility divided by its baseline (1 = normal), or null when unknown. */
  volatilityRatio: number | null;
  /** Minutes until the next HIGH or CRITICAL scheduled event, or null when unknown/none. */
  minutesToHighImpactEvent: number | null;
  /** Minutes until the paper square-off time, or null when none is configured. */
  minutesToSquareOff: number | null;
}
export interface ManagementPolicy {
  /** Lock this many R beyond the entry when volatility spikes and the trade is at least `minProfitR` in profit. */
  volatilityRatioTrigger: number; volatilityLockR: number;
  /** Move the stop to breakeven when a high-impact event is this close and the trade is in profit. */
  eventWindowMinutes: number;
  /** Move the stop to breakeven when square-off is this close and the trade is in profit. */
  squareOffWindowMinutes: number;
  /** If the best excursion reached `givebackMfeR` and the open profit has fallen by `givebackFraction` of it, lock `givebackLockR`. */
  givebackMfeR: number; givebackFraction: number; givebackLockR: number;
  minProfitR: number;
  /** A proposed stop must stay at least this percent of price away from the current price (so it cannot be an immediate stop-out by construction). */
  minBufferPct: number;
  /** Fraction of the REMAINING quantity proposed for exit when an event is close and the trade is not in profit; 0 disables partial-exit proposals. */
  eventPartialExitFraction: number;
}
export const DEFAULT_MANAGEMENT_POLICY: ManagementPolicy = {
  volatilityRatioTrigger: 2, volatilityLockR: 0.5, eventWindowMinutes: 60, squareOffWindowMinutes: 30,
  givebackMfeR: 1.5, givebackFraction: 0.4, givebackLockR: 0.5, minProfitR: 0.5, minBufferPct: 0.1, eventPartialExitFraction: 0.5,
};

export type ProposalAction = "HOLD" | "TIGHTEN_STOP" | "PARTIAL_EXIT";
export interface ManagementProposal {
  version: typeof ADAPTIVE_MANAGEMENT_VERSION;
  action: ProposalAction;
  /** Present only for TIGHTEN_STOP: strictly tighter than the current stop. */
  newStop?: number;
  /** Present only for PARTIAL_EXIT: fraction of the remaining quantity, in (0, 1]. */
  exitFraction?: number;
  reasons: string[];
  unknownInputs: string[];
  /** Always false: a proposal is evidence, never an order. */
  executed: false;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const hold = (reasons: string[], unknownInputs: string[]): ManagementProposal => ({ version: ADAPTIVE_MANAGEMENT_VERSION, action: "HOLD", reasons, unknownInputs, executed: false });

export function proposeManagement(trade: PaperTrade, price: number, ctx: ManagementContext, policy: ManagementPolicy = DEFAULT_MANAGEMENT_POLICY): ManagementProposal {
  const unknown: string[] = [];
  if (ctx.volatilityRatio === null) unknown.push("volatilityRatio");
  if (ctx.minutesToHighImpactEvent === null) unknown.push("minutesToHighImpactEvent");
  if (ctx.minutesToSquareOff === null) unknown.push("minutesToSquareOff");
  if (trade.state !== "OPEN" || trade.fillPrice === null || !Number.isFinite(price) || price <= 0) return hold(["NOT_AN_OPEN_TRADE_OR_NO_PRICE"], unknown);
  const s = trade.side === "BUY" ? 1 : -1, fill = trade.fillPrice, risk = Math.abs(fill - trade.initialStop);
  if (risk === 0) return hold(["NO_INITIAL_RISK"], unknown);
  const openR = (s * (price - fill)) / risk, mfeR = trade.extreme === null ? 0 : (s * (trade.extreme - fill)) / risk;

  // Candidate stops, each with the reason that produced it. Only the SAFEST valid one is proposed.
  const cands: Array<{ stop: number; reason: string }> = [];
  const lock = (r: number): number => fill + s * r * risk;
  if (ctx.volatilityRatio !== null && ctx.volatilityRatio >= policy.volatilityRatioTrigger && openR >= policy.minProfitR) cands.push({ stop: lock(policy.volatilityLockR), reason: "VOLATILITY_SPIKE_LOCK_PROFIT" });
  if (ctx.minutesToHighImpactEvent !== null && ctx.minutesToHighImpactEvent >= 0 && ctx.minutesToHighImpactEvent <= policy.eventWindowMinutes && openR >= policy.minProfitR) cands.push({ stop: fill, reason: "EVENT_NEAR_BREAKEVEN" });
  if (ctx.minutesToSquareOff !== null && ctx.minutesToSquareOff >= 0 && ctx.minutesToSquareOff <= policy.squareOffWindowMinutes && openR >= policy.minProfitR) cands.push({ stop: fill, reason: "SQUARE_OFF_NEAR_BREAKEVEN" });
  if (mfeR >= policy.givebackMfeR && openR <= mfeR * (1 - policy.givebackFraction)) cands.push({ stop: lock(policy.givebackLockR), reason: "PROFIT_GIVEBACK_LOCK" });

  const buffer = (price * policy.minBufferPct) / 100;
  const valid = cands.filter((c) => s * (c.stop - trade.stop) > 0 && s * (price - c.stop) >= buffer); // tighter than now, and safely behind the price
  const skipped = cands.filter((c) => !valid.includes(c)).map((c) => `${c.reason}_NOT_APPLICABLE`);
  if (valid.length) {
    const best = valid.reduce((a, b) => (s * (b.stop - a.stop) > 0 ? b : a));
    return { version: ADAPTIVE_MANAGEMENT_VERSION, action: "TIGHTEN_STOP", newStop: r2(best.stop), reasons: [best.reason, ...valid.filter((c) => c !== best).map((c) => c.reason)], unknownInputs: unknown, executed: false };
  }
  // An event is close and the trade is not in profit: the only protective move left is a smaller position.
  if (policy.eventPartialExitFraction > 0 && ctx.minutesToHighImpactEvent !== null && ctx.minutesToHighImpactEvent >= 0 && ctx.minutesToHighImpactEvent <= policy.eventWindowMinutes && openR < policy.minProfitR && trade.remainingQuantity > 1) {
    return { version: ADAPTIVE_MANAGEMENT_VERSION, action: "PARTIAL_EXIT", exitFraction: Math.min(1, policy.eventPartialExitFraction), reasons: ["EVENT_NEAR_REDUCE_EXPOSURE"], unknownInputs: unknown, executed: false };
  }
  return hold(skipped, unknown);
}

/** True when applying the proposal could not add risk: a stop strictly tighter than `trade.stop` and behind `price`, or an exit fraction in (0,1], or a hold. */
export function isReduceOnly(trade: PaperTrade, price: number, p: ManagementProposal): boolean {
  const s = trade.side === "BUY" ? 1 : -1;
  if (p.action === "HOLD") return p.newStop === undefined && p.exitFraction === undefined;
  if (p.action === "TIGHTEN_STOP") return p.newStop !== undefined && p.exitFraction === undefined && s * (p.newStop - trade.stop) > 0 && s * (price - p.newStop) > 0;
  return p.exitFraction !== undefined && p.newStop === undefined && p.exitFraction > 0 && p.exitFraction <= 1;
}

export interface ReplayTick extends Tick { context: ManagementContext }
export interface ReplayResult {
  fixed: { finalR: number | null; closeReason: string | null; realizedPnl: number };
  adaptive: { finalR: number | null; closeReason: string | null; realizedPnl: number };
  /** adaptive minus fixed, in R; positive means the proposals would have helped on this series. */
  deltaR: number | null;
  proposals: Array<{ at: string; action: ProposalAction; newStop?: number; exitFraction?: number; reasons: string[] }>;
  /** Number of proposals that were not reduce-only (always 0; counted so a regression is visible). */
  violations: number;
}

/**
 * Replays recorded ticks twice: with the fixed paper rules, and with the same rules after applying each TIGHTEN_STOP proposal to the simulated trade (stops only). Partial-exit proposals are recorded but not
 * simulated in this slice. Pure: no clock, no I/O.
 */
export function replayManagement(start: PaperTrade, ticks: readonly ReplayTick[], cfg: PaperConfig, policy: ManagementPolicy = DEFAULT_MANAGEMENT_POLICY): ReplayResult {
  let fixed = start, adaptive = start, violations = 0;
  const proposals: ReplayResult["proposals"] = [];
  for (const tick of ticks) {
    fixed = step(fixed, tick, cfg).trade;
    if (adaptive.state === "OPEN") {
      const prop = proposeManagement(adaptive, tick.price, tick.context, policy);
      if (prop.action !== "HOLD") {
        if (!isReduceOnly(adaptive, tick.price, prop)) violations += 1;
        else {
          proposals.push({ at: tick.at, action: prop.action, ...(prop.newStop === undefined ? {} : { newStop: prop.newStop }), ...(prop.exitFraction === undefined ? {} : { exitFraction: prop.exitFraction }), reasons: prop.reasons });
          if (prop.action === "TIGHTEN_STOP" && prop.newStop !== undefined) adaptive = { ...adaptive, stop: prop.newStop };
        }
      }
    }
    adaptive = step(adaptive, tick, cfg).trade;
  }
  const summ = (t: PaperTrade): ReplayResult["fixed"] => ({ finalR: rMultiple(t, ticks.length ? ticks[ticks.length - 1]!.price : null), closeReason: t.closeReason, realizedPnl: Math.round(t.realizedPnl * 100) / 100 });
  const f = summ(fixed), a = summ(adaptive);
  return { fixed: f, adaptive: a, deltaR: f.finalR === null || a.finalR === null ? null : Math.round((a.finalR - f.finalR) * 100) / 100, proposals, violations };
}
