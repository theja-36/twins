import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn } from "./_columns";
import { accounts } from "./accounts";
import { users } from "./users";

/**
 * Multi-user platform tables (Master Build Stage 02, ADR-002/ADR-003). Capital, risk policy and permissions belong to ONE account (which already pins one trading mode and one user),
 * so nothing is pooled. `user_id` is repeated on each private table so row-level security (migration 0033) can enforce isolation inside the database.
 * Capital profiles and risk policies are APPEND-ONLY versions: a change is a new row, so what applied at the time of a decision is always recoverable.
 */
export const userSessions = pgTable("user_sessions", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  /** SHA-256 of the opaque session token; the token itself is never stored. */
  tokenHash: text("token_hash").notNull(),
  createdAt: createdAtColumn(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, (t) => ({
  tokenUnique: uniqueIndex("user_sessions_token_hash_unique").on(t.tokenHash),
  userIdx: index("user_sessions_user_idx").on(t.userId, t.expiresAt),
  lifetimeCheck: check("user_sessions_lifetime_check", sql`${t.expiresAt} > ${t.createdAt}`),
}));

export const userCapitalProfiles = pgTable("user_capital_profiles", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  version: integer("version").notNull(),
  totalCapital: numeric("total_capital").notNull(),
  availableCapital: numeric("available_capital").notNull(),
  currency: text("currency").notNull().default("INR"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  ownerFk: foreignKey({ name: "user_capital_profiles_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  versionUnique: uniqueIndex("user_capital_profiles_account_version_unique").on(t.accountId, t.version),
  accountIdx: index("user_capital_profiles_account_idx").on(t.accountId, t.effectiveFrom),
  versionCheck: check("user_capital_profiles_version_check", sql`${t.version} >= 1`),
  amountsCheck: check("user_capital_profiles_amounts_check", sql`${t.totalCapital} >= 0 and ${t.availableCapital} >= 0 and ${t.availableCapital} <= ${t.totalCapital}`),
}));

/** The 5 percent ceiling mirrors HARD_MAX_RISK_PCT in packages/risk (a capital-protection ceiling, not a tunable). */
export const userRiskPolicies = pgTable("user_risk_policies", {
  id: idColumn(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  version: integer("version").notNull(),
  riskPercent: numeric("risk_percent").notNull(),
  maxRiskPerTrade: numeric("max_risk_per_trade"),
  maxDailyLoss: numeric("max_daily_loss").notNull(),
  maxConcurrentPositions: integer("max_concurrent_positions").notNull(),
  maxLots: integer("max_lots").notNull(),
  minRewardToRisk: numeric("min_reward_to_risk").notNull(),
  allowedUnderlyings: text("allowed_underlyings").array().notNull().default(sql`ARRAY[]::text[]`),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  ownerFk: foreignKey({ name: "user_risk_policies_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  versionUnique: uniqueIndex("user_risk_policies_account_version_unique").on(t.accountId, t.version),
  accountIdx: index("user_risk_policies_account_idx").on(t.accountId, t.effectiveFrom),
  versionCheck: check("user_risk_policies_version_check", sql`${t.version} >= 1`),
  riskCheck: check("user_risk_policies_risk_check", sql`${t.riskPercent} > 0 and ${t.riskPercent} <= 5`),
  limitsCheck: check("user_risk_policies_limits_check", sql`${t.maxDailyLoss} > 0 and ${t.maxConcurrentPositions} >= 1 and ${t.maxLots} >= 1 and ${t.minRewardToRisk} > 0 and (${t.maxRiskPerTrade} is null or ${t.maxRiskPerTrade} > 0)`),
}));

export const EXECUTION_MODE_VALUES = ["PAPER", "ASSISTED_LIVE", "CONTROLLED_AUTO"] as const;
/**
 * Per-account permission for each execution mode. Defence in depth: the database itself refuses to record a live mode as enabled. Lifting that is a deliberate future migration that
 * must be made only after the broker, security, legal and regulatory gates are verified (spec Module 13); the application gate (checkExecutionGate) is separate.
 */
export const userExecutionPermissions = pgTable("user_execution_permissions", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull(),
  mode: text("mode").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  changedBy: text("changed_by").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.mode] }),
  ownerFk: foreignKey({ name: "user_execution_permissions_owner_fk", columns: [t.accountId, t.userId], foreignColumns: [accounts.id, accounts.userId] }),
  modeCheck: check("user_execution_permissions_mode_check", oneOf(t.mode, EXECUTION_MODE_VALUES)),
  liveDisabledCheck: check("user_execution_permissions_live_disabled_check", sql`${t.mode} = 'PAPER' or ${t.enabled} = false`),
}));
