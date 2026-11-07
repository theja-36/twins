/**
 * Reduce-only sizing SHADOW (P0 #3, design: docs/twins/design/SHADOW_WIRING_1_3.md). Observe, log, never act: it runs after sizing-v1 has produced a SIZED outcome, computes what a reduce-only
 * adjustment WOULD have been and writes one log line. It returns nothing the caller can use, never throws, is bounded by a timeout, writes nothing to any store and is never read by a decision.
 * Default OFF (`TWINS_REDUCE_ONLY_SHADOW`); it refuses to be switched on while the enforcing engine is on (the worker's start-up guard already refuses live trading outright). The compute function is injected so this module imports no sizing package.
 */
export const REDUCE_ONLY_SHADOW_ENV = "TWINS_REDUCE_ONLY_SHADOW";
export const REDUCE_ONLY_SHADOW_TIMEOUT_MS = 3000;
export const SHADOW_EVENT = "risk_sizing.shadow.reduce_only";
export const SHADOW_VIOLATION_EVENT = "risk_sizing.shadow.violation";
export const SHADOW_FAILED_EVENT = "risk_sizing.shadow.failed";
export const SHADOW_PERSIST_FAILED_EVENT = "risk_sizing.shadow.persist_failed";

export class ReduceOnlyShadowConfigError extends Error { constructor(m: string) { super(m); this.name = "ReduceOnlyShadowConfigError"; } }

/** Strict flag loader: absent or "false" => off; "true" => on only when the enforcing engine is off. Anything else is a configuration error (fail closed at start-up). */
export function loadReduceOnlyShadowFlag(env: Record<string, string | undefined>, ctx: { enforcingEngine: boolean }): boolean {
  const raw = env[REDUCE_ONLY_SHADOW_ENV];
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw !== "true") throw new ReduceOnlyShadowConfigError(`${REDUCE_ONLY_SHADOW_ENV} must be true or false`);
  if (ctx.enforcingEngine) throw new ReduceOnlyShadowConfigError(`${REDUCE_ONLY_SHADOW_ENV} cannot be true while the enforcing agent engine is on`);
  return true;
}

export const SHADOW_PERSIST_ENV = "TWINS_SHADOW_PERSIST";
/** Strict flag for the durable copy of shadow results (HB-25). Default OFF; needs migration 0032. Anything but true / false is a configuration error. */
export function loadShadowPersistFlag(env: Record<string, string | undefined>): boolean {
  const raw = env[SHADOW_PERSIST_ENV];
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new ReduceOnlyShadowConfigError(`${SHADOW_PERSIST_ENV} must be true or false`);
}

export interface ShadowInputs {
  drawdownPct: number | null;
  volatilityRatio: number | null;
  hoursToHighImpactEvent: number | null;
  unusableSources: number | null;
  thinEvidence: boolean;
  /** Absolute entry-to-protective-level distance per unit, when known; only used to express the quantity difference as an amount in the tally. */
  unitRisk: number | null;
}
export interface ShadowResultLike {
  version: string; v1Quantity: number; adjustedQuantity: number; multiplier: number; reduced: boolean; usedForDecisions: boolean;
  factors: ReadonlyArray<{ name: string; multiplier: number }>; unknownInputs: readonly string[]; notes: readonly string[];
}
export interface ShadowLog { info(event: string, fields: Record<string, unknown>): void; warn(event: string, fields: Record<string, unknown>): void }
export interface SizedOutcome { id: string; decisionVersion: number; sizingStatus: string; quantity: number }
export interface PersistShadow { (o: { kind: "reduce_only_sizing"; riskDecisionId: string; decisionVersion: number; result: Record<string, unknown> }): Promise<unknown> }
export interface ShadowDeps {
  enabled: boolean;
  /** Optional durable copy (HB-25). Best-effort: a failure is logged and never reaches the flow. Absent => log only. */
  persist?: PersistShadow;
  log: ShadowLog;
  /** Injected so this module holds no sizing import: `reduceOnlySize(inputs)`. */
  compute: (i: { v1Quantity: number; drawdownPct: number | null; volatilityRatio: number | null; hoursToHighImpactEvent: number | null; unusableSources: number | null; thinEvidence: boolean }) => ShadowResultLike;
  gather: (outcome: SizedOutcome) => Promise<ShadowInputs>;
  timeoutMs?: number;
}

/** Never throws; resolves after logging (or silently when off / not SIZED). The caller must not use the return value (there is none). */
export async function runReduceOnlyShadow(deps: ShadowDeps, outcome: SizedOutcome): Promise<void> {
  if (!deps.enabled || outcome.sizingStatus !== "SIZED") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const inputs = await deps.gather(outcome);
      const { unitRisk, ...rest } = inputs;
      const r = deps.compute({ v1Quantity: outcome.quantity, ...rest });
      if (r.usedForDecisions !== false || !Number.isInteger(r.adjustedQuantity) || r.adjustedQuantity < 0 || r.adjustedQuantity > outcome.quantity) {
        deps.log.warn(SHADOW_VIOLATION_EVENT, { riskDecisionId: outcome.id, decisionVersion: outcome.decisionVersion, v1Quantity: outcome.quantity, reason: "result_not_reduce_only", usedForDecisions: false });
        return;
      }
      deps.log.info(SHADOW_EVENT, {
        riskDecisionId: outcome.id, decisionVersion: outcome.decisionVersion, version: r.version, v1Quantity: r.v1Quantity, shadowQuantity: r.adjustedQuantity, multiplier: r.multiplier, reduced: r.reduced,
        factors: r.factors.map((f) => ({ name: f.name, multiplier: f.multiplier })), unknownInputs: [...r.unknownInputs], notes: [...r.notes], unitRisk, usedForDecisions: false,
      });
      if (deps.persist) {
        try {
          await deps.persist({ kind: "reduce_only_sizing", riskDecisionId: outcome.id, decisionVersion: outcome.decisionVersion, result: {
            version: r.version, v1Quantity: r.v1Quantity, shadowQuantity: r.adjustedQuantity, multiplier: r.multiplier, reduced: r.reduced,
            factors: r.factors.map((f) => ({ name: f.name, multiplier: f.multiplier })), unknownInputs: [...r.unknownInputs], notes: [...r.notes], unitRisk,
          } });
        } catch { deps.log.warn(SHADOW_PERSIST_FAILED_EVENT, { riskDecisionId: outcome.id, usedForDecisions: false }); }
      }
    })();
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), deps.timeoutMs ?? REDUCE_ONLY_SHADOW_TIMEOUT_MS); });
    const res = await Promise.race([work.then(() => "done" as const), timeout]);
    if (res === "timeout") deps.log.warn(SHADOW_FAILED_EVENT, { riskDecisionId: outcome.id, reason: "timeout", usedForDecisions: false });
  } catch {
    try { deps.log.warn(SHADOW_FAILED_EVENT, { riskDecisionId: outcome.id, reason: "error", usedForDecisions: false }); } catch { /* logging must never throw into the flow */ }
  } finally {
    clearTimeout(timer);
  }
}
