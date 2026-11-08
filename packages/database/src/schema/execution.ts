import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { orderSideEnum, orderStatusEnum, tradingModeEnum } from "./enums";
import { accounts } from "./accounts";
import { instruments } from "./instruments";
import { riskDecisions } from "./riskDecisions";

/**
 * An order (spec section 32). `riskDecisionId` is nullable only because a
 * manual/administrative order may exist outside the signal pipeline, but
 * any order originating from a decision MUST reference an *approved*
 * risk_decisions row - there is no path from a signal/decision straight to
 * an order (spec sections 26/29/31/32 - "No shortcut").
 *
 * `idempotencyKey` prevents a network retry from creating a duplicate
 * order (spec section 33).
 */
export const orders = pgTable(
  "orders",
  {
    id: idColumn(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "restrict" }),
    riskDecisionId: uuid("risk_decision_id").references(
      () => riskDecisions.id,
      { onDelete: "restrict" },
    ),
    tradingMode: tradingModeEnum("trading_mode").notNull(),
    side: orderSideEnum("side").notNull(),
    orderType: text("order_type").notNull(), // market | limit | sl | sl-m
    quantity: numeric("quantity").notNull(),
    price: numeric("price"),
    status: orderStatusEnum("status").notNull().default("pending"),
    brokerOrderId: text("broker_order_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex(
      "orders_idempotency_key_unique",
    ).on(table.idempotencyKey),
    /** Target of trade_outcomes (order_id, account_id): an outcome can only cite an order of its own account. */
    idAccountUnique: uniqueIndex("orders_id_account_unique").on(table.id, table.accountId),
    accountStatusIdx: index("orders_account_status_idx").on(
      table.accountId,
      table.status,
    ),
  }),
);

/** A fill/execution report against an order (spec section 32). */
export const fills = pgTable(
  "fills",
  {
    id: idColumn(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    brokerFillId: text("broker_fill_id"),
    fillPrice: numeric("fill_price").notNull(),
    fillQuantity: numeric("fill_quantity").notNull(),
    fillTime: timestamp("fill_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    orderBrokerFillUnique: uniqueIndex(
      "fills_order_broker_fill_unique",
    ).on(table.orderId, table.brokerFillId),
  }),
);

/**
 * Current position state per account/instrument/trading-mode (spec
 * section 34: reconciliation compares this against broker state). History
 * of how a position changed over time lives in portfolio_snapshots and
 * audit_events, not here.
 */
export const positions = pgTable(
  "positions",
  {
    id: idColumn(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "restrict" }),
    tradingMode: tradingModeEnum("trading_mode").notNull(),
    quantity: numeric("quantity").notNull().default("0"),
    averagePrice: numeric("average_price"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: updatedAtColumn(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    accountInstrumentModeUnique: uniqueIndex(
      "positions_account_instrument_mode_unique",
    ).on(table.accountId, table.instrumentId, table.tradingMode),
  }),
);

/** Point-in-time portfolio state, used for performance/drawdown history. */
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    id: idColumn(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    equity: numeric("equity").notNull(),
    cash: numeric("cash"),
    positionsValue: numeric("positions_value"),
    realizedPnl: numeric("realized_pnl"),
    unrealizedPnl: numeric("unrealized_pnl"),
    drawdown: numeric("drawdown"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    accountTimeUnique: uniqueIndex(
      "portfolio_snapshots_account_time_unique",
    ).on(table.accountId, table.snapshotAt),
  }),
);
