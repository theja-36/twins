/**
 * Hosted-AI provider port (Stage 04, ADR-005). A provider turns one prompt into one text completion. It is the ONLY place a vendor's request/response format may appear, and the concrete
 * hosted adapters (OpenRouter and others) are the external-integration stage's job: nothing here performs network I/O. Output is UNTRUSTED text.
 */
export type ProviderSource = "FIXTURE" | "LIVE";
export interface ProviderCapabilities { name: string; source: ProviderSource; models: readonly string[]; structuredOutput: boolean; maxContextTokens: number }
export interface LlmRequest { model: string; system: string; prompt: string; maxOutputTokens: number; temperature: 0; requestId: string }
export interface LlmCompletion { text: string; inputTokens: number; outputTokens: number; providerRequestId: string | null }
export interface LlmProvider { readonly name: string; capabilities(): ProviderCapabilities; complete(req: LlmRequest, signal: AbortSignal): Promise<LlmCompletion> }

export const LLM_ERROR_KINDS = ["RATE_LIMIT", "TIMEOUT", "SERVER", "CLIENT", "AUTH", "UNKNOWN"] as const;
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];
/** A classified provider failure. RATE_LIMIT / SERVER / TIMEOUT are retryable; CLIENT / AUTH / UNKNOWN are not (retrying an invalid or unauthorised request only wastes budget). */
export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, message: string = kind, readonly retryAfterMs: number | null = null) { super(message); this.name = "LlmError"; }
}
export const isRetryable = (k: LlmErrorKind): boolean => k === "RATE_LIMIT" || k === "SERVER" || k === "TIMEOUT";
/** Classifies an HTTP-style status for adapters. */
export function classifyStatus(status: number): LlmErrorKind {
  if (status === 429) return "RATE_LIMIT";
  if (status === 401 || status === 403) return "AUTH";
  if (status === 408) return "TIMEOUT";
  if (status >= 500) return "SERVER";
  if (status >= 400) return "CLIENT";
  return "UNKNOWN";
}

/** Deterministic in-memory provider for tests and fixtures. Labelled FIXTURE; makes no network call. */
export class FixtureLlmProvider implements LlmProvider {
  readonly calls: LlmRequest[] = [];
  constructor(readonly name: string, private readonly respond: (req: LlmRequest, call: number) => string | LlmError, private readonly models: readonly string[] = ["fixture-model"]) {}
  capabilities(): ProviderCapabilities { return { name: this.name, source: "FIXTURE", models: this.models, structuredOutput: true, maxContextTokens: 32_000 }; }
  async complete(req: LlmRequest, signal: AbortSignal): Promise<LlmCompletion> {
    this.calls.push(req);
    if (signal.aborted) throw new LlmError("TIMEOUT");
    const out = this.respond(req, this.calls.length);
    if (out instanceof LlmError) throw out;
    return { text: out, inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: Math.ceil(out.length / 4), providerRequestId: `fixture-${this.calls.length}` };
  }
}
