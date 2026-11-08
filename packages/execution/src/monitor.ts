import { addMonitoringEvent, addPositionEvent, createPaperOrder, fillTotalsForDecision, getCandidate, getDecision, getExecutionRequest, getPaperOrder, listActiveAccounts, listPaperOrders, listPaperPositions, moveStopLoss, setOrderStatus, type PaperPositionRow } from "@twins/database";
import { dec, div, str, ZERO, type FeeSchedule } from "@twins/planning";
import { fillOrder, syncPosition, type AlertEvent, type ExecutionDeps } from "./execute";
import { evaluatePosition, unrealizedPnl, type PositionAction, type PositionRules } from "./position";
import { freshPrice } from "./prices";

/**
 * Trade management and monitoring (Module 14). For each open paper position: observe a FRESH price through the explicit provider, ask the pure rules what is required, and act. A missing or stale price is recorded and escalated
 * as monitoring UNAVAILABLE, never as a successful check. Exits are never blocked by the kill switch or by an expired / invalidated decision (reducing risk is always allowed); only new entries are. A stop can only tighten, each move
 * is validated by the mandatory stop-loss rule against the current price, and the database refuses a looser one. Everything is paper: results are tagged PAPER everywhere and never mixed with real broker results.
 */
export interface MonitorReport { positions: number; monitored: number; unmonitored: number; exits: number; stopMoves: number; breaches: number; alerts: number; reconciled: number; mismatches: number; closed: number }
const rulesOf = (p: PaperPositionRow): PositionRules & { plannedMaxLoss?: string | null } => p.rules as unknown as PositionRules & { plannedMaxLoss?: string | null };
const MON_KIND: Record<string, string> = { STOP_HIT: "STOP_HIT", TARGET_HIT: "TARGET_HIT", TIME_EXIT: "TIME_EXIT", EXPIRY_EXIT: "EXPIRY_EXIT" };

export async function monitorPositions(d: ExecutionDeps): Promise<MonitorReport> {
  const db = d.eval.db, t = (d.eval.now ?? (() => new Date()))(), r: MonitorReport = { positions: 0, monitored: 0, unmonitored: 0, exits: 0, stopMoves: 0, breaches: 0, alerts: 0, reconciled: 0, mismatches: 0, closed: 0 };
  const alert = (a: AlertEvent): void => { r.alerts++; d.alert?.(a); };
  const users = [...new Set((await listActiveAccounts(db)).map((a) => a.userId))];
  for (const userId of users) {
    for (const pos of await listPaperPositions(db, userId, { status: "OPEN", limit: 200 })) {
      r.positions++;
      try {
        const rules = rulesOf(pos), base = { exchange: pos.exchange, symbol: pos.instrument };
        const px = await freshPrice(d.prices, base, t, d.config.maxPriceAgeSeconds);
        if (!px.ok) {
          r.unmonitored++;
          await addPositionEvent(db, userId, pos.id, "PRICE_UNAVAILABLE", { reason: px.reason, provider: px.provider, ageSeconds: px.ageSeconds });
          await addMonitoringEvent(db, userId, { accountId: pos.accountId, decisionId: pos.decisionId, kind: "PRICE_UNAVAILABLE", payload: { reason: px.reason, provider: px.provider } });
          alert({ kind: "MONITORING_UNAVAILABLE", severity: "WARNING", userId, accountId: pos.accountId, positionId: pos.id, decisionId: pos.decisionId, dedupeKey: `mon-unavailable:${pos.id}:${Math.floor(t.getTime() / 600_000)}`, detail: `no usable price for ${pos.instrument} (${px.reason}); the position is NOT being monitored` });
          continue;
        }
        r.monitored++;
        const price = dec(px.price);
        const actions: PositionAction[] = evaluatePosition({ side: pos.side, quantity: dec(pos.quantity), initialQuantity: dec(pos.initialQuantity), avgEntry: dec(pos.avgEntryPrice), initialStop: dec(pos.initialStop), stop: dec(pos.stopLoss), targets: pos.targets.map((x) => dec(x)), openedAt: pos.openedAt, plannedMaxLoss: rules.plannedMaxLoss ? dec(rules.plannedMaxLoss) : null }, price, t, rules);
        for (const a of actions) {
          if (a.kind === "RISK_BREACH") { r.breaches++; await addPositionEvent(db, userId, pos.id, "RISK_BREACH", { detail: a.detail, price: px.price }); await addMonitoringEvent(db, userId, { accountId: pos.accountId, decisionId: pos.decisionId, kind: "RISK_BREACH", payload: { detail: a.detail } }); alert({ kind: "RISK_BREACH", severity: "CRITICAL", userId, accountId: pos.accountId, positionId: pos.id, decisionId: pos.decisionId, dedupeKey: `risk-breach:${pos.id}:${Math.floor(t.getTime() / 600_000)}`, detail: a.detail }); }
          else if (a.kind === "STOP_MOVE_REFUSED") { await addMonitoringEvent(db, userId, { accountId: pos.accountId, decisionId: pos.decisionId, kind: "ALERT", payload: { note: "stop move refused by the mandatory stop-loss rule", proposed: str(a.proposed, 4), reason: a.reason } }); }
          else if (a.kind === "MOVE_STOP") { await moveStopLoss(db, userId, pos.id, str(a.stop, 8)); r.stopMoves++; await addPositionEvent(db, userId, pos.id, "STOP_MOVED", { from: pos.stopLoss, to: str(a.stop, 8), reason: a.reason, price: px.price }); await addMonitoringEvent(db, userId, { accountId: pos.accountId, decisionId: pos.decisionId, kind: a.reason === "TRAIL" ? "TRAIL_MOVED" : "STOP_MOVED", payload: { from: pos.stopLoss, to: str(a.stop, 8) } }); }
          else if (a.kind === "EXIT") {
            const fees = rules.fees as FeeSchedule | null;
            if (!fees) { alert({ kind: "EXIT_BLOCKED_NO_FEES", severity: "CRITICAL", userId, accountId: pos.accountId, positionId: pos.id, decisionId: pos.decisionId, dedupeKey: `exit-nofees:${pos.id}`, detail: "an exit is required but the position carries no fee schedule" }); continue; }
            const rq = await getExecutionRequest(db, userId, pos.decisionId, "PAPER"); if (!rq) continue;
            const key = `exit:${pos.id}:${a.reason}:${a.targetIndex ?? "all"}:${str(dec(pos.quantity), 8)}`; // the same remaining quantity and reason is the same order: a retry cannot double-exit
            const { order } = await createPaperOrder(db, userId, { accountId: pos.accountId, decisionId: pos.decisionId, executionRequestId: rq.id, positionId: pos.id, purpose: "EXIT", exitReason: a.reason, instrument: pos.instrument, exchange: pos.exchange, side: pos.side === "BUY" ? "SELL" : "BUY", orderType: "MARKET", quantity: str(a.quantity, 8), limitPrice: null, idempotencyKey: key });
            if (order.status === "PROPOSED") await setOrderStatus(db, userId, order.id, "SUBMITTED", "exit submitted (simulated)");
            if ((await getPaperOrder(db, userId, order.id))?.status === "SUBMITTED") await setOrderStatus(db, userId, order.id, "ACCEPTED", "exit acknowledged (simulated)");
            const dec1 = await getDecision(db, userId, pos.decisionId); if (!dec1) continue;
            const res = await fillOrder(d, { userId, orderId: order.id, fees, lotSize: rules.lotSize, decision: dec1, rules });
            r.exits++;
            await addMonitoringEvent(db, userId, { accountId: pos.accountId, decisionId: pos.decisionId, kind: MON_KIND[a.reason] ?? "ALERT", payload: { reason: a.reason, detail: a.detail, quantity: str(a.quantity, 8), orderStatus: res.status } });
            if (a.reason === "TARGET_HIT") await addPositionEvent(db, userId, pos.id, "TARGET_HIT", { detail: a.detail });
            else await addPositionEvent(db, userId, pos.id, a.reason === "STOP_HIT" ? "STOP_HIT" : a.reason === "TIME_EXIT" ? "TIME_EXIT" : "EXPIRY_EXIT", { detail: a.detail, price: px.price });
            if (a.reason === "STOP_HIT") alert({ kind: "STOP_HIT", severity: "WARNING", userId, accountId: pos.accountId, positionId: pos.id, decisionId: pos.decisionId, dedupeKey: `stop-hit:${pos.id}`, detail: `${pos.instrument} paper position stopped out near ${px.price}` });
            if (res.status === "FILLED") { const after = await syncPosition(d, { userId, decision: dec1, rules }); if (after?.status === "CLOSED") r.closed++; }
          }
        }
        const rec = await reconcilePosition(d, userId, pos.id); if (rec) { r.reconciled++; if (!rec.ok) { r.mismatches++; alert({ kind: "RECONCILIATION_MISMATCH", severity: "CRITICAL", userId, accountId: pos.accountId, positionId: pos.id, decisionId: pos.decisionId, dedupeKey: `recon:${pos.id}:${Math.floor(t.getTime() / 600_000)}`, detail: rec.differences.join("; ") }); } }
      } catch (e) { d.log?.("management.position_failed", { positionId: pos.id, errorName: e instanceof Error ? e.name : "Error" }); }
    }
  }
  return r;
}

/** Compares the position with its fills and orders. A difference is recorded as RECONCILIATION_MISMATCH (and escalated by the caller); an agreement as RECONCILED. With `repair`, the position is re-derived from the fills. */
export async function reconcilePosition(d: ExecutionDeps, userId: string, positionId: string, o: { repair?: boolean } = {}): Promise<{ ok: boolean; differences: string[] } | null> {
  const db = d.eval.db;
  const pos = (await listPaperPositions(db, userId, { limit: 500 })).find((p) => p.id === positionId);
  if (!pos) return null;
  const tot = await fillTotalsForDecision(db, userId, pos.decisionId), diffs: string[] = [];
  const eq = dec(tot.entryQty), xq = dec(tot.exitQty), open = eq - xq;
  if (dec(pos.quantity) !== open) diffs.push(`open quantity ${pos.quantity} != entry ${str(eq, 8)} - exit ${str(xq, 8)}`);
  if (eq > ZERO && dec(pos.avgEntryPrice) !== div(dec(tot.entryValue), eq, "up")) diffs.push(`average entry ${pos.avgEntryPrice} != fills ${str(div(dec(tot.entryValue), eq, "up"), 8)}`);
  if (open < ZERO) diffs.push("exit fills exceed entry fills");
  if (diffs.length && o.repair) { const dec1 = await getDecision(db, userId, pos.decisionId); if (dec1) await syncPosition(d, { userId, decision: dec1, rules: rulesOf(pos) }); }
  await addPositionEvent(db, userId, pos.id, diffs.length ? "RECONCILIATION_MISMATCH" : "RECONCILED", { differences: diffs, repaired: !!o.repair && diffs.length > 0 });
  if (diffs.length) await addMonitoringEvent(db, userId, { accountId: pos.accountId, decisionId: pos.decisionId, kind: "RECONCILIATION_MISMATCH", payload: { differences: diffs } });
  return { ok: diffs.length === 0, differences: diffs };
}

/** Advances open entry orders: fills at a fresh price when one exists, cancels entries whose decision was invalidated, expires orders past their time-to-live (a partial fill keeps the position it created). */
export async function advanceOpenOrders(d: ExecutionDeps): Promise<{ examined: number; filled: number; expired: number; cancelled: number; waiting: number }> {
  const db = d.eval.db, t = (d.eval.now ?? (() => new Date()))(), r = { examined: 0, filled: 0, expired: 0, cancelled: 0, waiting: 0 };
  for (const userId of [...new Set((await listActiveAccounts(db)).map((a) => a.userId))]) {
    for (const order of await listPaperOrders(db, userId, { statuses: ["ACCEPTED", "PARTIALLY_FILLED"], limit: 200 })) {
      r.examined++;
      const dec1 = await getDecision(db, userId, order.decisionId); if (!dec1) continue;
      if (order.purpose === "ENTRY" && dec1.invalidated) { await setOrderStatus(db, userId, order.id, "CANCELLED", `decision invalidated: ${dec1.invalidated.reasonCode}`); r.cancelled++; await syncIfFilled(d, userId, dec1, order.id); continue; }
      if (t.getTime() - order.createdAt.getTime() > d.config.orderTtlMinutes * 60_000) { await setOrderStatus(db, userId, order.id, "EXPIRED", "order time-to-live passed"); r.expired++; await syncIfFilled(d, userId, dec1, order.id); continue; }
      const cand = await getCandidate(db, dec1.candidateId); const rq = await getExecutionRequest(db, userId, dec1.id, "PAPER");
      const pos = await listPaperPositions(db, userId, { limit: 500 }).then((x) => x.find((p) => p.decisionId === dec1.id));
      const fees = (pos ? (rulesOf(pos).fees as FeeSchedule | null) : null) ?? (cand && d.eval.specs ? await (async () => { const sp = await d.eval.specs!.instrument({ exchange: cand.exchange, underlying: cand.underlying, instrumentType: cand.strike !== null && cand.optionType !== null ? "option" : "equity", at: t }).catch(() => null); return sp ? d.eval.specs!.fees({ segment: sp.segment, at: t }).catch(() => null) : null; })() : null);
      if (!fees || !cand || !rq) { r.waiting++; continue; }
      const lot = pos ? rulesOf(pos).lotSize : (await d.eval.specs?.instrument({ exchange: cand.exchange, underlying: cand.underlying, instrumentType: cand.strike !== null && cand.optionType !== null ? "option" : "equity", at: t }).catch(() => null))?.lotSize;
      if (!lot) { r.waiting++; continue; }
      const rules = pos ? rulesOf(pos) : ({ ...(await import("./position")).DEFAULT_RULES_BASE, ladder: d.config.ladder, trailAfterR: d.config.trailAfterR, sessionCloseExitMinutes: d.config.sessionCloseExitMinutes, instrumentKind: cand.strike !== null && cand.optionType !== null ? "option" : "equity", stopBasis: cand.strike !== null && cand.optionType !== null ? "premium" : "price", lotSize: lot, expiry: cand.expiry, fees } as PositionRules);
      const res = await fillOrder(d, { userId, orderId: order.id, fees, lotSize: lot, decision: dec1, rules });
      if (res.status === "FILLED") r.filled++; else r.waiting++;
    }
  }
  return r;
}
async function syncIfFilled(d: ExecutionDeps, userId: string, dec1: NonNullable<Awaited<ReturnType<typeof getDecision>>>, orderId: string): Promise<void> {
  const o = await getPaperOrder(d.eval.db, userId, orderId);
  if (o && dec(o.filledQuantity) > ZERO) { const pos = await listPaperPositions(d.eval.db, userId, { limit: 500 }).then((x) => x.find((p) => p.decisionId === dec1.id)); if (pos) await syncPosition(d, { userId, decision: dec1, rules: rulesOf(pos) }); }
}
/** Mark-to-market view of a position for display (never stored): unrealised P&L at a given price. */
export const markToMarket = (p: PaperPositionRow, price: number): { unrealizedPnl: string } => ({ unrealizedPnl: str(unrealizedPnl(p.side, dec(p.avgEntryPrice), dec(p.quantity), dec(price))) });
