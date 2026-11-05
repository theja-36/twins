import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { riskDecisions } from "./riskDecisions";

/**
 * PAPER trading (simulation only; Stage 6/7 paper build). These tables are separate from `orders` / `fills` / `positions`, which stay read-only for the runtime roles (migration 0029).
 * Nothing here is, or can be turned into, a broker order. `paper_trades` holds the mutable simulated state (one row per approved risk decision, the whole trade as JSON);
 * `paper_trade_events` is the append-only history; `paper_outcomes` is one immutable outcome per closed trade (the learning-loop input).
 */
export const paperTrades = pgTable(
  "paper_trades",
  {
    id: uuid("id").primaryKey(),
    riskDecisionId: uuid("risk_decision_id").notNull().references(() => riskDecisions.id, { onDelete: "restrict" }),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    state: text("state").notNull(),
    trade: jsonb("trade").notNull(),
    lastPrice: numeric("last_price"),
    lastPriceAt: timestamp("last_price_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionUnique: uniqueIndex("paper_trades_decision_unique").on(t.riskDecisionId),
    stateIdx: index("paper_trades_state_idx").on(t.state),
    valueCheck: check("paper_trades_value_check", sql`${t.side} in ('BUY', 'SELL') and ${t.state} in ('PENDING_ENTRY', 'OPEN', 'CLOSED', 'CANCELLED')`),
  }),
);

export const paperTradeEvents = pgTable(
  "paper_trade_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id").notNull().references(() => paperTrades.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    price: numeric("price"),
    quantity: numeric("quantity"),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seqUnique: uniqueIndex("paper_trade_events_seq_unique").on(t.tradeId, t.seq),
    typeCheck: check("paper_trade_events_type_check", sql`${t.type} in ('CREATED', 'ENTRY_FILLED', 'STOP_MOVED', 'TARGET_HIT', 'STOPPED_OUT', 'SQUARED_OFF', 'CLOSED', 'CANCELLED')`),
  }),
);

export const paperOutcomes = pgTable(
  "paper_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id").notNull().references(() => paperTrades.id, { onDelete: "restrict" }),
    outcome: text("outcome").notNull(),
    rMultiple: numeric("r_multiple").notNull(),
    pnl: numeric("pnl").notNull(),
    closeReason: text("close_reason").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tradeUnique: uniqueIndex("paper_outcomes_trade_unique").on(t.tradeId),
    outcomeCheck: check("paper_outcomes_outcome_check", sql`${t.outcome} in ('WIN', 'LOSS', 'BREAKEVEN')`),
  }),
);

/**
 * The runtime ON/OFF switch for paper trading (one row, id = 1, seeded OFF). It is changed ONLY through the SECURITY DEFINER function `twins_paper_set_switch` (which also appends the audit
 * event); the runtime role can read it but cannot update it directly. Effective paper trading needs BOTH the host setting TWINS_PAPER_TRADING_ENABLED ("armed") and this switch.
 */
export const paperSwitch = pgTable(
  "paper_switch",
  {
    id: integer("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    version: integer("version").notNull().default(1),
    reason: text("reason").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ singleRow: check("paper_switch_single_row_check", sql`${t.id} = 1`) }),
);

export const paperSwitchEvents = pgTable(
  "paper_switch_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull(),
    previousEnabled: boolean("previous_enabled").notNull(),
    enabled: boolean("enabled").notNull(),
    reason: text("reason").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ versionUnique: uniqueIndex("paper_switch_events_version_unique").on(t.version) }),
);
