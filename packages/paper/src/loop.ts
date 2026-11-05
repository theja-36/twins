import type { Db } from "@twins/database";
import type { PaperConfig } from "./config";
import type { PriceSource } from "./prices";
import { runPaperCycle, type CycleResult } from "./service";

export interface PaperLoopDeps { db: Db; config: PaperConfig; prices: PriceSource; log: (event: string, fields: Record<string, string | number | boolean>) => void; intervalMs?: number }

/** Runs the paper cycle on a timer. Never overlaps itself, never throws into the caller, logs counts and an error CLASS only (never a message). Returns a stopper. */
export function startPaperLoop(d: PaperLoopDeps): { stop: () => void; runOnce: () => Promise<CycleResult | null> } {
  let running = false;
  const runOnce = async (): Promise<CycleResult | null> => {
    if (running) return null;
    running = true;
    try {
      const r = await runPaperCycle(d.db, { config: d.config, prices: d.prices });
      const busy = r.created + r.closed + r.cancelled + r.squaredOff + r.invalid > 0;
      if (busy) d.log("paper.cycle", { created: r.created, invalid: r.invalid, stepped: r.stepped, noPrice: r.noPrice, stalePrice: r.stalePrice, closed: r.closed, cancelled: r.cancelled, squaredOff: r.squaredOff, events: r.events });
      return r;
    } catch (e) {
      d.log("paper.cycle.failed", { errorName: e instanceof Error ? e.name.slice(0, 60) : "unknown" });
      return null;
    } finally { running = false; }
  };
  const timer = setInterval(() => { void runOnce(); }, d.intervalMs ?? 30_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce };
}
