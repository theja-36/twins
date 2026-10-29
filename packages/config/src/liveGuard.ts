/**
 * The single shared LIVE_TRADING guard (Stage 1 / Safety Core).
 *
 * Every TWINS process calls enforceLiveTradingGuard() as its first statement, and any future code that can reach a
 * broker calls assertLiveTradingDisabled() at its entry. Until the LIVE Gate (Stage 10) exists and passes, there is
 * NO configuration under which this guard permits live trading: it has no override parameter, no allow-list and no
 * bypass flag, by design. A well-formed LIVE_TRADING=true is refused exactly like a malformed one.
 *
 * Rules (fail closed on ambiguity, unlike loadConfig's parse, which reads any non-"true" value as false):
 *   LIVE_TRADING  must be unset or exactly "false". "", "true", "TRUE", "1", " false" are all refused.
 *   TRADING_MODE  must be unset, "paper" or "shadow". "live" or anything unrecognised is refused.
 *
 * The same rules are implemented for the Python capture client in services/telegram-capture/twins_capture/liveguard.py;
 * tests/fixtures/liveGuard/contract.json is the shared conformance table both implementations must satisfy.
 * Messages carry reason codes only, never an environment value.
 */

export const LIVE_GUARD_EXIT_CODE = 81;

export type LiveGuardReason = "live_trading_not_false" | "trading_mode_not_permitted";

export interface LiveGuardVerdict {
  ok: boolean;
  reasons: LiveGuardReason[];
}

type Env = Record<string, string | undefined>;

export function evaluateLiveGuard(env: Env = process.env): LiveGuardVerdict {
  const reasons: LiveGuardReason[] = [];
  const live = env["LIVE_TRADING"];
  if (live !== undefined && live !== "false") reasons.push("live_trading_not_false");
  const mode = env["TRADING_MODE"];
  if (mode !== undefined && mode !== "paper" && mode !== "shadow") reasons.push("trading_mode_not_permitted");
  return { ok: reasons.length === 0, reasons };
}

export class LiveGuardError extends Error {
  constructor(
    readonly processName: string,
    readonly reasons: readonly LiveGuardReason[],
  ) {
    super(`LIVE_TRADING guard refused ${processName}: ${reasons.join(",")}`);
    this.name = "LiveGuardError";
  }
}

/** Throws LiveGuardError unless the environment is provably non-live. Use at the entry of any function that can reach a broker. */
export function assertLiveTradingDisabled(processName: string, env: Env = process.env): void {
  const verdict = evaluateLiveGuard(env);
  if (!verdict.ok) throw new LiveGuardError(processName, verdict.reasons);
}

export interface EnforceOptions {
  env?: Env;
  exit?: (code: number) => never;
  write?: (line: string) => void;
}

/** Process-entry form: on refusal writes ONE content-free JSON line to stderr and exits with LIVE_GUARD_EXIT_CODE. */
export function enforceLiveTradingGuard(processName: string, options: EnforceOptions = {}): void {
  const verdict = evaluateLiveGuard(options.env ?? process.env);
  if (verdict.ok) return;
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  write(`${JSON.stringify({ level: "fatal", event: "live_guard.refused", process: processName, reasons: verdict.reasons })}\n`);
  exit(LIVE_GUARD_EXIT_CODE);
}
