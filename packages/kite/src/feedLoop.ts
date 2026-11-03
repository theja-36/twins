import { feedWindowOpen, msUntilFeedWindow, type MarketHoursConfig } from "./marketHours";
import type { CycleOutcome, KiteFeedService } from "./feedService";

/**
 * The scheduler of the Kite feed (P0-3), as a plain loop with injected time. It does nothing outside the feed window (the sleep is capped, so a clock jump or a changed holiday list is noticed),
 * prepares the day once when the window opens, runs one export cycle per interval, and calls `onWindowClose` once when the window ends. A failing preparation or cycle is logged and retried on
 * the next tick - never a crash loop and never a published partial generation (the service's publisher is all-or-nothing). `shouldStop` ends the loop (SIGTERM).
 */
export interface FeedLoopDeps {
  service: Pick<KiteFeedService, "prepareDay" | "cycle" | "ready">;
  hours: MarketHoursConfig;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  intervalMs: number;
  onWindowClose?: () => void;
  /** Return a reason to stop the loop (e.g. the ticker's authentication failed), or null. */
  health?: () => string | null;
  shouldStop: () => boolean;
}
export type LoopEnd = "stopped" | { stoppedBecause: string };
const MAX_IDLE_SLEEP_MS = 60_000;
const RETRY_MS = 30_000;

export async function runFeedLoop(d: FeedLoopDeps): Promise<LoopEnd> {
  let wasOpen = false;
  while (!d.shouldStop()) {
    const now = d.now();
    if (!feedWindowOpen(now, d.hours)) {
      if (wasOpen) { wasOpen = false; d.log("kite.feed.window_closed"); d.onWindowClose?.(); }
      const wait = msUntilFeedWindow(now, d.hours);
      await d.sleep(Math.min(MAX_IDLE_SLEEP_MS, Math.max(1000, wait ?? MAX_IDLE_SLEEP_MS)));
      continue;
    }
    if (!wasOpen) { wasOpen = true; d.log("kite.feed.window_open"); }
    const unhealthy = d.health?.() ?? null;
    if (unhealthy) { d.log("kite.feed.stopping", { reason: unhealthy }); return { stoppedBecause: unhealthy }; }
    try {
      if (!d.service.ready()) await d.service.prepareDay();
      const out: CycleOutcome = await d.service.cycle();
      if (!out.published) d.log("kite.feed.cycle_not_published", { reason: out.reason });
    } catch (e) {
      d.log("kite.feed.cycle_failed", { code: (e as { code?: string }).code ?? "error" });
      await d.sleep(RETRY_MS);
      continue;
    }
    await d.sleep(d.intervalMs);
  }
  return "stopped";
}
