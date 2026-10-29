import {
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./_columns";
import { decisionOutcomeEnum } from "./enums";
import { signals } from "./signals";
import { analyses } from "./analyses";

/**
 * The Decision Engine's output for a signal (spec section 29). A decision
 * is explicitly NOT an order - it only becomes executable after passing
 * through a risk_decisions row (spec section 31).
 */
export const decisions = pgTable("decisions", {
  id: idColumn(),
  signalId: uuid("signal_id")
    .notNull()
    .references(() => signals.id, { onDelete: "cascade" }),
  analysisId: uuid("analysis_id").references(() => analyses.id, {
    onDelete: "set null",
  }),
  outcome: decisionOutcomeEnum("outcome").notNull(),
  rationale: text("rationale"),
  decidedAt: timestamp("decided_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: createdAtColumn(),
});
