import { randomUUID } from "node:crypto";
import { and, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import { aiUsageRecords } from "../schema/aiUsage";
import { withUser, type UserTx } from "../withUser";

/** The gateway's usage record (structural copy, so this package does not depend on the AI package). */
export interface AiUsageInput {
  id?: string; at: string; userId: string | null; task: string; provider: string; model: string; promptId: string; promptVersion: string; promptSha256: string;
  inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; attempt: number; outcome: string; errorKind: string | null; requestId: string; gatewayVersion: string;
}
const toRow = (r: AiUsageInput) => ({
  id: r.id ?? randomUUID(), userId: r.userId, occurredAt: new Date(r.at), task: r.task, provider: r.provider, model: r.model, promptId: r.promptId, promptVersion: r.promptVersion, promptSha256: r.promptSha256,
  inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd.toFixed(8), latencyMs: r.latencyMs, attempt: r.attempt, outcome: r.outcome, errorKind: r.errorKind, requestId: r.requestId, gatewayVersion: r.gatewayVersion,
});
type Runner = Pick<Db, "insert" | "select">;

/**
 * Usage store implementing the gateway's sink. Platform usage (no user) is written directly; user usage is written inside `withUser` so row-level security binds the row to that user.
 * `spentTodayUsd` sums the UTC day's cost over the rows visible in that scope (a user sees their own plus platform rows).
 */
export function createAiUsageStore(db: Pick<Db, "transaction">, scopeUserId: string | null = null) {
  const run = <T>(fn: (tx: Runner) => Promise<T>): Promise<T> =>
    scopeUserId === null ? fn(db as unknown as Runner) : withUser(db, scopeUserId, (tx: UserTx) => fn(tx as unknown as Runner));
  return {
    async record(r: AiUsageInput): Promise<void> {
      if (r.userId !== scopeUserId) throw new Error("a usage record must belong to the store's scope");
      await run((tx) => tx.insert(aiUsageRecords).values(toRow(r)));
    },
    async spentTodayUsd(now: Date): Promise<number> {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), end = new Date(start.getTime() + 86_400_000);
      const [row] = await run((tx) => tx.select({ total: sql<string>`coalesce(sum(${aiUsageRecords.costUsd}), 0)` }).from(aiUsageRecords).where(and(gte(aiUsageRecords.occurredAt, start), lt(aiUsageRecords.occurredAt, end))));
      return Number(row?.total ?? 0);
    },
  };
}
