import { evaluateSafety } from "@twins/runtime-state";

/**
 * Every scheduled job declares what it can touch, and goes through runScheduledJob (a static test fails if a cron callback bypasses it):
 *  - "market_data"  : only fetches/enqueues external market data. It does not create, modify or act on trade state, so it is not gated
 *                     by the trading/kill-switch state (stale prices would only make later decisions worse; nothing trades from it).
 *  - "trade_state"  : can create, modify or act on trade state (proposals, orders, positions, exits...). It runs only while TRADING_ENABLED
 *                     is true AND the kill switch is inactive AND the state is readable; otherwise it is skipped and a safety event is emitted.
 *  - "risk_housekeeping" : only REMOVES exposure or RECORDS risk state (appends EXPIRED risk-decision versions; records and alerts circuit-breaker state). It never
 *                     creates a decision, approval or order, so - like the kill switch itself - it must keep running while trading is off or the kill switch is on.
 * No trade_state job exists yet; this is the boundary future ones must use.
 */
export type JobEffect = "market_data" | "risk_housekeeping" | "trade_state";

export interface ScheduledJobSpec {
  name: string;
  effect: JobEffect;
}

export interface ScheduledJobDeps {
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type ScheduledJobOutcome = "ran" | "skipped_by_safety";

export async function runScheduledJob(spec: ScheduledJobSpec, run: () => Promise<void>, deps: ScheduledJobDeps = {}): Promise<ScheduledJobOutcome> {
  if (spec.effect === "trade_state") {
    const refusal = await evaluateSafety("trading", `scheduler.${spec.name}`);
    if (refusal) {
      deps.log?.("scheduler.job.skipped_by_safety", { job: spec.name, effect: spec.effect, reason: refusal.reason });
      return "skipped_by_safety";
    }
  }
  await run();
  return "ran";
}
