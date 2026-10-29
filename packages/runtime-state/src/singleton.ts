import { RuntimeStateUnavailableError } from "./errors";
import { RuntimeState, type RuntimeStateOptions } from "./runtimeState";
import type { SafetyRequirement, StateSource } from "./types";
import type { SafetyRefusalError } from "./errors";

/**
 * The per-process runtime state used by every TWINS process through the module-level functions below.
 * A process configures it ONCE at startup (configureRuntimeState). If nothing was configured, every assertion fails closed with
 * `state_unavailable` / `not_configured`: an unconfigured process can never act. There is no environment-variable or default bypass.
 */
let current: RuntimeState | null = null;

const unconfiguredSource: StateSource = {
  async read() {
    throw new RuntimeStateUnavailableError("not_configured");
  },
};
let unconfigured: RuntimeState | null = null;

export function configureRuntimeState(options: RuntimeStateOptions): RuntimeState {
  current = new RuntimeState(options);
  return current;
}

/** Test/shutdown helper: forgets the configured instance (the process is then fail-closed again). */
export function resetRuntimeState(): void {
  current = null;
}

export function currentRuntimeState(): RuntimeState {
  if (current) return current;
  unconfigured ??= new RuntimeState({ source: unconfiguredSource, ttlMs: 0, failureTtlMs: 0 });
  return unconfigured;
}

export const isTradingEnabled = (): Promise<boolean> => currentRuntimeState().isTradingEnabled();
export const isIntakeEnabled = (): Promise<boolean> => currentRuntimeState().isIntakeEnabled();
export const isKillSwitchActive = (): Promise<boolean> => currentRuntimeState().isKillSwitchActive();
export const assertTradingEnabled = (operationName: string): Promise<void> => currentRuntimeState().assertTradingEnabled(operationName);
export const assertIntakeEnabled = (operationName: string): Promise<void> => currentRuntimeState().assertIntakeEnabled(operationName);
export const assertKillSwitchInactive = (operationName: string): Promise<void> => currentRuntimeState().assertKillSwitchInactive(operationName);
export const evaluateSafety = (requirement: SafetyRequirement, operationName: string): Promise<SafetyRefusalError | null> => currentRuntimeState().evaluate(requirement, operationName);
export const forceRefreshRuntimeState = () => currentRuntimeState().forceRefresh();
