import { sql } from "drizzle-orm";
import { check, index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./_checks";
import { createdAtColumn, idColumn } from "./_columns";
import { users } from "./users";

/**
 * Hosted-AI usage ledger (Master Build Stage 04, migration 0035). One row per provider attempt made through the AI gateway: tokens, cost, latency, outcome and the prompt version/hash,
 * so spend and behaviour are auditable. APPEND-ONLY (a usage row is never edited). `user_id` is null for platform work and set for user-initiated work; row-level security shows a user
 * their own rows plus platform rows. It stores NO prompt or response text.
 */
export const AI_USAGE_OUTCOMES = ["OK", "INVALID_OUTPUT", "TIMEOUT", "RATE_LIMITED", "PROVIDER_ERROR", "BUDGET_BLOCKED"] as const;
export const aiUsageRecords = pgTable("ai_usage_records", {
  id: idColumn(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  task: text("task").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptId: text("prompt_id").notNull(),
  promptVersion: text("prompt_version").notNull(),
  promptSha256: text("prompt_sha256").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: numeric("cost_usd", { precision: 16, scale: 8 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  attempt: integer("attempt").notNull(),
  outcome: text("outcome").notNull(),
  errorKind: text("error_kind"),
  requestId: text("request_id").notNull(),
  gatewayVersion: text("gateway_version").notNull(),
  createdAt: createdAtColumn(),
}, (t) => ({
  dayIdx: index("ai_usage_records_day_idx").on(t.occurredAt),
  userIdx: index("ai_usage_records_user_idx").on(t.userId, t.occurredAt),
  requestIdx: index("ai_usage_records_request_idx").on(t.requestId),
  outcomeCheck: check("ai_usage_records_outcome_check", oneOf(t.outcome, AI_USAGE_OUTCOMES)),
  tokensCheck: check("ai_usage_records_tokens_check", sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.latencyMs} >= 0 and ${t.attempt} >= 1`),
  costCheck: check("ai_usage_records_cost_check", sql`${t.costUsd} >= 0`),
  shaCheck: check("ai_usage_records_prompt_sha_check", sql`${t.promptSha256} ~ '^[0-9a-f]{64}$'`),
}));
