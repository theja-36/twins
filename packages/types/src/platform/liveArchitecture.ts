import { checkExecutionGate, type GateInput } from "./execution";

/**
 * Assisted Live and Controlled Auto ARCHITECTURE (Stage 07, M13-18..29). Pure, deterministic validation only: there is no broker adapter, no network and no order path here, and nothing in the master build
 * calls these functions with the operator switch on. They define and test what a live order would have to satisfy, so that enabling a mode later cannot skip a rule. Every function takes `liveExecutionEnabled`
 * explicitly and callers in the master build always pass false, which refuses everything. Money is compared as exact decimal strings (integer arithmetic over 8 decimal places), never as floats.
 */
export const LIVE_ARCHITECTURE_VERSION = "live-architecture-v1";

const SCALE = 100_000_000n;
/** Parses a non-negative decimal string into a scaled integer; returns null for anything else (never guesses). */
export function toScaled(v: string | null | undefined): bigint | null {
  if (typeof v !== "string" || !/^\d+(\.\d{1,8})?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  return BigInt(w as string) * SCALE + BigInt(f.padEnd(8, "0"));
}

export interface LiveOrderProposal { userId: string; accountId: string; decisionId: string; instrument: string; exchange: string; side: "BUY" | "SELL"; quantity: string; orderType: "MARKET" | "LIMIT"; limitPrice: string | null; proposedAt: Date }
/** The exact order the user is shown. Any change to any field changes the digest, which invalidates a confirmation. */
export const proposalDigest = (p: LiveOrderProposal): string => JSON.stringify([p.userId, p.accountId, p.decisionId, p.instrument, p.exchange, p.side, p.quantity, p.orderType, p.limitPrice]);
export interface OrderConfirmation { id: string; userId: string; digest: string; confirmedAt: Date; expiresAt: Date; consumedAt: Date | null; revokedAt: Date | null }
export interface RiskRecheck { passed: boolean; at: Date }

export interface AssistedLiveInput { gate: Omit<GateInput, "mode" | "orderConfirmationId" | "autoPolicyId" | "riskRecheckPassed">; proposal: LiveOrderProposal; confirmation: OrderConfirmation | null; recheck: RiskRecheck | null; now: Date; maxRecheckAgeSeconds: number }
export type LiveCheck = { allowed: true; reasons: [] } | { allowed: false; reasons: string[] };
const verdict = (why: string[]): LiveCheck => (why.length === 0 ? { allowed: true, reasons: [] } : { allowed: false, reasons: [...new Set(why)] });

/** Assisted Live: the user reviewed THIS order, explicitly confirmed it once, risk was rechecked just now, and every gate is open. Otherwise refused with every reason. */
export function checkAssistedLive(i: AssistedLiveInput): LiveCheck {
  const why: string[] = [], c = i.confirmation, n = i.now.getTime();
  if (!c) why.push("no_explicit_order_confirmation");
  else {
    if (c.userId !== i.proposal.userId) why.push("confirmation_not_by_owner");
    if (c.digest !== proposalDigest(i.proposal)) why.push("confirmation_does_not_match_order");
    if (c.confirmedAt.getTime() < i.proposal.proposedAt.getTime()) why.push("confirmation_predates_proposal");
    if (c.expiresAt.getTime() <= n) why.push("confirmation_expired");
    if (c.consumedAt) why.push("confirmation_already_used");
    if (c.revokedAt && c.revokedAt.getTime() <= n) why.push("confirmation_revoked");
  }
  const fresh = !!i.recheck && i.recheck.at.getTime() <= n && (n - i.recheck.at.getTime()) / 1000 <= i.maxRecheckAgeSeconds;
  if (!i.recheck || !fresh) why.push("risk_recheck_missing_or_stale");
  const g = checkExecutionGate({ ...i.gate, mode: "ASSISTED_LIVE", orderConfirmationId: c ? c.id : null, autoPolicyId: null, riskRecheckPassed: !!i.recheck && fresh && i.recheck.passed });
  if (!g.allowed) why.push(...g.reasons);
  return verdict(why);
}

export interface AutoPolicy { id: string; userId: string; accountId: string; authorisedBy: string; authorisedAt: Date; expiresAt: Date; revokedAt: Date | null; strategies: string[]; maxOrderQuantity: string; maxOrderNotional: string; maxOpenNotional: string; maxDailyLoss: string; maxOpenPositions: number; maxOrdersPerDay: number }
export interface AutoState { openNotional: string; openPositions: number; realisedLossToday: string; ordersToday: number; emergencyStop: boolean }
export interface AutoOrder { userId: string; accountId: string; strategy: string; quantity: string; notional: string }

/** A policy is valid only if every limit is present, positive and exact, it names the user's strategies, and its authorisation has not expired or been revoked. */
export function validateAutoPolicy(p: AutoPolicy, now: Date): string[] {
  const why: string[] = [];
  if (!p.authorisedBy || p.authorisedBy !== p.userId) why.push("policy_not_authorised_by_owner");
  if (p.strategies.length === 0) why.push("policy_names_no_strategy");
  for (const [k, v] of [["maxOrderQuantity", p.maxOrderQuantity], ["maxOrderNotional", p.maxOrderNotional], ["maxOpenNotional", p.maxOpenNotional], ["maxDailyLoss", p.maxDailyLoss]] as const) { const s = toScaled(v); if (s === null || s <= 0n) why.push(`policy_${k}_invalid`); }
  if (!Number.isInteger(p.maxOpenPositions) || p.maxOpenPositions < 1) why.push("policy_maxOpenPositions_invalid");
  if (!Number.isInteger(p.maxOrdersPerDay) || p.maxOrdersPerDay < 1) why.push("policy_maxOrdersPerDay_invalid");
  if (p.expiresAt.getTime() <= now.getTime()) why.push("policy_expired");
  if (p.revokedAt && p.revokedAt.getTime() <= now.getTime()) why.push("policy_revoked");
  return why;
}

/** Controlled Auto: an order is allowed only inside a valid, unrevoked policy owned by the same user and account, with the emergency stop off and every limit respected. Fail-safe: unparseable amounts refuse. */
export function checkControlledAuto(i: { gate: Omit<GateInput, "mode" | "orderConfirmationId" | "autoPolicyId">; policy: AutoPolicy | null; order: AutoOrder; state: AutoState; now: Date }): LiveCheck {
  const why: string[] = [], p = i.policy;
  if (i.state.emergencyStop) why.push("emergency_stop_active");
  if (!p) why.push("no_authorised_auto_policy");
  else {
    why.push(...validateAutoPolicy(p, i.now));
    if (p.userId !== i.order.userId || p.accountId !== i.order.accountId) why.push("policy_belongs_to_another_account");
    if (!p.strategies.includes(i.order.strategy)) why.push("strategy_not_authorised");
    const q = toScaled(i.order.quantity), nt = toScaled(i.order.notional), open = toScaled(i.state.openNotional), loss = toScaled(i.state.realisedLossToday);
    const mq = toScaled(p.maxOrderQuantity), mn = toScaled(p.maxOrderNotional), mo = toScaled(p.maxOpenNotional), ml = toScaled(p.maxDailyLoss);
    if (q === null || nt === null || open === null || loss === null || mq === null || mn === null || mo === null || ml === null) why.push("amount_unparseable");
    else {
      if (q > mq) why.push("order_quantity_above_limit");
      if (nt > mn) why.push("order_notional_above_limit");
      if (open + nt > mo) why.push("open_notional_would_exceed_limit");
      if (loss >= ml) why.push("daily_loss_limit_reached");
    }
    if (i.state.openPositions >= p.maxOpenPositions) why.push("open_positions_at_limit");
    if (i.state.ordersToday >= p.maxOrdersPerDay) why.push("orders_per_day_at_limit");
  }
  const g = checkExecutionGate({ ...i.gate, mode: "CONTROLLED_AUTO", orderConfirmationId: null, autoPolicyId: p && validateAutoPolicy(p, i.now).length === 0 ? p.id : null });
  if (!g.allowed) why.push(...g.reasons);
  return verdict(why);
}

/** What a broker report allows us to believe. A submission, an acknowledgement or a partial report is never a fill; only fills that add up to the order quantity make it FILLED, and anything unclear is UNCERTAIN (to be reconciled, never assumed). */
export type BrokerReport = { status: "SUBMITTED" | "ACKNOWLEDGED" | "REJECTED" | "CANCELLED" | "FILLED" | "UNKNOWN"; fills: Array<{ quantity: string; price: string }> };
export function classifyBrokerReport(orderQuantity: string, r: BrokerReport): "NOT_FILLED" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "CANCELLED" | "UNCERTAIN" {
  const oq = toScaled(orderQuantity);
  if (oq === null) return "UNCERTAIN";
  let total = 0n;
  for (const f of r.fills) { const q = toScaled(f.quantity), pr = toScaled(f.price); if (q === null || pr === null || q <= 0n || pr <= 0n) return "UNCERTAIN"; total += q; }
  if (total > oq) return "UNCERTAIN";
  if (r.status === "REJECTED") return total === 0n ? "REJECTED" : "UNCERTAIN";
  if (r.status === "CANCELLED") return total === 0n ? "CANCELLED" : total === oq ? "UNCERTAIN" : "PARTIALLY_FILLED";
  if (r.status === "UNKNOWN") return "UNCERTAIN";
  if (total === 0n) return r.status === "FILLED" ? "UNCERTAIN" : "NOT_FILLED";
  if (total === oq) return r.status === "FILLED" ? "FILLED" : "UNCERTAIN";
  return r.status === "FILLED" ? "UNCERTAIN" : "PARTIALLY_FILLED"; // a FILLED claim with fewer fills than ordered is a contradiction, never a fill
}

/** The only broker adapter that exists in the master build: it refuses. A real adapter is a Stage 10 deliverable behind every gate above. */
export const DISABLED_BROKER_ADAPTER = { kind: "DISABLED" as const, submit: async (): Promise<never> => { throw new Error("live execution is disabled: no broker adapter is installed"); } };
