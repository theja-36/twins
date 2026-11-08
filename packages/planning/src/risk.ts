import { DEFAULT_DRAWDOWN_POLICY, evaluateDrawdown, type DrawdownLevel, type DrawdownPolicy, type EquityPoint, type LiquidityAssessment } from "@twins/risk";
import { dec, div, mul, str, ZERO, type Dec } from "./decimal";
import { checkStop } from "./stop";
import type { FeeSchedule, InstrumentSpec } from "./specs";
import type { SizingResultV2 } from "./sizing";

/**
 * Deterministic risk assessment and capital protection (Module 10). PURE. Every evaluation returns PASS, RESTRICTED or BLOCKED with exact reasons, the limits that applied, the exposure computed, evidence references,
 * the policy version and the evaluation time. RESTRICTED means "allowed only at a reduced size / under conditions" (the size multiplier and caps are returned); BLOCKED means "no new position".
 * HARD RULES: no confidence score, agent verdict, AI output or user preference is an input that can relax a restriction (confidence is not even a parameter); a missing, stale or unreadable input restricts or blocks, never passes.
 * This is NOT the mandatory stop-loss validation: the result states `stop.independentlyValidated: false` and Stage 07 must run the evidence-based validation in the qualification path (G-18).
 */
export const RISK_ENGINE_VERSION = "risk-assessment-v1";
export type RiskVerdict = "PASS" | "RESTRICTED" | "BLOCKED";
export interface RiskReason { code: string; severity: "BLOCK" | "RESTRICT" | "INFO"; detail: string; limit: string | null; value: string | null; correctiveAction: string | null; evidence: string[]; multiplier?: number }
export interface RiskPolicyLimits {
  policyVersion: number; riskPercent: string; maxRiskPerTrade: string | null; maxDailyLoss: string; maxConcurrentPositions: number; maxLots: number; minRewardToRisk: string; allowedUnderlyings: readonly string[];
  /** Optional per-user overrides (null = the platform default in RiskExtras). */
  maxDrawdownPct: string | null; maxPortfolioExposurePct: string | null; maxCorrelatedRiskPct: string | null; maxPositionNotionalPct: string | null;
}
/** Platform-level protections. Every value is a ceiling or a restriction; a user policy may tighten them but a null never loosens them. */
export interface RiskExtras {
  maxOpenRiskPct: string; maxGroupRiskPct: string; maxExposurePct: string; closingBufferMinutes: number; sessionOpenMinutes: number; sessionCloseMinutes: number;
  highVolMultiplier: number; elevatedEventMultiplier: number; missingRegime: "RESTRICT" | "BLOCK"; missingRegimeMultiplier: number; unverifiedSpecMultiplier: number; expiryDayMultiplier: number; liquidityUnknownMultiplier: number;
  drawdown: DrawdownPolicy; correlationGroups: Record<string, readonly string[]>;
}
export const DEFAULT_RISK_EXTRAS: RiskExtras = {
  maxOpenRiskPct: "5", maxGroupRiskPct: "3", maxExposurePct: "100", closingBufferMinutes: 15, sessionOpenMinutes: 9 * 60 + 15, sessionCloseMinutes: 15 * 60 + 30,
  highVolMultiplier: 0.5, elevatedEventMultiplier: 0.75, missingRegime: "RESTRICT", missingRegimeMultiplier: 0.5, unverifiedSpecMultiplier: 0.5, expiryDayMultiplier: 0.5, liquidityUnknownMultiplier: 0.5,
  drawdown: DEFAULT_DRAWDOWN_POLICY, correlationGroups: { INDEX: ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"] },
};
export interface OpenPosition { underlying: string; side: "BUY" | "SELL"; notional: string; riskAmount: string }
export interface PortfolioState { openPositions: readonly OpenPosition[]; realizedLossToday: string; equityCurve: readonly EquityPoint[] | null; previousDrawdownLevel?: DrawdownLevel | null; asOf: string }
export interface RegimeLike { underlying: string; regime: string; volatilityRegime: string; eventRisk: string; riskOff: boolean; dataSource: string; asOf: string | null; version?: string; freshness: { stale: boolean } }
/** A control currently in force (derived from the append-only control events). */
export interface ActiveControl { scope: "USER" | "MARKET" | "SOURCE" | "STRATEGY"; scopeKey: string | null; kind: string; reason: string; setAt: string; expiresAt: string | null; id?: string }
export interface RiskCandidate { id: string; source: "TELEGRAM" | "INDEPENDENT"; underlying: string; exchange: string; side: "BUY" | "SELL"; instrumentType: "equity" | "future" | "option"; entry: string | number | null; stop: string | number | null | undefined; stopBasis: string | null; targets: ReadonlyArray<string | number>; expiry: string | null; setup: string | null }
export interface RiskContext {
  now: Date; userId: string; limits: RiskPolicyLimits; extras: RiskExtras; capital: { total: string; available: string };
  candidate: RiskCandidate; spec: InstrumentSpec | null; fees: FeeSchedule | null; portfolio: PortfolioState | null; regime: RegimeLike | null; liquidityQuoteAvailable: boolean;
  controls: readonly ActiveControl[]; evidence: readonly string[];
}
export interface RiskCaps { remainingDailyRisk: string | null; remainingPortfolioRisk: string | null; remainingGroupRisk: string | null }
export interface Preflight { blocks: RiskReason[]; restrictions: RiskReason[]; infos: RiskReason[]; sizeMultiplier: number; caps: RiskCaps; exposure: ExposureSummary; drawdownLevel: DrawdownLevel | null }
export interface ExposureSummary { openCount: number; openNotional: string; openRisk: string; groupKey: string | null; groupOpenRisk: string; realizedLossToday: string; dailyLossLimit: string; remainingDailyRisk: string | null; openRiskLimit: string; groupRiskLimit: string }
export interface RiskDecision {
  engineVersion: string; policyVersion: number; verdict: RiskVerdict; reasons: RiskReason[]; correctiveActions: string[]; limits: Record<string, string | number | null>; exposure: ExposureSummary; sizeMultiplier: number; caps: RiskCaps;
  evidence: string[]; evaluatedAt: string; stop: { structurallyValid: boolean; independentlyValidated: false; note: string }; specs: { specVersion: string | null; specSourceKind: string | null; feeVersion: string | null; feeSourceKind: string | null }; grantsApproval: false;
}
const R = (code: string, severity: RiskReason["severity"], detail: string, o: Partial<RiskReason> = {}): RiskReason => ({ code, severity, detail, limit: null, value: null, correctiveAction: null, evidence: [], ...o });
const groupOf = (u: string, g: Record<string, readonly string[]>): string | null => Object.entries(g).find(([, m]) => m.includes(u))?.[0] ?? null;
const istParts = (d: Date): { day: number; minutes: number; date: string } => { const t = new Date(d.getTime() + 330 * 60_000); return { day: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), date: t.toISOString().slice(0, 10) }; };
const controlApplies = (c: ActiveControl, ctx: RiskContext): boolean => {
  if (c.expiresAt !== null && Date.parse(c.expiresAt) <= ctx.now.getTime()) return false;
  switch (c.scope) {
    case "USER": return c.scopeKey === null || c.scopeKey === ctx.userId;
    case "MARKET": return c.scopeKey === ctx.candidate.exchange;
    case "SOURCE": return c.scopeKey === ctx.candidate.source;
    case "STRATEGY": return c.scopeKey === ctx.candidate.setup;
  }
};

/** Phase 1: everything that does not need the position size. Returns hard blocks, restrictions, a size multiplier (only ever <= 1) and the risk headroom the sizing engine must stay inside. */
export function preflightRisk(ctx: RiskContext): Preflight {
  const { limits: L, extras: X, candidate: c } = ctx, blocks: RiskReason[] = [], restr: RiskReason[] = [], infos: RiskReason[] = [];
  let mult = 1;
  const restrict = (r: RiskReason, m: number): void => { restr.push({ ...r, multiplier: m }); mult = Math.min(mult, m); };
  const cap = dec(ctx.capital.available);

  // controls: any matching active control blocks (kill switch, halts, per-market / source / strategy / user restrictions)
  for (const k of ctx.controls) if (controlApplies(k, ctx)) blocks.push(R(`CONTROL_${k.kind}`, "BLOCK", `${k.scope} control "${k.kind}" is in force: ${k.reason}`, { evidence: [`control:${k.id ?? k.kind}`], correctiveAction: k.kind === "DAILY_LOSS_HALT" ? "wait for the next trading day; the halt expires automatically" : "an owner must clear the control with a recorded reason" }));

  // trade-level inputs
  if (L.allowedUnderlyings.length > 0 && !L.allowedUnderlyings.includes(c.underlying)) blocks.push(R("UNDERLYING_NOT_ALLOWED", "BLOCK", `${c.underlying} is not in the user's allowed underlyings`, { limit: L.allowedUnderlyings.join(","), value: c.underlying, correctiveAction: "add the underlying to the risk policy (a new policy version) if intended" }));
  if (!ctx.spec) blocks.push(R("SPEC_UNAVAILABLE", "BLOCK", "no versioned instrument specification is available", { correctiveAction: "load an instrument specification (lot size, tick size) for this instrument" }));
  if (!ctx.fees) blocks.push(R("FEES_UNAVAILABLE", "BLOCK", "no versioned fee schedule is available", { correctiveAction: "load the fee schedule for this segment" }));
  const stop = checkStop({ side: c.side, entry: c.entry, stop: c.stop, stopBasis: c.stopBasis, instrumentType: ctx.spec?.instrumentType ?? c.instrumentType, tick: ctx.spec?.tickSize ?? "0.01" });
  if (!stop.ok) blocks.push(R(stop.code, "BLOCK", stop.detail, { correctiveAction: "supply a valid stop-loss on the correct side of the entry, in the right basis" }));
  if (ctx.spec && ctx.spec.sourceKind !== "OFFICIAL") restrict(R("SPEC_UNVERIFIED", "RESTRICT", `the instrument specification is ${ctx.spec.sourceKind}, not an official source`, { value: ctx.spec.specVersion, correctiveAction: "load the official exchange specification" }), X.unverifiedSpecMultiplier);
  if (ctx.fees && ctx.fees.sourceKind !== "OFFICIAL") restrict(R("FEES_UNVERIFIED", "RESTRICT", `the fee schedule is ${ctx.fees.sourceKind}, not an official source`, { value: ctx.fees.feeVersion, correctiveAction: "load the official fee schedule" }), X.unverifiedSpecMultiplier);

  // session, closing time and expiry (IST)
  const t = istParts(ctx.now);
  if (t.day === 0 || t.day === 6) blocks.push(R("MARKET_CLOSED", "BLOCK", "the market is closed on weekends", { correctiveAction: "re-evaluate during the next session" }));
  else if (t.minutes < X.sessionOpenMinutes || t.minutes >= X.sessionCloseMinutes) blocks.push(R("OUTSIDE_SESSION", "BLOCK", "outside the trading session", { correctiveAction: "re-evaluate during the session" }));
  else if (t.minutes >= X.sessionCloseMinutes - X.closingBufferMinutes) blocks.push(R("CLOSING_WINDOW", "BLOCK", `no new entries in the last ${X.closingBufferMinutes} minutes of the session`, { limit: String(X.closingBufferMinutes), correctiveAction: "re-evaluate next session" }));
  infos.push(R("HOLIDAY_CALENDAR_NOT_CHECKED", "INFO", "exchange holidays are not checked here; the market-calendar agent covers them in research"));
  if (c.expiry !== null) {
    if (c.expiry < t.date) blocks.push(R("INSTRUMENT_EXPIRED", "BLOCK", "the instrument has already expired", { value: c.expiry }));
    else if (c.expiry === t.date) restrict(R("EXPIRY_DAY", "RESTRICT", "expiry day: rapid decay and gap risk", { value: c.expiry, limit: String(X.expiryDayMultiplier) }), X.expiryDayMultiplier);
  }

  // market conditions
  const rg = ctx.regime;
  if (!rg || rg.regime === "UNKNOWN" || rg.freshness.stale || rg.underlying !== c.underlying) {
    const why = !rg ? "no market regime is available" : rg.underlying !== c.underlying ? "the regime describes a different instrument" : rg.freshness.stale ? "the market regime is stale" : "the market regime is unknown";
    if (X.missingRegime === "BLOCK") blocks.push(R("MARKET_DATA_UNAVAILABLE", "BLOCK", why, { correctiveAction: "provide a fresh market regime" }));
    else restrict(R("MARKET_DATA_UNAVAILABLE", "RESTRICT", `${why}; size is reduced`, { correctiveAction: "provide a fresh market regime", limit: String(X.missingRegimeMultiplier) }), X.missingRegimeMultiplier);
  } else {
    if (rg.dataSource === "FIXTURE") restrict(R("REGIME_FIXTURE_BACKED", "RESTRICT", "the regime comes from fixture data and cannot relax any restriction", { limit: String(X.missingRegimeMultiplier) }), X.missingRegimeMultiplier);
    if (rg.riskOff) blocks.push(R("REGIME_RISK_OFF", "BLOCK", "risk-off regime: no new entries", { correctiveAction: "wait for the regime to normalise" }));
    if (rg.volatilityRegime === "EXTREME") blocks.push(R("VOLATILITY_EXTREME", "BLOCK", "extreme volatility: no new entries"));
    else if (rg.volatilityRegime === "HIGH" || rg.regime === "HIGH_VOLATILITY") restrict(R("VOLATILITY_HIGH", "RESTRICT", "high volatility: size reduced", { limit: String(X.highVolMultiplier) }), X.highVolMultiplier);
    if (rg.eventRisk === "HIGH") blocks.push(R("EVENT_RISK_HIGH", "BLOCK", "a high-impact event is imminent", { correctiveAction: "wait until after the event" }));
    else if (rg.eventRisk === "ELEVATED" || rg.eventRisk === "UNKNOWN") restrict(R(rg.eventRisk === "UNKNOWN" ? "EVENT_RISK_UNKNOWN" : "EVENT_RISK_ELEVATED", "RESTRICT", rg.eventRisk === "UNKNOWN" ? "event risk is unknown; size reduced" : "a high-impact event is near; size reduced", { limit: String(X.elevatedEventMultiplier) }), X.elevatedEventMultiplier);
  }
  if (!ctx.liquidityQuoteAvailable) restrict(R("LIQUIDITY_UNKNOWN", "RESTRICT", "no quote or volume data to judge liquidity; size reduced", { limit: String(X.liquidityUnknownMultiplier), correctiveAction: "provide a quote and average volume" }), X.liquidityUnknownMultiplier);

  // portfolio, daily and drawdown
  const exposure: ExposureSummary = { openCount: 0, openNotional: "0.00", openRisk: "0.00", groupKey: groupOf(c.underlying, X.correlationGroups), groupOpenRisk: "0.00", realizedLossToday: "0.00", dailyLossLimit: L.maxDailyLoss, remainingDailyRisk: null, openRiskLimit: "0.00", groupRiskLimit: "0.00" };
  const caps: RiskCaps = { remainingDailyRisk: null, remainingPortfolioRisk: null, remainingGroupRisk: null };
  let level: DrawdownLevel | null = null;
  const P = ctx.portfolio;
  if (!P) blocks.push(R("PORTFOLIO_STATE_UNAVAILABLE", "BLOCK", "open positions and today's realised loss are unknown; the risk budget cannot be computed", { correctiveAction: "provide the portfolio state" }));
  else {
    const openNotional = P.openPositions.reduce<Dec>((a, p) => a + dec(p.notional), ZERO), openRisk = P.openPositions.reduce<Dec>((a, p) => a + dec(p.riskAmount), ZERO);
    const gk = exposure.groupKey, groupRisk = P.openPositions.filter((p) => gk !== null && groupOf(p.underlying, X.correlationGroups) === gk).reduce<Dec>((a, p) => a + dec(p.riskAmount), ZERO);
    const lossToday = dec(P.realizedLossToday), dailyLimit = dec(L.maxDailyLoss);
    const openLimit = mul(cap, div(dec(X.maxOpenRiskPct), dec(100))), groupPct = L.maxCorrelatedRiskPct ?? X.maxGroupRiskPct, groupLimit = mul(cap, div(dec(groupPct), dec(100)));
    const remDaily = dailyLimit - lossToday - openRisk, remOpen = openLimit - openRisk, remGroup = exposure.groupKey ? groupLimit - groupRisk : null;
    Object.assign(exposure, { openCount: P.openPositions.length, openNotional: str(openNotional), openRisk: str(openRisk), groupOpenRisk: str(groupRisk), realizedLossToday: str(lossToday), remainingDailyRisk: str(remDaily), openRiskLimit: str(openLimit), groupRiskLimit: str(groupLimit) });
    Object.assign(caps, { remainingDailyRisk: str(remDaily < ZERO ? ZERO : remDaily), remainingPortfolioRisk: str(remOpen < ZERO ? ZERO : remOpen), remainingGroupRisk: remGroup === null ? null : str(remGroup < ZERO ? ZERO : remGroup) });
    if (lossToday >= dailyLimit) blocks.push(R("DAILY_LOSS_LIMIT_REACHED", "BLOCK", "today's realised loss has reached the daily limit", { limit: L.maxDailyLoss, value: str(lossToday), correctiveAction: "no new entries today; a DAILY_LOSS_HALT should be recorded" }));
    else if (remDaily <= ZERO) blocks.push(R("DAILY_RISK_BUDGET_EXHAUSTED", "BLOCK", "realised loss plus the risk of open positions has used the daily limit", { limit: L.maxDailyLoss, value: str(lossToday + openRisk), correctiveAction: "close or reduce open positions, or wait" }));
    if (P.openPositions.length >= L.maxConcurrentPositions) blocks.push(R("MAX_CONCURRENT_POSITIONS", "BLOCK", "the maximum number of concurrent positions is open", { limit: String(L.maxConcurrentPositions), value: String(P.openPositions.length), correctiveAction: "close a position first" }));
    if (remOpen <= ZERO) blocks.push(R("PORTFOLIO_RISK_BUDGET_EXHAUSTED", "BLOCK", "the risk of open positions has used the portfolio risk limit", { limit: str(openLimit), value: str(openRisk) }));
    if (remGroup !== null && remGroup <= ZERO) blocks.push(R("CORRELATED_EXPOSURE_LIMIT", "BLOCK", `open risk in the correlated ${exposure.groupKey} group has used its limit`, { limit: str(groupLimit), value: str(groupRisk), correctiveAction: "reduce correlated exposure first" }));
    if (P.equityCurve && P.equityCurve.length >= 2) {
      const policy: DrawdownPolicy = L.maxDrawdownPct ? { ...X.drawdown, haltPct: Math.min(X.drawdown.haltPct, Number(L.maxDrawdownPct)), reducePct: Math.min(X.drawdown.reducePct, Number(L.maxDrawdownPct)), cautionPct: Math.min(X.drawdown.cautionPct, Number(L.maxDrawdownPct)) } : X.drawdown;
      const dd = evaluateDrawdown(P.equityCurve, policy, P.previousDrawdownLevel ?? null);
      level = dd.level;
      const m = policy.sizeMultipliers[dd.level];
      if (m === 0) blocks.push(R("DRAWDOWN_HALT", "BLOCK", "the drawdown limit is breached: no new entries", { value: dd.level, correctiveAction: "an owner must review and clear the DRAWDOWN_HALT with a recorded reason" }));
      else if (m < 1) restrict(R("DRAWDOWN_REDUCED", "RESTRICT", `drawdown level ${dd.level}: size reduced`, { value: dd.level, limit: String(m) }), m);
    } else infos.push(R("DRAWDOWN_UNEVALUATED", "INFO", "the equity history is too short to evaluate drawdown"));
  }
  return { blocks, restrictions: restr, infos, sizeMultiplier: mult, caps, exposure, drawdownLevel: level };
}

/** Phase 2: judge the computed size and assemble the decision. */
export function assessRisk(ctx: RiskContext, pre: Preflight, sizing: SizingResultV2, liquidity: LiquidityAssessment | null): RiskDecision {
  const { limits: L, extras: X } = ctx, blocks = [...pre.blocks], restr = [...pre.restrictions], infos = [...pre.infos], cap = dec(ctx.capital.available);
  if (sizing.status === "NOT_SIZED") blocks.push(R(`NOT_SIZED_${sizing.reason ?? "UNKNOWN"}`, "BLOCK", sizing.detail, { correctiveAction: "address the cause; no position can be sized as is" }));
  else {
    if (sizing.riskBudget.binding.startsWith("daily") || sizing.riskBudget.binding.startsWith("portfolio") || sizing.riskBudget.binding.startsWith("correlated")) restr.push(R("SIZE_LIMITED_BY_BUDGET", "RESTRICT", `the size is limited by the ${sizing.riskBudget.binding} budget`, { value: sizing.riskBudget.effectiveBudget }));
    const rr = sizing.targets[0] ? dec(sizing.targets[0].grossRewardToRisk) : null, minRR = dec(L.minRewardToRisk);
    if (rr === null || rr === ZERO) blocks.push(R("REWARD_TO_RISK_UNKNOWN", "BLOCK", "no valid target: reward-to-risk cannot be evaluated", { limit: L.minRewardToRisk, correctiveAction: "supply a target beyond the entry" }));
    else if (rr < minRR) blocks.push(R("REWARD_TO_RISK_TOO_LOW", "BLOCK", "the first target's reward-to-risk is below the policy minimum", { limit: L.minRewardToRisk, value: str(rr), correctiveAction: "choose a better entry/stop/target" }));
    const limitPct = dec(L.maxPortfolioExposurePct ?? X.maxExposurePct);
    if (ctx.portfolio && dec(pre.exposure.openNotional) + dec(sizing.grossExposure) > mul(cap, div(limitPct, dec(100)))) blocks.push(R("PORTFOLIO_EXPOSURE_LIMIT", "BLOCK", "total exposure would exceed the portfolio limit", { limit: `${str(limitPct, 2)}%`, value: str(dec(pre.exposure.openNotional) + dec(sizing.grossExposure)), correctiveAction: "reduce size or close positions" }));
    if (dec(sizing.maxLossAtStop) > dec(L.maxDailyLoss)) blocks.push(R("LOSS_EXCEEDS_DAILY_LIMIT", "BLOCK", "the stop-out loss alone exceeds the daily loss limit", { limit: L.maxDailyLoss, value: sizing.maxLossAtStop }));
    if (liquidity) {
      if (liquidity.verdict === "TOO_LARGE") blocks.push(R("LIQUIDITY_TOO_LARGE", "BLOCK", "the position is too large for the available liquidity", { correctiveAction: "reduce the number of lots" }));
      else if (liquidity.verdict === "CAUTION") restr.push(R("LIQUIDITY_CAUTION", "RESTRICT", "liquidity is thin for this size"));
      else if (liquidity.verdict === "UNKNOWN") restr.push(R("LIQUIDITY_UNKNOWN", "RESTRICT", "liquidity could not be assessed"));
    }
  }
  const verdict: RiskVerdict = blocks.length ? "BLOCKED" : restr.length ? "RESTRICTED" : "PASS";
  const reasons = [...blocks, ...restr, ...infos];
  reasons.push(R("STOP_VALIDATION_PENDING", "INFO", "the stop passed structural checks only; the mandatory evidence-based stop-loss validation runs in the Stage 07 qualification path", { correctiveAction: "Stage 07 qualification must validate the stop independently" }));
  const stopOk = !reasons.some((r) => ["STOP_MISSING", "ENTRY_INVALID", "STOP_INVALID", "STOP_WRONG_SIDE", "STOP_EQUALS_ENTRY", "STOP_BASIS_INVALID", "STOP_BASIS_MISMATCH", "PRICE_OFF_TICK", "SIDE_INVALID"].includes(r.code));
  return {
    engineVersion: RISK_ENGINE_VERSION, policyVersion: L.policyVersion, verdict, reasons, correctiveActions: [...new Set(reasons.map((r) => r.correctiveAction).filter((x): x is string => !!x))], evaluatedAt: ctx.now.toISOString(),
    limits: { riskPercent: L.riskPercent, maxRiskPerTrade: L.maxRiskPerTrade, maxDailyLoss: L.maxDailyLoss, maxConcurrentPositions: L.maxConcurrentPositions, maxLots: L.maxLots, minRewardToRisk: L.minRewardToRisk, maxOpenRiskPct: X.maxOpenRiskPct, maxGroupRiskPct: L.maxCorrelatedRiskPct ?? X.maxGroupRiskPct, maxExposurePct: L.maxPortfolioExposurePct ?? X.maxExposurePct, closingBufferMinutes: X.closingBufferMinutes },
    exposure: pre.exposure, sizeMultiplier: pre.sizeMultiplier, caps: pre.caps, evidence: [...new Set([...ctx.evidence, `candidate:${ctx.candidate.id}`, ...(ctx.spec ? [`spec:${ctx.spec.specVersion}`] : []), ...(ctx.fees ? [`fees:${ctx.fees.feeVersion}`] : [])])],
    stop: { structurallyValid: stopOk, independentlyValidated: false, note: "structural checks only; Stage 07 must run the mandatory stop-loss validation" },
    specs: { specVersion: ctx.spec?.specVersion ?? null, specSourceKind: ctx.spec?.sourceKind ?? null, feeVersion: ctx.fees?.feeVersion ?? null, feeSourceKind: ctx.fees?.sourceKind ?? null }, grantsApproval: false,
  };
}

export interface HaltTrigger { kind: "DAILY_LOSS_HALT" | "DRAWDOWN_HALT"; reason: string; expiresAt: Date | null }
/** Which halts the current portfolio state calls for. The daily-loss halt expires at the start of the next IST trading day; the drawdown halt has no expiry and can be cleared only by a person with a recorded reason. */
export function haltTriggers(p: PortfolioState | null, limits: Pick<RiskPolicyLimits, "maxDailyLoss" | "maxDrawdownPct">, extras: RiskExtras, now: Date): HaltTrigger[] {
  if (!p) return [];
  const out: HaltTrigger[] = [];
  if (dec(p.realizedLossToday) >= dec(limits.maxDailyLoss)) {
    const ist = new Date(now.getTime() + 330 * 60_000), nextDay = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 330 * 60_000;
    out.push({ kind: "DAILY_LOSS_HALT", reason: `realised loss ${p.realizedLossToday} reached the daily limit ${limits.maxDailyLoss}`, expiresAt: new Date(nextDay) });
  }
  if (p.equityCurve && p.equityCurve.length >= 2) {
    const base = extras.drawdown, hp = limits.maxDrawdownPct ? Math.min(base.haltPct, Number(limits.maxDrawdownPct)) : base.haltPct;
    const dd = evaluateDrawdown(p.equityCurve, { ...base, haltPct: hp, reducePct: Math.min(base.reducePct, hp), cautionPct: Math.min(base.cautionPct, hp) }, p.previousDrawdownLevel ?? null);
    if (dd.level === "HALT_NEW_ENTRIES") out.push({ kind: "DRAWDOWN_HALT", reason: `drawdown level ${dd.level} reached`, expiresAt: null });
  }
  return out;
}
