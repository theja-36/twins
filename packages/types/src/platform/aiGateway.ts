/**
 * AI layer contracts (ADR-005). LLM output is UNTRUSTED text: it can only enter the system through `parseStructured`, and it is a different type from any value used for
 * money, limits, permissions or execution, so passing one where the other is needed is a compile error.
 */
declare const UNTRUSTED: unique symbol;
export type Untrusted<T> = { readonly [UNTRUSTED]: true; readonly value: T };
export const untrusted = <T>(value: T): Untrusted<T> => ({ value }) as Untrusted<T>;

export interface AIModelRoute { task: string; provider: string; model: string; maxOutputTokens: number; timeoutMs: number; fallbacks: ReadonlyArray<{ provider: string; model: string }> }
export interface AIUsageRecord { id: string; at: string; userId: string | null; task: string; provider: string; model: string; promptVersion: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; outcome: "OK" | "INVALID_OUTPUT" | "TIMEOUT" | "PROVIDER_ERROR" }
export interface AIProvenance { provider: string; model: string; promptVersion: string; requestId: string; receivedAt: string }
export type StructuredResult<T> = { ok: true; value: T; provenance: AIProvenance } | { ok: false; reason: "NOT_JSON" | "SCHEMA_MISMATCH" | "EMPTY"; provenance: AIProvenance };

/** Validates model output against a closed shape guard; anything else is rejected, never repaired or guessed. */
export function parseStructured<T>(raw: Untrusted<string>, guard: (v: unknown) => v is T, provenance: AIProvenance): StructuredResult<T> {
  const text = raw.value.trim();
  if (text === "") return { ok: false, reason: "EMPTY", provenance };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, reason: "NOT_JSON", provenance }; }
  return guard(json) ? { ok: true, value: json, provenance } : { ok: false, reason: "SCHEMA_MISMATCH", provenance };
}
/** A route is usable only if every fallback differs from the primary (a failing provider is never "retried" as its own fallback). */
export const routeIsSane = (r: AIModelRoute): boolean => r.maxOutputTokens > 0 && r.timeoutMs > 0 && r.fallbacks.every((f) => f.provider !== r.provider || f.model !== r.model);
