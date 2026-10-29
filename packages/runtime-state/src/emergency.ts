/**
 * EXTENSION POINT for a future emergency-flatten (and any other kill-switch-triggered) action. NOTHING is registered by this repository
 * today and no flatten logic exists: this only defines where one plugs in.
 *
 * Contract for a future action:
 *  - It is invoked (a) in a process that OBSERVES KILL_SWITCH_ACTIVE turn true (once per transition per process; every process that
 *    reads the state sees it) and (b) in the admin process right after the activating change commits. It must therefore be IDEMPOTENT and,
 *    if it must run in exactly one place, elect/guard that itself (e.g. only the designated execution process acts).
 *  - It runs fire-and-forget: a slow or failing action can never delay or break a safety assertion. Failures are logged as
 *    `safety.emergency_action.failed`, never thrown into the caller.
 *  - It must never be the ONLY protection: the assertions already block new intake, proposals, approvals and order intent.
 */
export interface KillSwitchEvent {
  /** "observed" = this process saw the state flip; "admin" = this process just committed the activating change. */
  origin: "observed" | "admin";
  /** Control version at the time of activation, when known. */
  version?: number;
}

export interface EmergencyAction {
  readonly name: string;
  run(event: KillSwitchEvent): Promise<void>;
}

export class EmergencyActionRegistry {
  private readonly actions = new Map<string, EmergencyAction>();

  register(action: EmergencyAction): void {
    if (this.actions.has(action.name)) throw new Error(`emergency action already registered: ${action.name}`);
    this.actions.set(action.name, action);
  }

  unregister(name: string): void {
    this.actions.delete(name);
  }

  list(): EmergencyAction[] {
    return [...this.actions.values()];
  }
}

/** Process-wide registry used unless a RuntimeState is given its own. */
export const emergencyActions = new EmergencyActionRegistry();
