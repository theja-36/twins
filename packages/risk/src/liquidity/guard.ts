/**
 * Liquidity and slippage guard (P1 #8), advisory. PURE: estimates the cost of crossing the spread and moving the market for one order from the quote, displayed depth and average daily volume, and says whether
 * the order looks too large for the liquidity. Impact uses the square-root law (impact_bps = k x sqrt(order / average daily volume)); it is an ESTIMATE with a configurable k, not a measurement. It can only recommend
 * a SMALLER quantity (`suggestedMaxQuantity <= quantity`), never a larger one; unknown inputs are listed and skip the checks that need them. Places nothing and approves nothing.
 */
export const LIQUIDITY_GUARD_VERSION = "liquidity-guard-v1";
export interface LiquidityQuote { bid: number | null; ask: number | null; /** Size displayed at the touch on the side the order trades against, or null. */ touchSize: number | null; avgDailyVolume: number | null }
export interface LiquidityPolicy { impactK: number; maxSlippageBps: number; cautionSlippageBps: number; maxParticipation: number; cautionParticipation: number; maxTouchShare: number; maxSpreadBps: number }
export const DEFAULT_LIQUIDITY_POLICY: LiquidityPolicy = { impactK: 10, maxSlippageBps: 25, cautionSlippageBps: 10, maxParticipation: 0.02, cautionParticipation: 0.005, maxTouchShare: 1, maxSpreadBps: 50 };
export type LiquidityVerdict = "OK" | "CAUTION" | "TOO_LARGE" | "UNKNOWN";
export interface LiquidityAssessment {
  version: typeof LIQUIDITY_GUARD_VERSION; verdict: LiquidityVerdict; spreadBps: number | null; halfSpreadBps: number | null; participation: number | null; impactBps: number | null; expectedSlippageBps: number | null;
  touchShare: number | null; /** Never above the requested quantity. */ suggestedMaxQuantity: number; reasons: string[]; unknownInputs: string[]; grantsApproval: false;
}
const round = (x: number): number => Math.round(x * 1e4) / 1e4;

export function assessLiquidity(quantity: number, q: LiquidityQuote, policy: LiquidityPolicy = DEFAULT_LIQUIDITY_POLICY): LiquidityAssessment {
  const p = policy;
  if (!(p.impactK >= 0 && p.maxSlippageBps > 0 && p.cautionSlippageBps > 0 && p.cautionSlippageBps <= p.maxSlippageBps && p.maxParticipation > 0 && p.cautionParticipation <= p.maxParticipation && p.maxTouchShare > 0 && p.maxSpreadBps > 0)) throw new Error("invalid liquidity policy");
  const unknown: string[] = [], reasons: string[] = [];
  const empty = (verdict: LiquidityVerdict, why: string): LiquidityAssessment => ({ version: LIQUIDITY_GUARD_VERSION, verdict, spreadBps: null, halfSpreadBps: null, participation: null, impactBps: null, expectedSlippageBps: null, touchShare: null, suggestedMaxQuantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 0, reasons: [why], unknownInputs: unknown, grantsApproval: false });
  if (!(Number.isInteger(quantity) && quantity > 0)) return empty("UNKNOWN", "QUANTITY_INVALID");
  const okPx = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0;
  if (!okPx(q.bid) || !okPx(q.ask) || q.ask < q.bid) { unknown.push("bidAsk"); return empty("UNKNOWN", "NO_USABLE_QUOTE"); }
  const mid = (q.bid + q.ask) / 2;
  const spreadBps = round(((q.ask - q.bid) / mid) * 1e4), halfSpreadBps = round(spreadBps / 2);
  let participation: number | null = null, impactBps: number | null = null, touchShare: number | null = null;
  if (q.avgDailyVolume !== null && Number.isFinite(q.avgDailyVolume) && q.avgDailyVolume > 0) { participation = round(quantity / q.avgDailyVolume); impactBps = round(p.impactK * Math.sqrt(participation)); } else unknown.push("avgDailyVolume");
  if (q.touchSize !== null && Number.isFinite(q.touchSize) && q.touchSize > 0) touchShare = round(quantity / q.touchSize); else unknown.push("touchSize");
  const expectedSlippageBps = round(halfSpreadBps + (impactBps ?? 0));

  let verdict: LiquidityVerdict = "OK";
  const bump = (v: LiquidityVerdict, code: string): void => { reasons.push(code); if (v === "TOO_LARGE" || (v === "CAUTION" && verdict === "OK")) verdict = v; };
  if (spreadBps > p.maxSpreadBps) bump("TOO_LARGE", "SPREAD_TOO_WIDE");
  if (expectedSlippageBps > p.maxSlippageBps) bump("TOO_LARGE", "EXPECTED_SLIPPAGE_ABOVE_MAX"); else if (expectedSlippageBps > p.cautionSlippageBps) bump("CAUTION", "EXPECTED_SLIPPAGE_ELEVATED");
  if (participation !== null) { if (participation > p.maxParticipation) bump("TOO_LARGE", "PARTICIPATION_ABOVE_MAX"); else if (participation > p.cautionParticipation) bump("CAUTION", "PARTICIPATION_ELEVATED"); }
  if (touchShare !== null && touchShare > p.maxTouchShare) bump("TOO_LARGE", "ORDER_EXCEEDS_DISPLAYED_DEPTH");

  // Largest quantity that satisfies every known limit; never above the requested quantity.
  let cap = quantity;
  if (q.avgDailyVolume !== null && q.avgDailyVolume > 0) {
    cap = Math.min(cap, Math.floor(p.maxParticipation * q.avgDailyVolume));
    const room = p.maxSlippageBps - halfSpreadBps;
    if (room <= 0) cap = 0; else if (p.impactK > 0) cap = Math.min(cap, Math.floor((q.avgDailyVolume * (room / p.impactK) ** 2)));
  } else if (halfSpreadBps > p.maxSlippageBps) cap = 0;
  if (q.touchSize !== null && q.touchSize > 0) cap = Math.min(cap, Math.floor(p.maxTouchShare * q.touchSize));
  if (spreadBps > p.maxSpreadBps) cap = 0;
  return { version: LIQUIDITY_GUARD_VERSION, verdict, spreadBps, halfSpreadBps, participation, impactBps, expectedSlippageBps, touchShare, suggestedMaxQuantity: Math.max(0, Math.min(quantity, cap)), reasons, unknownInputs: unknown, grantsApproval: false };
}
