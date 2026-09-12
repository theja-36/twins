import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { backtestStatusEnum } from "./enums";
import { users } from "./users";

/**
 * A backtest run configuration (spec section 37). The historical-clock
 * enforcement (no look-ahead) is an engine-level concern for Phase 15 -
 * this table only records what was configured and requested.
 */
export const backtests = pgTable("backtests", {
  id: idColumn(),
  name: text("name").notNull(),
  description: text("description"),
  strategyConfig: jsonb("strategy_config").notNull(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  status: backtestStatusEnum("status").notNull().default("queued"),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/**
 * Results for a backtest, including the raw/telegram vs TWINS-approved
 * comparison metrics required by spec section 38.
 */
export const backtestResults = pgTable("backtest_results", {
  id: idColumn(),
  backtestId: uuid("backtest_id")
    .notNull()
    .references(() => backtests.id, { onDelete: "cascade" }),
  metricSet: jsonb("metric_set").notNull(), // expectancy, profit_factor, drawdown, etc.
  equityCurve: jsonb("equity_curve"),
  tradesCount: integer("trades_count").notNull().default(0),
  createdAt: createdAtColumn(),
});
