import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { accounts } from "./accounts";
import { userDecisions } from "./userDecisions";
import { users } from "./users";

/**
 * Human approval, execution and trade management (Master Build Stage 07, Modules 12-14). Every table is owner-tied (account, user), protected by row-level security, and keeps ORDERS, FILLS and POSITIONS in separate tables.
 * Paper tables are named paper_*: a paper result can never be mistaken for, or summed with, a real broker result (those live in orders / fills / positions, which no code here writes).
 */
export const APPROVAL_ACTIONS = ["APPROVE", "REJECT"] as const;
/** The only door to APPROVED / REJECTED: written by twins_record_decision_approval, never directly. One row per decision (a duplicate action is refused by the unique key). */
export const decisionApprovals = pgTable("decision_approvals", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  decisionId: uuid("decision_id").notNull(),
  action: text("action").notNull(),
  approverUserId: uuid("approver_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  permissionMode: text("permission_mode").notNull(),
  /** The fresh risk / stop-loss / candidate re-check made immediately before this action, with its verdicts. An APPROVE needs revalidation.passed = true. */
  revalidation: jsonb("revalidation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  reason: text("reason"),
  createdAt: createdAtColumn(),
}, (t) => ({
  decisionFk: foreignKey({ name: "decision_approvals_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  onePerDecision: uniqueIndex("decision_approvals_decision_unique").on(t.decisionId),
  keyUnique: uniqueIndex("decision_approvals_key_unique").on(t.userId, t.idempotencyKey),
  actionCheck: check("decision_approvals_action_check", oneOf(t.action, APPROVAL_ACTIONS)),
  ownerOnlyCheck: check("decision_approvals_owner_check", sql`${t.approverUserId} = ${t.userId}`),
  paperOnlyCheck: check("decision_approvals_mode_check", sql`${t.permissionMode} = 'PAPER'`),
  revalidationCheck: check("decision_approvals_revalidation_check", sql`${t.action} <> 'APPROVE' or (${t.revalidation}->>'passed') = 'true'`),
  userIdx: index("decision_approvals_user_idx").on(t.userId, t.createdAt),
  idUserUnique: uniqueIndex("decision_approvals_id_user_unique").on(t.id, t.userId),
}));

/** An approved decision whose underlying risk / stop / candidate / market basis later failed. Append-only; execution refuses a decision that has a row here. */
export const decisionInvalidations = pgTable("decision_invalidations", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  decisionId: uuid("decision_id").notNull(),
  reasonCode: text("reason_code").notNull(),
  detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  decisionFk: foreignKey({ name: "decision_invalidations_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  oneEach: uniqueIndex("decision_invalidations_decision_unique").on(t.decisionId),
}));

export const EXECUTION_REQUEST_STATES = ["REQUESTED", "ELIGIBLE", "REJECTED", "COMPLETED", "FAILED"] as const;
/** A request to execute an approved decision. Unique per (decision, mode) and per idempotency key: a retry returns the same request and can never make a second order. A live mode request can only ever be recorded as REJECTED. */
export const executionRequests = pgTable("execution_requests", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  decisionId: uuid("decision_id").notNull(),
  mode: text("mode").notNull(),
  state: text("state").notNull().default("REQUESTED"),
  idempotencyKey: text("idempotency_key").notNull(),
  /** Every independent check with its result (ownership, permission, decision, approval, risk, stop-loss, kill switch, market, duplicate, capital). */
  checks: jsonb("checks").notNull().default(sql`'[]'::jsonb`),
  refusalReasons: jsonb("refusal_reasons").notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  ownerFk: foreignKey({ name: "execution_requests_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  decisionFk: foreignKey({ name: "execution_requests_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  onePerDecisionMode: uniqueIndex("execution_requests_decision_mode_unique").on(t.decisionId, t.mode),
  keyUnique: uniqueIndex("execution_requests_key_unique").on(t.userId, t.idempotencyKey),
  idUserUnique: uniqueIndex("execution_requests_id_user_unique").on(t.id, t.userId),
  modeCheck: check("execution_requests_mode_check", oneOf(t.mode, ["PAPER", "ASSISTED_LIVE", "CONTROLLED_AUTO"])),
  stateCheck: check("execution_requests_state_check", oneOf(t.state, EXECUTION_REQUEST_STATES)),
  liveNeverCheck: check("execution_requests_live_disabled_check", sql`${t.mode} = 'PAPER' or ${t.state} = 'REJECTED'`),
}));

export const PAPER_ORDER_STATES = ["PROPOSED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
export const paperOrders = pgTable("paper_orders", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  decisionId: uuid("decision_id").notNull(),
  executionRequestId: uuid("execution_request_id").notNull(),
  positionId: uuid("position_id"),
  mode: text("mode").notNull().default("PAPER"),
  /** ENTRY opens (or adds to) a position; EXIT reduces one. */
  purpose: text("purpose").notNull(),
  exitReason: text("exit_reason"),
  instrument: text("instrument").notNull(),
  exchange: text("exchange").notNull(),
  side: text("side").notNull(),
  orderType: text("order_type").notNull(),
  quantity: numeric("quantity").notNull(),
  limitPrice: numeric("limit_price"),
  filledQuantity: numeric("filled_quantity").notNull().default("0"),
  avgFillPrice: numeric("avg_fill_price"),
  status: text("status").notNull().default("PROPOSED"),
  stateReason: text("state_reason"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  ownerFk: foreignKey({ name: "paper_orders_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  decisionFk: foreignKey({ name: "paper_orders_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  requestFk: foreignKey({ name: "paper_orders_request_fk", columns: [t.executionRequestId, t.userId], foreignColumns: [executionRequests.id, executionRequests.userId] }),
  keyUnique: uniqueIndex("paper_orders_key_unique").on(t.userId, t.idempotencyKey),
  idUserUnique: uniqueIndex("paper_orders_id_user_unique").on(t.id, t.userId),
  decisionIdx: index("paper_orders_decision_idx").on(t.decisionId, t.status),
  statusCheck: check("paper_orders_status_check", oneOf(t.status, PAPER_ORDER_STATES)),
  modeCheck: check("paper_orders_mode_check", sql`${t.mode} = 'PAPER'`),
  purposeCheck: check("paper_orders_purpose_check", sql`(${t.purpose} = 'ENTRY' and ${t.exitReason} is null) or (${t.purpose} = 'EXIT' and ${t.exitReason} is not null and ${t.positionId} is not null)`),
  sideCheck: check("paper_orders_side_check", oneOf(t.side, ["BUY", "SELL"])),
  typeCheck: check("paper_orders_type_check", sql`(${t.orderType} = 'MARKET' and ${t.limitPrice} is null) or (${t.orderType} = 'LIMIT' and ${t.limitPrice} > 0)`),
  qtyCheck: check("paper_orders_qty_check", sql`${t.quantity} > 0 and ${t.filledQuantity} >= 0 and ${t.filledQuantity} <= ${t.quantity}`),
  fillStateCheck: check("paper_orders_fill_state_check", sql`(${t.status} <> 'FILLED' or ${t.filledQuantity} = ${t.quantity}) and (${t.status} <> 'PARTIALLY_FILLED' or (${t.filledQuantity} > 0 and ${t.filledQuantity} < ${t.quantity})) and (${t.status} not in ('PROPOSED', 'SUBMITTED', 'ACCEPTED') or ${t.filledQuantity} = 0)`),
}));

/** One simulated execution against a paper order. Append-only; a trigger applies it to the order (quantity, average price, status), so an order's fill state cannot drift from its fills. */
export const paperFills = pgTable("paper_fills", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  orderId: uuid("order_id").notNull(),
  quantity: numeric("quantity").notNull(),
  price: numeric("price").notNull(),
  costs: numeric("costs").notNull().default("0"),
  /** The price observation this fill was simulated from, and whether it was a fixture. */
  priceSource: text("price_source").notNull(),
  priceAsOf: timestamp("price_as_of", { withTimezone: true }).notNull(),
  filledAt: timestamp("filled_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orderFk: foreignKey({ name: "paper_fills_order_fk", columns: [t.orderId, t.userId], foreignColumns: [paperOrders.id, paperOrders.userId] }),
  idx: index("paper_fills_order_idx").on(t.orderId, t.filledAt),
  valueCheck: check("paper_fills_value_check", sql`${t.quantity} > 0 and ${t.price} > 0 and ${t.costs} >= 0`),
  sourceCheck: check("paper_fills_source_check", oneOf(t.priceSource, ["FIXTURE", "LIVE", "HISTORICAL"])),
}));

export const paperPositions = pgTable("paper_positions", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  decisionId: uuid("decision_id").notNull(),
  mode: text("mode").notNull().default("PAPER"),
  instrument: text("instrument").notNull(),
  exchange: text("exchange").notNull(),
  side: text("side").notNull(),
  /** Open quantity (0 once closed). The initial quantity and entry never change. */
  quantity: numeric("quantity").notNull(),
  initialQuantity: numeric("initial_quantity").notNull(),
  avgEntryPrice: numeric("avg_entry_price").notNull(),
  initialStop: numeric("initial_stop").notNull(),
  stopLoss: numeric("stop_loss").notNull(),
  targets: jsonb("targets").notNull(),
  /** Exit rules fixed when the position opened (target ladder shares, trailing, time exit, instrument expiry). */
  rules: jsonb("rules").notNull(),
  realizedPnl: numeric("realized_pnl").notNull().default("0"),
  realizedCosts: numeric("realized_costs").notNull().default("0"),
  status: text("status").notNull().default("OPEN"),
  exitReason: text("exit_reason"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (t) => ({
  ownerFk: foreignKey({ name: "paper_positions_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  decisionFk: foreignKey({ name: "paper_positions_decision_fk", columns: [t.decisionId, t.userId], foreignColumns: [userDecisions.id, userDecisions.userId] }),
  oneOpenPerDecision: uniqueIndex("paper_positions_decision_unique").on(t.decisionId),
  idUserUnique: uniqueIndex("paper_positions_id_user_unique").on(t.id, t.userId),
  openIdx: index("paper_positions_open_idx").on(t.status, t.userId),
  statusCheck: check("paper_positions_status_check", oneOf(t.status, ["OPEN", "CLOSED"])),
  modeCheck: check("paper_positions_mode_check", sql`${t.mode} = 'PAPER'`),
  sideCheck: check("paper_positions_side_check", oneOf(t.side, ["BUY", "SELL"])),
  qtyCheck: check("paper_positions_qty_check", sql`${t.quantity} >= 0 and ${t.initialQuantity} > 0 and ${t.avgEntryPrice} > 0 and ${t.stopLoss} > 0 and ${t.initialStop} > 0`),
  closedCheck: check("paper_positions_closed_check", sql`(${t.status} = 'OPEN' and ${t.quantity} > 0 and ${t.closedAt} is null and ${t.exitReason} is null) or (${t.status} = 'CLOSED' and ${t.quantity} = 0 and ${t.closedAt} is not null and ${t.exitReason} is not null)`),
}));
export const POSITION_EVENT_KINDS = ["OPENED", "ENTRY_FILL", "PARTIAL_EXIT", "CLOSED", "STOP_MOVED", "TARGET_HIT", "STOP_HIT", "TIME_EXIT", "EXPIRY_EXIT", "RISK_BREACH", "PRICE_UNAVAILABLE", "RECONCILED", "RECONCILIATION_MISMATCH"] as const;
export const paperPositionEvents = pgTable("paper_position_events", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  positionId: uuid("position_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  positionFk: foreignKey({ name: "paper_position_events_position_fk", columns: [t.positionId, t.userId], foreignColumns: [paperPositions.id, paperPositions.userId] }),
  idx: index("paper_position_events_position_idx").on(t.positionId, t.at),
  kindCheck: check("paper_position_events_kind_check", oneOf(t.kind, POSITION_EVENT_KINDS)),
}));
