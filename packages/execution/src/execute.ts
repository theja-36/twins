import { ACTION_APPROVE, checkExecutionGate, isQualifiedOutcome, type ExecutionMode } from "@twins/types";
import { evaluateSafety } from "@twins/runtime-state";
import { addMonitoringEvent, addPositionEvent, createExecutionRequest, createPaperOrder, createPaperPosition, fillTotalsForDecision, getApproval, getCandidate, getDecision, getExecutionRequest, getPaperOrder, getPositionForDecision, hasPaperPermission, insertPaperFill, invalidateDecision, listPaperOrders, recordPaperOutcome, setOrderStatus, updateExecutionRequest, updatePositionEntry, updatePositionExit, type PaperOrderRow, type PaperPositionRow, type StoredDecision } from "@twins/database";
import { revalidateDecision } from "@twins/decision";
import { ceilTo2, dec, div, floorTo2, legCosts, mul, str, ZERO, type Dec, type EvaluationDeps, type FeeSchedule } from "@twins/planning";
import type { ExecutionConfig } from "./config";
import { freshPrice, type FreshPrice, type PriceProvider } from "./prices";
import { DEFAULT_RULES_BASE, type PositionRules } from "./position";

/**
 * Paper execution (Module 13B). The whole path is simulated: nothing here can reach a broker. An approved decision is executed only after an INDEPENDENT chain of checks, each recorded: ownership, permission, the execution
 * gate (live modes are refused by construction), the approval record, a fresh revalidation (current risk, the mandatory stop-loss rule, kill switch, window), duplicates. The database then re-enforces the important ones on
 * the order itself. Retries are safe at every step: requests are unique per decision and mode, orders are keyed, fills are applied by the database, and the position is DERIVED from fills (so a crash between steps heals).
 * No confidence score or LLM output appears on this path.
 */
export interface AlertEvent { kind: string; severity: "INFO" | "WARNING" | "CRITICAL"; userId: string; accountId: string; positionId: string | null; decisionId: string | null; dedupeKey: string; detail: string }
export interface ExecutionDeps { eval: EvaluationDeps; prices: PriceProvider | null; config: ExecutionConfig; alert?: (a: AlertEvent) => void; log?: (event: string, fields: Record<string, unknown>) => void }
export interface Check { name: string; ok: boolean; detail: string }
export type ExecutionOutcome =
  | { status: "REFUSED"; reasons: string[]; checks: Check[] }
  | { status: "ORDER_OPEN" | "PARTIALLY_FILLED" | "FILLED"; requestId: string; orderId: string; duplicate: boolean; filledQuantity: string; reason?: string };
const now = (d: ExecutionDeps): Date => (d.eval.now ?? (() => new Date()))();
const bps = (n: number): Dec => dec(n / 10_000);
export const instrumentKey = (c: { underlying: string }): string => c.underlying;

export async function requestPaperExecution(d: ExecutionDeps, o: { userId: string; decisionId: string; mode: ExecutionMode; idempotencyKey: string }): Promise<ExecutionOutcome> {
  const t = now(d), checks: Check[] = [], add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
  const dec0 = await getDecision(d.eval.db, o.userId, o.decisionId);
  add("ownership", !!dec0 && dec0.userId === o.userId, dec0 ? "the decision belongs to this user" : "no such decision for this user");
  if (!dec0) return { status: "REFUSED", reasons: ["decision_not_found"], checks };
  // a live mode is refused by the same gate that guards everything else, and recorded (permanently) as REJECTED
  if (o.mode !== "PAPER") {
    const gate = checkExecutionGate({ mode: o.mode, liveExecutionEnabled: false, paperEnabled: d.config.enabled, userPermitsMode: false, killSwitchActive: false, riskRecheckPassed: false, decisionState: dec0.workflowState as never, decisionOutcome: dec0.outcome as never, orderConfirmationId: null, autoPolicyId: null, brokerAndRegulatoryGatesVerified: false });
    const reasons = gate.allowed ? ["live_execution_disabled"] : gate.reasons;
    await createExecutionRequest(d.eval.db, o.userId, { accountId: dec0.accountId, decisionId: dec0.id, mode: o.mode, idempotencyKey: o.idempotencyKey, state: "REJECTED", checks, refusalReasons: reasons });
    return { status: "REFUSED", reasons, checks };
  }
  // idempotent re-entry: an existing request for this decision resumes (never duplicates)
  const existing = await getExecutionRequest(d.eval.db, o.userId, dec0.id, "PAPER");
  if (existing && existing.state === "COMPLETED") { const ords = await listPaperOrders(d.eval.db, o.userId, { decisionId: dec0.id, limit: 20 }); const entry = ords.find((x) => x.purpose === "ENTRY"); return { status: "FILLED", requestId: existing.id, orderId: entry?.id ?? "", duplicate: true, filledQuantity: entry?.filledQuantity ?? "0" }; }
  if (existing && (existing.state === "REJECTED" || existing.state === "FAILED")) return { status: "REFUSED", reasons: ["request_previously_" + existing.state.toLowerCase()], checks };

  add("execution_enabled", d.config.enabled, d.config.enabled ? "paper execution is enabled" : "paper execution is disabled (TWINS_EXECUTION_ENABLED)");
  const perm = await hasPaperPermission(d.eval.db, o.userId, dec0.accountId);
  add("permission", perm, perm ? "the user enabled PAPER execution for this account" : "PAPER execution is not enabled for this account");
  const ap = await getApproval(d.eval.db, o.userId, dec0.id);
  add("approval", !!ap && ap.action === ACTION_APPROVE && ap.approverUserId === o.userId, ap ? `approval ${ap.action}` : "no approval recorded");
  add("decision_approved", dec0.workflowState === "APPROVED" && isQualifiedOutcome(dec0.outcome), `${dec0.outcome} / ${dec0.workflowState}`);
  const rv = await revalidateDecision(d.eval, { decision: dec0 });
  for (const c of rv.checks) add(`revalidation:${c.name}`, c.ok, c.detail);
  let kill = false; try { kill = !!(await evaluateSafety("intake", "paper.execution")); } catch { kill = true; }
  const gate = checkExecutionGate({ mode: "PAPER", liveExecutionEnabled: false, paperEnabled: d.config.enabled, userPermitsMode: perm, killSwitchActive: kill, riskRecheckPassed: rv.passed, decisionState: dec0.workflowState as never, decisionOutcome: dec0.outcome as never, orderConfirmationId: null, autoPolicyId: null, brokerAndRegulatoryGatesVerified: false });
  add("execution_gate", gate.allowed, gate.allowed ? "gate allows PAPER" : gate.reasons.join(", "));
  const cand = await getCandidate(d.eval.db, dec0.candidateId);
  const spec = cand && d.eval.specs ? await d.eval.specs.instrument({ exchange: cand.exchange, underlying: cand.underlying, instrumentType: cand.strike !== null && cand.optionType !== null ? "option" : "equity", at: t }).catch(() => null) : null;
  const fees = spec && d.eval.specs ? await d.eval.specs.fees({ segment: spec.segment, at: t }).catch(() => null) : null;
  add("instrument_eligibility", !!cand && !!spec && !!fees, spec && fees ? `specification ${spec.specVersion}, fees ${fees.feeVersion}` : "no versioned specification / fee schedule");
  if (checks.some((c) => !c.ok) || !cand || !spec || !fees || !dec0.permittedSize) {
    const reasons = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    await addMonitoringEvent(d.eval.db, o.userId, { accountId: dec0.accountId, decisionId: dec0.id, kind: "ORDER_REJECTED", payload: { reasons, mode: "PAPER" } });
    if (rv.checks.some((c) => !c.ok && ["stop_loss_validation", "risk_evaluation", "size_within_current_limits", "candidate_active"].includes(c.name))) await invalidateDecision(d.eval.db, o.userId, dec0.id, "REVALIDATION_FAILED_AT_EXECUTION", { failed: rv.checks.filter((c) => !c.ok) }, "execution-service");
    return { status: "REFUSED", reasons, checks };
  }
  const { request, created } = await createExecutionRequest(d.eval.db, o.userId, { accountId: dec0.accountId, decisionId: dec0.id, mode: "PAPER", idempotencyKey: o.idempotencyKey, state: "REQUESTED", checks, refusalReasons: [] });
  if (request.state === "REQUESTED") await updateExecutionRequest(d.eval.db, o.userId, request.id, "ELIGIBLE", checks, []);
  const qty = String(dec0.permittedSize.quantity);
  const { order } = await createPaperOrder(d.eval.db, o.userId, { accountId: dec0.accountId, decisionId: dec0.id, executionRequestId: request.id, positionId: null, purpose: "ENTRY", exitReason: null, instrument: cand.underlying, exchange: cand.exchange, side: cand.side, orderType: "MARKET", quantity: qty, limitPrice: null, idempotencyKey: `entry:${dec0.id}` });
  if (order.status === "PROPOSED") await setOrderStatus(d.eval.db, o.userId, order.id, "SUBMITTED", "submitted to the paper broker");
  const fresh = (await getPaperOrder(d.eval.db, o.userId, order.id)) as PaperOrderRow;
  if (fresh.status === "SUBMITTED") await setOrderStatus(d.eval.db, o.userId, order.id, "ACCEPTED", "acknowledged by the paper broker (simulated)");
  const res = await fillOrder(d, { userId: o.userId, orderId: order.id, fees, lotSize: spec.lotSize, decision: dec0, rules: rulesFor(d, spec.lotSize, cand, fees, dec0, spec.instrumentType) });
  return { status: res.status, requestId: request.id, orderId: order.id, duplicate: !created, filledQuantity: res.filledQuantity, ...(res.reason ? { reason: res.reason } : {}) };
}

export function rulesFor(d: ExecutionDeps, lotSize: string, cand: { expiry: string | null; strike: number | null; optionType: string | null }, fees: FeeSchedule, _dec: StoredDecision, kind: "equity" | "future" | "option"): PositionRules {
  const isOption = kind === "option";
  return { ...DEFAULT_RULES_BASE, ladder: d.config.ladder, trailAfterR: d.config.trailAfterR, sessionCloseExitMinutes: d.config.sessionCloseExitMinutes, instrumentKind: isOption ? "option" : "equity", stopBasis: isOption ? "premium" : "price", lotSize, expiry: cand.expiry, fees };
}

/** One fill attempt for an open (ACCEPTED / PARTIALLY_FILLED) order at a FRESH observed price. With no usable price the order stays open and nothing is invented. */
export async function fillOrder(d: ExecutionDeps, o: { userId: string; orderId: string; fees: FeeSchedule; lotSize: string; decision: StoredDecision; rules: PositionRules }): Promise<{ status: "ORDER_OPEN" | "PARTIALLY_FILLED" | "FILLED"; filledQuantity: string; reason?: string }> {
  const t = now(d), order = await getPaperOrder(d.eval.db, o.userId, o.orderId);
  if (!order) throw new Error("order not found");
  if (order.status === "FILLED") return { status: "FILLED", filledQuantity: order.filledQuantity };
  if (order.status !== "ACCEPTED" && order.status !== "PARTIALLY_FILLED") return { status: "ORDER_OPEN", filledQuantity: order.filledQuantity, reason: `order is ${order.status}` };
  const px: FreshPrice = await freshPrice(d.prices, { exchange: order.exchange, symbol: order.instrument }, t, d.config.maxPriceAgeSeconds);
  if (!px.ok) { d.log?.("execution.no_price", { orderId: order.id, reason: px.reason }); return { status: order.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : "ORDER_OPEN", filledQuantity: order.filledQuantity, reason: `no usable price: ${px.reason}` }; }
  const buy = order.side === "BUY", slip = bps(order.purpose === "ENTRY" ? d.config.slippageBps.entry : d.config.slippageBps.exit);
  const fill = buy ? mul(dec(px.price), dec(1) + slip, "up") : mul(dec(px.price), dec(1) - slip, "down");
  if (order.orderType === "LIMIT" && order.limitPrice !== null && (buy ? fill > dec(order.limitPrice) : fill < dec(order.limitPrice))) return { status: order.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : "ORDER_OPEN", filledQuantity: order.filledQuantity, reason: "price has not reached the limit" };
  const remaining = dec(order.quantity) - dec(order.filledQuantity), lot = dec(o.lotSize);
  let step = remaining;
  if (d.config.fillFraction < 1) { const part = (mul(dec(order.quantity), dec(d.config.fillFraction), "down") / lot) * lot; step = part < lot ? lot : part; if (step > remaining) step = remaining; } // partial fills, in whole lots
  const costs = legCosts(o.fees, order.side, fill, step / dec(1));
  await insertPaperFill(d.eval.db, o.userId, { orderId: order.id, quantity: str(step, 8), price: str(fill, 8), costs: str(costs.total, 2), priceSource: px.source, priceAsOf: px.asOf });
  const pos = await syncPosition(d, { userId: o.userId, decision: o.decision, rules: o.rules });
  const after = (await getPaperOrder(d.eval.db, o.userId, order.id)) as PaperOrderRow;
  if (order.purpose === "ENTRY" && after.status === "FILLED") { const rq = await getExecutionRequest(d.eval.db, o.userId, o.decision.id, "PAPER"); if (rq && rq.state === "ELIGIBLE") await updateExecutionRequest(d.eval.db, o.userId, rq.id, "COMPLETED", rq.checks, []); }
  void pos;
  return { status: after.status === "FILLED" ? "FILLED" : "PARTIALLY_FILLED", filledQuantity: after.filledQuantity };
}

/**
 * Derives the position from the FILLS (the source of truth) and writes only what differs. Idempotent: running it twice, or after a crash between a fill and the position update, converges to the same state.
 * Open quantity = entry fills - exit fills; average entry = entry value / entry quantity; realised P&L = exit value - average entry x exit quantity (direction-signed); costs = all fill costs.
 */
export async function syncPosition(d: ExecutionDeps, o: { userId: string; decision: StoredDecision; rules: PositionRules }): Promise<PaperPositionRow | null> {
  const db = d.eval.db, t = now(d);
  const tot = await fillTotalsForDecision(db, o.userId, o.decision.id);
  const eq = dec(tot.entryQty), xq = dec(tot.exitQty);
  if (eq === ZERO) return null;
  const avg = div(dec(tot.entryValue), eq, "up"), open = eq - xq;
  const cand = await getCandidate(db, o.decision.candidateId); if (!cand) throw new Error("candidate missing");
  const dirn = cand.side === "BUY" ? dec(1) : dec(-1);
  const rawPnl = mul(dec(tot.exitValue) - mul(avg, xq), dirn), pnl = rawPnl >= ZERO ? floorTo2(rawPnl) : -ceilTo2(-rawPnl), costs = ceilTo2(dec(tot.costs));
  let pos = await getPositionForDecision(db, o.userId, o.decision.id);
  if (!pos) {
    const entryOrder = (await listPaperOrders(db, o.userId, { decisionId: o.decision.id, limit: 20 })).find((x) => x.purpose === "ENTRY");
    pos = await createPaperPosition(db, o.userId, { accountId: o.decision.accountId, decisionId: o.decision.id, instrument: cand.underlying, exchange: cand.exchange, side: cand.side, quantity: str(open, 8), initialQuantity: entryOrder?.quantity ?? str(eq, 8), avgEntryPrice: str(avg, 8), stopLoss: String(cand.stopLoss), targets: cand.targets.map(String), rules: { ...o.rules, plannedMaxLoss: o.decision.permittedSize?.maxLossAtStop ?? null } });
    await addPositionEvent(db, o.userId, pos.id, "OPENED", { quantity: str(open, 8), avgEntryPrice: str(avg, 8), decisionId: o.decision.id });
    await addMonitoringEvent(db, o.userId, { accountId: pos.accountId, decisionId: o.decision.id, kind: "ENTRY_FILLED", payload: { quantity: str(open, 8), avgEntryPrice: str(avg, 8) } });
  } else if (pos.status === "OPEN") {
    if (dec(pos.quantity) !== open || dec(pos.avgEntryPrice) !== avg) {
      if (xq === ZERO) { await updatePositionEntry(db, o.userId, pos.id, str(open, 8), str(avg, 8)); await addPositionEvent(db, o.userId, pos.id, "ENTRY_FILL", { quantity: str(open, 8), avgEntryPrice: str(avg, 8) }); }
    }
    if (xq > ZERO && (dec(pos.quantity) !== open || dec(pos.realizedPnl) !== pnl)) {
      const closing = open === ZERO;
      const exitOrders = (await listPaperOrders(db, o.userId, { decisionId: o.decision.id, limit: 100 })).filter((x) => x.purpose === "EXIT" && dec(x.filledQuantity) > ZERO);
      const reason = exitOrders.length ? (exitOrders[exitOrders.length - 1] as PaperOrderRow).exitReason ?? "EXIT" : "EXIT";
      await updatePositionExit(db, o.userId, pos.id, { quantity: str(open, 8), realizedPnl: str(pnl, 2), realizedCosts: str(costs, 2), close: closing ? { reason, at: t } : null });
      await addPositionEvent(db, o.userId, pos.id, closing ? "CLOSED" : "PARTIAL_EXIT", { openQuantity: str(open, 8), realizedPnl: str(pnl, 2), realizedCosts: str(costs, 2), reason });
      if (closing) {
        const net = pnl - costs, risk = mul(abs0(dec(pos.avgEntryPrice) - dec(pos.initialStop)), dec(pos.initialQuantity), "up");
        await recordPaperOutcome(db, o.userId, { accountId: pos.accountId, decisionId: pos.decisionId, positionId: pos.id, instrument: pos.instrument, side: pos.side, quantity: pos.initialQuantity, entryPrice: str(avg, 8), exitPrice: str(div(dec(tot.exitValue), xq, "down"), 8), pnl: str(net, 2), rMultiple: risk > ZERO ? str(div(net, risk, "down"), 2) : null, exitReason: reason, openedAt: pos.openedAt, closedAt: t });
      }
    }
  }
  return getPositionForDecision(db, o.userId, o.decision.id);
}
const abs0 = (a: Dec): Dec => (a < ZERO ? -a : a);
