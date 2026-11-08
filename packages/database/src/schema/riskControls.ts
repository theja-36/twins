import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn } from "./_columns";
import { users } from "./users";

/**
 * Risk controls beyond the global kill switch (which stays in `system_controls`): per-user, per-market, per-source and per-strategy restrictions, plus the daily-loss and drawdown halts. Append-only: a control is SET and later
 * CLEARED by new rows, so the audit history is the table itself and the state is the latest row per (scope, key, kind, user). Platform rows have user_id null; user rows are visible to their owner only (row-level security).
 */
export const RISK_CONTROL_SCOPES = ["USER", "MARKET", "SOURCE", "STRATEGY"] as const;
export const RISK_CONTROL_KINDS = ["RESTRICTION", "DAILY_LOSS_HALT", "DRAWDOWN_HALT", "KILL_SWITCH"] as const;
export const riskControlEvents = pgTable("risk_control_events", {
  id: idColumn(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
  scope: text("scope").notNull(),
  scopeKey: text("scope_key"),
  kind: text("kind").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  actor: text("actor").notNull(),
  actorKind: text("actor_kind").notNull(),
  /** A SET may carry an expiry (the daily-loss halt expires at the next trading day); null = until cleared by a person. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAtColumn(),
}, (t) => ({
  idx: index("risk_control_events_state_idx").on(t.scope, t.scopeKey, t.kind, t.occurredAt),
  userIdx: index("risk_control_events_user_idx").on(t.userId, t.occurredAt),
  scopeCheck: check("risk_control_events_scope_check", oneOf(t.scope, RISK_CONTROL_SCOPES)),
  kindCheck: check("risk_control_events_kind_check", oneOf(t.kind, RISK_CONTROL_KINDS)),
  actionCheck: check("risk_control_events_action_check", oneOf(t.action, ["SET", "CLEAR"])),
  actorKindCheck: check("risk_control_events_actor_kind_check", oneOf(t.actorKind, ["OWNER", "SYSTEM"])),
  userScopeCheck: check("risk_control_events_user_scope_check", sql`${t.scope} <> 'USER' or ${t.userId} is not null`),
  reasonCheck: check("risk_control_events_reason_check", sql`length(${t.reason}) >= 10`),
  /** Recovery policy in the database: only a person (OWNER) can clear a drawdown halt or a kill switch; the system never clears them, and a system SET always names an expiry only for the daily halt. */
  clearPolicyCheck: check("risk_control_events_clear_policy_check", sql`${t.action} <> 'CLEAR' or ${t.actorKind} = 'OWNER' or ${t.kind} in ('RESTRICTION', 'DAILY_LOSS_HALT')`),
  expiryCheck: check("risk_control_events_expiry_check", sql`${t.expiresAt} is null or ${t.action} = 'SET'`),
}));
