import { randomUUID } from "node:crypto";
import { parseStructured, routeIsSane, untrusted, type AIModelRoute, type AIProvenance } from "@twins/types";
import { isRetryable, LlmError, type LlmErrorKind, type LlmProvider, type LlmRequest } from "./provider";
import type { PromptRegistry } from "./prompts";

/**
 * The hosted-AI gateway (Stage 04, ADR-005). Everything a model returns is UNTRUSTED text: it leaves the gateway only through `parseStructured` with a closed shape guard, wrapped as
 * ADVISORY. The gateway has no handle on capital, risk limits, permissions, orders or decisions, so its output cannot change them; callers must still treat even a valid output as a suggestion.
 * Failure behaviour is fail-closed: an unknown price, an exceeded or unreadable budget, an unrecorded call, an invalid output or exhausted providers all return `ok: false` and never a guess.
 */
export const GATEWAY_VERSION = "ai-gateway-v1";
export const USAGE_OUTCOMES = ["OK", "INVALID_OUTPUT", "TIMEOUT", "RATE_LIMITED", "PROVIDER_ERROR", "BUDGET_BLOCKED"] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

export interface GatewayUsageRecord {
  id: string; at: string; userId: string | null; task: string; provider: string; model: string; promptId: string; promptVersion: string; promptSha256: string;
  inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; attempt: number; outcome: UsageOutcome; errorKind: LlmErrorKind | null; requestId: string; gatewayVersion: string;
}
/** Where usage is recorded and the day's spend is read. `spentTodayUsd` throwing makes the gateway refuse (budget unknown). */
export interface UsageSink { record(r: GatewayUsageRecord): Promise<void>; spentTodayUsd(now: Date): Promise<number> }
export interface ModelPrice { inputPerMTokUsd: number; outputPerMTokUsd: number }
export type PriceTable = Readonly<Record<string, ModelPrice>>; // key: "provider/model"
export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 };

export interface GatewayDeps {
  providers: Readonly<Record<string, LlmProvider>>; routes: Readonly<Record<string, AIModelRoute>>; prompts: PromptRegistry; prices: PriceTable; dailyBudgetUsd: number; usage: UsageSink;
  retry?: RetryPolicy; now?: () => Date; sleep?: (ms: number) => Promise<void>; newId?: () => string;
}
export interface GatewayRequest<T> { task: string; vars: Readonly<Record<string, string | number | boolean>>; guard: (v: unknown) => v is T; userId?: string | null }
export type FailureReason = "NO_ROUTE" | "BAD_ROUTE" | "NO_PROMPT" | "BAD_PROMPT_VARS" | "BUDGET_UNKNOWN" | "BUDGET_EXCEEDED" | "NO_PRICED_PROVIDER" | "INVALID_OUTPUT" | "USAGE_RECORDING_FAILED" | "ALL_PROVIDERS_FAILED";
export type GatewayResult<T> =
  | { ok: true; advisory: true; value: T; provenance: AIProvenance; usage: { inputTokens: number; outputTokens: number; costUsd: number; attempts: number } }
  | { ok: false; reason: FailureReason; detail: string | null };

export const costOf = (p: ModelPrice, inTok: number, outTok: number): number => Math.round(((inTok * p.inputPerMTokUsd + outTok * p.outputPerMTokUsd) / 1e6) * 1e8) / 1e8;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withTimeout<R>(ms: number, fn: (signal: AbortSignal) => Promise<R>): Promise<R> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new LlmError("TIMEOUT", "the provider timed out")); }, ms); });
  try { return await Promise.race([fn(ctl.signal), timeout]); } finally { if (timer) clearTimeout(timer); }
}

export function createAiGateway(deps: GatewayDeps) {
  const retry = deps.retry ?? DEFAULT_RETRY, now = deps.now ?? (() => new Date()), sleep = deps.sleep ?? realSleep, newId = deps.newId ?? randomUUID;
  if (!(deps.dailyBudgetUsd >= 0) || !Number.isFinite(deps.dailyBudgetUsd)) throw new RangeError("the daily budget must be a finite number >= 0");

  async function run<T>(req: GatewayRequest<T>): Promise<GatewayResult<T>> {
    const route = deps.routes[req.task];
    if (!route) return { ok: false, reason: "NO_ROUTE", detail: req.task };
    if (!routeIsSane(route)) return { ok: false, reason: "BAD_ROUTE", detail: req.task };
    const prompt = deps.prompts.forTask(req.task);
    if (!prompt) return { ok: false, reason: "NO_PROMPT", detail: req.task };
    let text: string;
    try { text = deps.prompts.render(prompt, req.vars); } catch (e) { return { ok: false, reason: "BAD_PROMPT_VARS", detail: e instanceof Error ? e.message.slice(0, 120) : null }; }
    let spent: number;
    try { spent = await deps.usage.spentTodayUsd(now()); if (!Number.isFinite(spent) || spent < 0) throw new Error("bad spend"); } catch { return { ok: false, reason: "BUDGET_UNKNOWN", detail: null }; }

    const requestId = newId();
    const candidates = [{ provider: route.provider, model: route.model }, ...route.fallbacks];
    const estIn = Math.ceil((prompt.system.length + text.length) / 4);
    let sawPriced = false, attemptNo = 0, lastKind: LlmErrorKind | null = null;
    const record = async (c: { provider: string; model: string }, outcome: UsageOutcome, f: { inT: number; outT: number; cost: number; ms: number; err: LlmErrorKind | null }): Promise<boolean> => {
      try {
        await deps.usage.record({ id: newId(), at: now().toISOString(), userId: req.userId ?? null, task: req.task, provider: c.provider, model: c.model, promptId: prompt.id, promptVersion: prompt.version, promptSha256: prompt.sha256,
          inputTokens: f.inT, outputTokens: f.outT, costUsd: f.cost, latencyMs: f.ms, attempt: attemptNo, outcome, errorKind: f.err, requestId, gatewayVersion: GATEWAY_VERSION });
        return true;
      } catch { return false; }
    };

    for (const c of candidates) {
      const provider = deps.providers[c.provider], price = deps.prices[`${c.provider}/${c.model}`];
      if (!provider || !price || !provider.capabilities().models.includes(c.model)) continue; // unknown provider / model / price: never called
      sawPriced = true;
      for (let n = 1; n <= retry.maxAttempts; n++) {
        const worst = costOf(price, estIn, route.maxOutputTokens);
        if (spent + worst > deps.dailyBudgetUsd) {
          attemptNo += 1;
          await record(c, "BUDGET_BLOCKED", { inT: 0, outT: 0, cost: 0, ms: 0, err: null });
          return { ok: false, reason: "BUDGET_EXCEEDED", detail: null };
        }
        attemptNo += 1;
        const llm: LlmRequest = { model: c.model, system: prompt.system, prompt: text, maxOutputTokens: route.maxOutputTokens, temperature: 0, requestId };
        const t0 = Date.now();
        try {
          const done = await withTimeout(route.timeoutMs, (signal) => provider.complete(llm, signal));
          const cost = costOf(price, done.inputTokens, done.outputTokens), ms = Date.now() - t0;
          spent += cost;
          const provenance: AIProvenance = { provider: c.provider, model: c.model, promptVersion: prompt.version, requestId, receivedAt: now().toISOString() };
          const parsed = parseStructured(untrusted(done.text), req.guard, provenance);
          if (!(await record(c, parsed.ok ? "OK" : "INVALID_OUTPUT", { inT: done.inputTokens, outT: done.outputTokens, cost, ms, err: null }))) return { ok: false, reason: "USAGE_RECORDING_FAILED", detail: null };
          if (!parsed.ok) return { ok: false, reason: "INVALID_OUTPUT", detail: parsed.reason };
          return { ok: true, advisory: true, value: parsed.value, provenance, usage: { inputTokens: done.inputTokens, outputTokens: done.outputTokens, costUsd: cost, attempts: attemptNo } };
        } catch (e) {
          const kind: LlmErrorKind = e instanceof LlmError ? e.kind : "UNKNOWN";
          lastKind = kind;
          const outcome: UsageOutcome = kind === "TIMEOUT" ? "TIMEOUT" : kind === "RATE_LIMIT" ? "RATE_LIMITED" : "PROVIDER_ERROR";
          if (!(await record(c, outcome, { inT: 0, outT: 0, cost: 0, ms: Date.now() - t0, err: kind }))) return { ok: false, reason: "USAGE_RECORDING_FAILED", detail: null };
          if (!isRetryable(kind) || n === retry.maxAttempts) break; // next candidate
          const wait = Math.min(retry.maxDelayMs, e instanceof LlmError && e.retryAfterMs !== null ? e.retryAfterMs : retry.baseDelayMs * 2 ** (n - 1));
          await sleep(wait);
        }
      }
    }
    return sawPriced ? { ok: false, reason: "ALL_PROVIDERS_FAILED", detail: lastKind } : { ok: false, reason: "NO_PRICED_PROVIDER", detail: null };
  }
  return { run };
}
export type AiGateway = ReturnType<typeof createAiGateway>;

/** In-memory sink for tests and local runs. */
export class MemoryUsageSink implements UsageSink {
  readonly records: GatewayUsageRecord[] = [];
  async record(r: GatewayUsageRecord): Promise<void> { this.records.push(r); }
  async spentTodayUsd(now: Date): Promise<number> { const day = now.toISOString().slice(0, 10); return this.records.filter((r) => r.at.slice(0, 10) === day).reduce((a, r) => a + r.costUsd, 0); }
}
