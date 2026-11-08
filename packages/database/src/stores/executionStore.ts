import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { withUser } from "../withUser";

/**
 * Persistence for paper execution and trade management (Stage 07). Orders, fills and positions are separate tables; the database guards (migration 0038) enforce the lifecycle, the decision link, the permitted size and
 * that a stop can only tighten. All amounts travel as decimal STRINGS: nothing here converts money to a binary float.
 */
type X = Pick<Db, "execute">;
const x = (tx: unknown): X => tx as X;
const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;
const d = (v: unknown): Date => new Date(v as string);

export interface ExecutionRequestRow { id: string; decisionId: string; accountId: string; mode: string; state: string; idempotencyKey: string; checks: unknown; refusalReasons: unknown }
const reqOf = (r: Record<string, unknown>): ExecutionRequestRow => ({ id: r["id"] as string, decisionId: r["decision_id"] as string, accountId: r["account_id"] as string, mode: r["mode"] as string, state: r["state"] as string, idempotencyKey: r["idempotency_key"] as string, checks: r["checks"], refusalReasons: r["refusal_reasons"] });
/** Idempotent: the same key, or the same (decision, mode), returns the existing request and `created: false`. A retry can never create a second request. */
export async function createExecutionRequest(db: Pick<Db, "transaction">, userId: string, q: { accountId: string; decisionId: string; mode: string; idempotencyKey: string; state: "REQUESTED" | "REJECTED"; checks: unknown; refusalReasons: unknown }): Promise<{ request: ExecutionRequestRow; created: boolean }> {
  return withUser(db, userId, async (tx) => {
    const ins = await x(tx).execute(sql`insert into execution_requests (id, user_id, account_id, decision_id, mode, state, idempotency_key, checks, refusal_reasons) values (gen_random_uuid(), ${userId}::uuid, ${q.accountId}::uuid, ${q.decisionId}::uuid, ${q.mode}, ${q.state}, ${q.idempotencyKey}, ${JSON.stringify(q.checks)}::jsonb, ${JSON.stringify(q.refusalReasons)}::jsonb) on conflict do nothing returning *`);
    if (ins.rows[0]) return { request: reqOf(row(ins.rows[0])), created: true };
    const ex = await x(tx).execute(sql`select * from execution_requests where user_id = ${userId}::uuid and ((decision_id = ${q.decisionId}::uuid and mode = ${q.mode}) or idempotency_key = ${q.idempotencyKey}) limit 1`);
    if (!ex.rows[0]) throw new Error("the execution request vanished");
    return { request: reqOf(row(ex.rows[0])), created: false };
  });
}
export async function getExecutionRequest(db: Pick<Db, "transaction">, userId: string, decisionId: string, mode: string): Promise<ExecutionRequestRow | null> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select * from execution_requests where user_id = ${userId}::uuid and decision_id = ${decisionId}::uuid and mode = ${mode}`); return r.rows[0] ? reqOf(row(r.rows[0])) : null; });
}
export async function updateExecutionRequest(db: Pick<Db, "transaction">, userId: string, id: string, state: "ELIGIBLE" | "REJECTED" | "COMPLETED" | "FAILED", checks: unknown, refusalReasons: unknown): Promise<void> {
  await withUser(db, userId, async (tx) => { await x(tx).execute(sql`update execution_requests set state = ${state}, checks = ${JSON.stringify(checks)}::jsonb, refusal_reasons = ${JSON.stringify(refusalReasons)}::jsonb, updated_at = now() where id = ${id}::uuid`); });
}

export interface PaperOrderRow { id: string; decisionId: string; accountId: string; positionId: string | null; purpose: "ENTRY" | "EXIT"; exitReason: string | null; instrument: string; exchange: string; side: "BUY" | "SELL"; orderType: string; quantity: string; limitPrice: string | null; filledQuantity: string; avgFillPrice: string | null; status: string; stateReason: string | null; createdAt: Date }
const ordOf = (r: Record<string, unknown>): PaperOrderRow => ({ id: r["id"] as string, decisionId: r["decision_id"] as string, accountId: r["account_id"] as string, positionId: (r["position_id"] ?? null) as string | null, purpose: r["purpose"] as "ENTRY" | "EXIT", exitReason: (r["exit_reason"] ?? null) as string | null, instrument: r["instrument"] as string, exchange: r["exchange"] as string, side: r["side"] as "BUY" | "SELL", orderType: r["order_type"] as string, quantity: String(r["quantity"]), limitPrice: r["limit_price"] === null || r["limit_price"] === undefined ? null : String(r["limit_price"]), filledQuantity: String(r["filled_quantity"]), avgFillPrice: r["avg_fill_price"] === null || r["avg_fill_price"] === undefined ? null : String(r["avg_fill_price"]), status: r["status"] as string, stateReason: (r["state_reason"] ?? null) as string | null, createdAt: d(r["created_at"]) });
/** Idempotent on (user, key): a retry of the same order request returns the stored order. */
export async function createPaperOrder(db: Pick<Db, "transaction">, userId: string, o: { accountId: string; decisionId: string; executionRequestId: string; positionId: string | null; purpose: "ENTRY" | "EXIT"; exitReason: string | null; instrument: string; exchange: string; side: "BUY" | "SELL"; orderType: "MARKET" | "LIMIT"; quantity: string; limitPrice: string | null; idempotencyKey: string }): Promise<{ order: PaperOrderRow; created: boolean }> {
  return withUser(db, userId, async (tx) => {
    const ex = await x(tx).execute(sql`select * from paper_orders where user_id = ${userId}::uuid and idempotency_key = ${o.idempotencyKey}`);
    if (ex.rows[0]) return { order: ordOf(row(ex.rows[0])), created: false };
    const r = await x(tx).execute(sql`insert into paper_orders (id, user_id, account_id, decision_id, execution_request_id, position_id, purpose, exit_reason, instrument, exchange, side, order_type, quantity, limit_price, idempotency_key) values (gen_random_uuid(), ${userId}::uuid, ${o.accountId}::uuid, ${o.decisionId}::uuid, ${o.executionRequestId}::uuid, ${o.positionId}::uuid, ${o.purpose}, ${o.exitReason}, ${o.instrument}, ${o.exchange}, ${o.side}, ${o.orderType}, ${o.quantity}::numeric, ${o.limitPrice}::numeric, ${o.idempotencyKey}) returning *`);
    return { order: ordOf(row(r.rows[0])), created: true };
  });
}
export async function setOrderStatus(db: Pick<Db, "transaction">, userId: string, id: string, status: "SUBMITTED" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "EXPIRED", reason: string | null): Promise<void> {
  await withUser(db, userId, async (tx) => { await x(tx).execute(sql`update paper_orders set status = ${status}, state_reason = ${reason}, updated_at = now() where id = ${id}::uuid`); });
}
export async function getPaperOrder(db: Pick<Db, "transaction">, userId: string, id: string): Promise<PaperOrderRow | null> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select * from paper_orders where user_id = ${userId}::uuid and id = ${id}::uuid`); return r.rows[0] ? ordOf(row(r.rows[0])) : null; });
}
export async function listPaperOrders(db: Pick<Db, "transaction">, userId: string, o: { decisionId?: string; statuses?: readonly string[]; limit: number }): Promise<PaperOrderRow[]> {
  return withUser(db, userId, async (tx) => {
    const dec = o.decisionId ? sql`and decision_id = ${o.decisionId}::uuid` : sql``, st = o.statuses?.length ? sql`and status in (${sql.join(o.statuses.map((s) => sql`${s}`), sql`, `)})` : sql``;
    const r = await x(tx).execute(sql`select * from paper_orders where user_id = ${userId}::uuid ${dec} ${st} order by created_at, id limit ${Math.min(Math.max(o.limit, 1), 500)}`); return r.rows.map((q) => ordOf(row(q)));
  });
}
/** Appends a fill. The database applies it to the order (filled quantity, average price, status) and refuses it if it exceeds the remaining quantity or breaks a limit price. */
export async function insertPaperFill(db: Pick<Db, "transaction">, userId: string, f: { orderId: string; quantity: string; price: string; costs: string; priceSource: "FIXTURE" | "LIVE" | "HISTORICAL"; priceAsOf: Date }): Promise<string> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`insert into paper_fills (id, user_id, order_id, quantity, price, costs, price_source, price_as_of) values (gen_random_uuid(), ${userId}::uuid, ${f.orderId}::uuid, ${f.quantity}::numeric, ${f.price}::numeric, ${f.costs}::numeric, ${f.priceSource}, ${f.priceAsOf.toISOString()}::timestamptz) returning id`); return (r.rows[0] as { id: string }).id; });
}
export async function listPaperFills(db: Pick<Db, "transaction">, userId: string, orderId: string): Promise<Array<{ id: string; quantity: string; price: string; costs: string; priceSource: string; filledAt: Date }>> {
  return withUser(db, userId, async (tx) => (await x(tx).execute(sql`select * from paper_fills where user_id = ${userId}::uuid and order_id = ${orderId}::uuid order by filled_at, id`)).rows.map((q) => { const w = row(q); return { id: w["id"] as string, quantity: String(w["quantity"]), price: String(w["price"]), costs: String(w["costs"]), priceSource: w["price_source"] as string, filledAt: d(w["filled_at"]) }; }));
}

export interface PaperPositionRow { id: string; userId: string; accountId: string; decisionId: string; instrument: string; exchange: string; side: "BUY" | "SELL"; quantity: string; initialQuantity: string; avgEntryPrice: string; initialStop: string; stopLoss: string; targets: string[]; rules: Record<string, unknown>; realizedPnl: string; realizedCosts: string; status: "OPEN" | "CLOSED"; exitReason: string | null; openedAt: Date; closedAt: Date | null }
const posOf = (r: Record<string, unknown>): PaperPositionRow => ({ id: r["id"] as string, userId: r["user_id"] as string, accountId: r["account_id"] as string, decisionId: r["decision_id"] as string, instrument: r["instrument"] as string, exchange: r["exchange"] as string, side: r["side"] as "BUY" | "SELL", quantity: String(r["quantity"]), initialQuantity: String(r["initial_quantity"]), avgEntryPrice: String(r["avg_entry_price"]), initialStop: String(r["initial_stop"]), stopLoss: String(r["stop_loss"]), targets: ((r["targets"] ?? []) as unknown[]).map(String), rules: (r["rules"] ?? {}) as Record<string, unknown>, realizedPnl: String(r["realized_pnl"]), realizedCosts: String(r["realized_costs"]), status: r["status"] as "OPEN" | "CLOSED", exitReason: (r["exit_reason"] ?? null) as string | null, openedAt: d(r["opened_at"]), closedAt: r["closed_at"] ? d(r["closed_at"]) : null });
export async function createPaperPosition(db: Pick<Db, "transaction">, userId: string, p: { accountId: string; decisionId: string; instrument: string; exchange: string; side: "BUY" | "SELL"; quantity: string; initialQuantity: string; avgEntryPrice: string; stopLoss: string; targets: readonly string[]; rules: unknown }): Promise<PaperPositionRow> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`insert into paper_positions (id, user_id, account_id, decision_id, instrument, exchange, side, quantity, initial_quantity, avg_entry_price, initial_stop, stop_loss, targets, rules) values (gen_random_uuid(), ${userId}::uuid, ${p.accountId}::uuid, ${p.decisionId}::uuid, ${p.instrument}, ${p.exchange}, ${p.side}, ${p.quantity}::numeric, ${p.initialQuantity}::numeric, ${p.avgEntryPrice}::numeric, ${p.stopLoss}::numeric, ${p.stopLoss}::numeric, ${JSON.stringify(p.targets)}::jsonb, ${JSON.stringify(p.rules)}::jsonb) returning *`); return posOf(row(r.rows[0])); });
}
export async function getPaperPosition(db: Pick<Db, "transaction">, userId: string, id: string): Promise<PaperPositionRow | null> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select * from paper_positions where user_id = ${userId}::uuid and id = ${id}::uuid`); return r.rows[0] ? posOf(row(r.rows[0])) : null; });
}
export async function getPositionForDecision(db: Pick<Db, "transaction">, userId: string, decisionId: string): Promise<PaperPositionRow | null> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select * from paper_positions where user_id = ${userId}::uuid and decision_id = ${decisionId}::uuid`); return r.rows[0] ? posOf(row(r.rows[0])) : null; });
}
export async function listPaperPositions(db: Pick<Db, "transaction">, userId: string, o: { status?: "OPEN" | "CLOSED"; limit: number }): Promise<PaperPositionRow[]> {
  return withUser(db, userId, async (tx) => { const st = o.status ? sql`and status = ${o.status}` : sql``; return (await x(tx).execute(sql`select * from paper_positions where user_id = ${userId}::uuid ${st} order by opened_at, id limit ${Math.min(Math.max(o.limit, 1), 500)}`)).rows.map((q) => posOf(row(q))); });
}
/** Entry fill applied to the position: new open quantity and weighted average (computed by the caller in decimals). */
export async function updatePositionEntry(db: Pick<Db, "transaction">, userId: string, id: string, quantity: string, avgEntryPrice: string): Promise<void> {
  await withUser(db, userId, async (tx) => { await x(tx).execute(sql`update paper_positions set quantity = ${quantity}::numeric, avg_entry_price = ${avgEntryPrice}::numeric, updated_at = now() where id = ${id}::uuid and status = 'OPEN'`); });
}
export async function updatePositionExit(db: Pick<Db, "transaction">, userId: string, id: string, p: { quantity: string; realizedPnl: string; realizedCosts: string; close: { reason: string; at: Date } | null }): Promise<void> {
  await withUser(db, userId, async (tx) => {
    if (p.close) await x(tx).execute(sql`update paper_positions set quantity = 0, realized_pnl = ${p.realizedPnl}::numeric, realized_costs = ${p.realizedCosts}::numeric, status = 'CLOSED', exit_reason = ${p.close.reason}, closed_at = ${p.close.at.toISOString()}::timestamptz, updated_at = now() where id = ${id}::uuid and status = 'OPEN'`);
    else await x(tx).execute(sql`update paper_positions set quantity = ${p.quantity}::numeric, realized_pnl = ${p.realizedPnl}::numeric, realized_costs = ${p.realizedCosts}::numeric, updated_at = now() where id = ${id}::uuid and status = 'OPEN'`);
  });
}
/** Tightens the stop. The database refuses a looser one. */
export async function moveStopLoss(db: Pick<Db, "transaction">, userId: string, id: string, stopLoss: string): Promise<void> {
  await withUser(db, userId, async (tx) => { await x(tx).execute(sql`update paper_positions set stop_loss = ${stopLoss}::numeric, updated_at = now() where id = ${id}::uuid and status = 'OPEN'`); });
}
export async function addPositionEvent(db: Pick<Db, "transaction">, userId: string, positionId: string, kind: string, payload: unknown): Promise<void> {
  await withUser(db, userId, async (tx) => { await x(tx).execute(sql`insert into paper_position_events (id, user_id, position_id, kind, payload) values (gen_random_uuid(), ${userId}::uuid, ${positionId}::uuid, ${kind}, ${JSON.stringify(payload)}::jsonb)`); });
}
export async function listPositionEvents(db: Pick<Db, "transaction">, userId: string, positionId: string): Promise<Array<{ kind: string; payload: unknown; at: Date }>> {
  return withUser(db, userId, async (tx) => (await x(tx).execute(sql`select kind, payload, at from paper_position_events where user_id = ${userId}::uuid and position_id = ${positionId}::uuid order by at, id`)).rows.map((q) => { const w = row(q); return { kind: w["kind"] as string, payload: w["payload"], at: d(w["at"]) }; }));
}
export async function addMonitoringEvent(db: Pick<Db, "transaction">, userId: string, e: { accountId: string; decisionId: string | null; kind: string; payload: unknown }): Promise<void> {
  await withUser(db, userId, async (tx) => { await x(tx).execute(sql`insert into trade_monitoring_events (id, user_id, account_id, decision_id, mode, kind, payload) values (gen_random_uuid(), ${userId}::uuid, ${e.accountId}::uuid, ${e.decisionId}::uuid, 'PAPER', ${e.kind}, ${JSON.stringify(e.payload)}::jsonb)`); });
}
export async function recordPaperOutcome(db: Pick<Db, "transaction">, userId: string, o: { accountId: string; decisionId: string; positionId: string; instrument: string; side: "BUY" | "SELL"; quantity: string; entryPrice: string; exitPrice: string; pnl: string; rMultiple: string | null; exitReason: string; openedAt: Date; closedAt: Date }): Promise<void> {
  await withUser(db, userId, async (tx) => { await x(tx).execute(sql`insert into trade_outcomes (id, user_id, account_id, decision_id, mode, paper_position_id, instrument, side, quantity, entry_price, exit_price, pnl, r_multiple, exit_reason, opened_at, closed_at) values (gen_random_uuid(), ${userId}::uuid, ${o.accountId}::uuid, ${o.decisionId}::uuid, 'PAPER', ${o.positionId}::uuid, ${o.instrument}, ${o.side}, ${o.quantity}::numeric, ${o.entryPrice}::numeric, ${o.exitPrice}::numeric, ${o.pnl}::numeric, ${o.rMultiple}::numeric, ${o.exitReason}, ${o.openedAt.toISOString()}::timestamptz, ${o.closedAt.toISOString()}::timestamptz) on conflict do nothing`); });
}
/** Fills grouped by purpose for a position's decision: the figures reconciliation compares with the position. */
export async function fillTotalsForDecision(db: Pick<Db, "transaction">, userId: string, decisionId: string): Promise<{ entryQty: string; entryValue: string; exitQty: string; exitValue: string; costs: string }> {
  return withUser(db, userId, async (tx) => {
    const r = await x(tx).execute(sql`select coalesce(sum(case when o.purpose = 'ENTRY' then f.quantity end), 0) eq, coalesce(sum(case when o.purpose = 'ENTRY' then f.quantity * f.price end), 0) ev, coalesce(sum(case when o.purpose = 'EXIT' then f.quantity end), 0) xq, coalesce(sum(case when o.purpose = 'EXIT' then f.quantity * f.price end), 0) xv, coalesce(sum(f.costs), 0) c
      from paper_fills f join paper_orders o on o.id = f.order_id and o.user_id = f.user_id where o.user_id = ${userId}::uuid and o.decision_id = ${decisionId}::uuid`);
    const w = row(r.rows[0]); return { entryQty: String(w["eq"]), entryValue: String(w["ev"]), exitQty: String(w["xq"]), exitValue: String(w["xv"]), costs: String(w["c"]) };
  });
}

/** The PAPER portfolio of one account, derived from the paper tables only (open positions at their average entry and CURRENT stop; net realised result of positions closed since `since`). Paper figures never include real broker state. */
export async function paperPortfolioFacts(db: Pick<Db, "transaction">, userId: string, accountId: string, since: Date): Promise<{ open: Array<{ instrument: string; side: "BUY" | "SELL"; quantity: string; avgEntryPrice: string; stopLoss: string }>; realizedNetSince: string }> {
  return withUser(db, userId, async (tx) => {
    const o = await x(tx).execute(sql`select instrument, side, quantity, avg_entry_price, stop_loss from paper_positions where user_id = ${userId}::uuid and account_id = ${accountId}::uuid and status = 'OPEN'`);
    const r = await x(tx).execute(sql`select coalesce(sum(pnl), 0) as p from trade_outcomes where user_id = ${userId}::uuid and account_id = ${accountId}::uuid and mode = 'PAPER' and closed_at >= ${since.toISOString()}::timestamptz`);
    return { open: o.rows.map((q) => { const w = row(q); return { instrument: w["instrument"] as string, side: w["side"] as "BUY" | "SELL", quantity: String(w["quantity"]), avgEntryPrice: String(w["avg_entry_price"]), stopLoss: String(w["stop_loss"]) }; }), realizedNetSince: String(row(r.rows[0])["p"]) };
  });
}
