import type { ResearchCandidate } from "@twins/agents";

/**
 * Research dispatch (Module 16 -> the common research path). Works on a PORT, so the same logic serves the worker (database store) and tests (memory store). It is SOURCE-AGNOSTIC: a Telegram-originated and an independent
 * candidate in state NEW are claimed and researched identically, and the dispatcher never reads Telegram.
 * Exactly-once research per attempt: a candidate is claimed atomically (NEW -> IN_RESEARCH), so two workers cannot research the same candidate; a crash leaves it IN_RESEARCH until the lease passes, then it is released.
 */
export interface ClaimedCandidate extends ResearchCandidate { expiresAt: Date; attempts: number }
export interface CandidateQueuePort {
  /** NEW candidates past their expiry become EXPIRED (any active state). Returns the number expired. */
  expireDue(now: Date): Promise<number>;
  /** IN_RESEARCH candidates idle longer than the lease are released to NEW (attempt counted) or WITHDRAWN when attempts are exhausted. */
  recoverStale(now: Date, leaseMs: number, maxAttempts: number): Promise<number>;
  /** Atomically moves ONE NEW, unexpired candidate (best rank first, never one of `exclude`) to IN_RESEARCH, or returns null. */
  claimNext(now: Date, exclude: readonly string[]): Promise<ClaimedCandidate | null>;
  /** IN_RESEARCH -> READY_FOR_DECISION. */
  complete(id: string): Promise<void>;
  /** A failed attempt: IN_RESEARCH -> NEW (attempts + 1), or WITHDRAWN when attempts reach the maximum. `count: false` returns it to NEW without using an attempt (a refusal by the safety state is not the candidate's fault). */
  release(id: string, reason: string, o: { count: boolean; maxAttempts: number }): Promise<"RETRY" | "WITHDRAWN">;
  /** IN_RESEARCH -> EXPIRED. */
  expire(id: string, reason: string): Promise<void>;
}
export interface DispatchResult { expired: number; recovered: number; researched: number; failed: number; retried: number; withdrawn: number; expiredDuringResearch: number; stoppedBySafety: boolean; skipped: "ENGINE_DISABLED" | null }
const refusal = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "safety_refused";

export async function dispatchResearch(o: {
  queue: CandidateQueuePort; now: Date; enabled: boolean; batchSize: number; maxAttempts: number; leaseMs: number;
  research: (c: ClaimedCandidate) => Promise<{ skipped?: "ENGINE_DISABLED" | "CANDIDATE_EXPIRED" | undefined }>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<DispatchResult> {
  const r: DispatchResult = { expired: 0, recovered: 0, researched: 0, failed: 0, retried: 0, withdrawn: 0, expiredDuringResearch: 0, stoppedBySafety: false, skipped: null };
  r.expired = await o.queue.expireDue(o.now);
  r.recovered = await o.queue.recoverStale(o.now, o.leaseMs, o.maxAttempts);
  if (!o.enabled) { r.skipped = "ENGINE_DISABLED"; return r; } // nothing is claimed while the research engine is off: candidates stay NEW
  const tried: string[] = []; // a candidate that failed is not claimed again in the same run: the next slot retries it
  for (let i = 0; i < o.batchSize; i++) {
    const c = await o.queue.claimNext(o.now, tried);
    if (!c) break;
    tried.push(c.id);
    try {
      const res = await o.research(c);
      if (res.skipped === "CANDIDATE_EXPIRED") { await o.queue.expire(c.id, "EXPIRED_BEFORE_RESEARCH"); r.expiredDuringResearch++; continue; }
      if (res.skipped === "ENGINE_DISABLED") { await o.queue.release(c.id, "ENGINE_DISABLED", { count: false, maxAttempts: o.maxAttempts }); r.skipped = "ENGINE_DISABLED"; break; }
      await o.queue.complete(c.id);
      r.researched++;
    } catch (e) {
      if (refusal(e)) { await o.queue.release(c.id, "SAFETY_REFUSED", { count: false, maxAttempts: o.maxAttempts }); r.stoppedBySafety = true; break; } // the kill switch / intake control stops the whole batch
      const kind = e instanceof Error ? e.name : "Error"; // only the error class is recorded: a message may embed row values
      const outcome = await o.queue.release(c.id, `RESEARCH_FAILED:${kind}`.slice(0, 120), { count: true, maxAttempts: o.maxAttempts });
      r.failed++; if (outcome === "RETRY") r.retried++; else r.withdrawn++;
      o.log?.("opportunity.research.failed", { candidateId: c.id, errorName: kind, outcome });
    }
  }
  return r;
}
