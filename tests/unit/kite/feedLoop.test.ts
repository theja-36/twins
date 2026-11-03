import { describe, expect, it } from "vitest";
import { feedWindowOpen, loadMarketHours, runFeedLoop } from "../../../packages/kite/src/index";

const hours = loadMarketHours({});
function sim(startIso: string, over: { prepareFails?: number; cycleFails?: number; healthAfter?: number } = {}) {
  let t = Date.parse(startIso);
  const log: string[] = [];
  const calls = { prepare: 0, cycle: 0, close: 0, sleeps: [] as number[] };
  let prepared = false, prepFails = over.prepareFails ?? 0, cycFails = over.cycleFails ?? 0, ticks = 0;
  const service = {
    ready: () => prepared,
    prepareDay: async () => { calls.prepare += 1; if (prepFails-- > 0) throw Object.assign(new Error("x"), { code: "MALFORMED_RESPONSE" }); prepared = true; },
    cycle: async () => { calls.cycle += 1; if (cycFails-- > 0) throw new Error("boom"); return { published: true as const, generation: "g", kinds: [] }; },
  };
  const deps = {
    service, hours, now: () => new Date(t), log: (e: string) => { log.push(e); },
    sleep: async (ms: number) => { calls.sleeps.push(ms); t += ms; ticks += 1; },
    intervalMs: 60_000, onWindowClose: () => { calls.close += 1; prepared = false; },
    health: over.healthAfter ? () => (ticks >= (over.healthAfter as number) ? "auth_failed" : null) : undefined,
    shouldStop: () => t > Date.parse(startIso) + 20 * 3600_000 || false,
  };
  return { deps, calls, log };
}

describe("runFeedLoop (simulated clock, no timers, no network)", () => {
  it("does nothing before the window, prepares once when it opens, cycles every interval, closes once, and stays idle overnight", async () => {
    const s = sim("2026-11-03T02:00:00Z"); // 07:30 IST Tuesday
    expect(await runFeedLoop(s.deps)).toBe("stopped");
    expect(s.calls.prepare).toBe(1);
    expect(s.calls.close).toBe(1);
    // window 08:55 -> 15:40 IST = 405 minutes: about one cycle per minute
    expect(s.calls.cycle).toBeGreaterThan(395);
    expect(s.calls.cycle).toBeLessThan(415);
    expect(s.log.filter((e) => e === "kite.feed.window_open")).toHaveLength(1);
    expect(s.log.filter((e) => e === "kite.feed.window_closed")).toHaveLength(1);
    expect(Math.max(...s.calls.sleeps)).toBeLessThanOrEqual(60_000); // idle sleeps are capped
  });
  it("never cycles on a weekend or a holiday", async () => {
    const sat = sim("2026-11-07T02:00:00Z");
    await runFeedLoop(sat.deps);
    expect(sat.calls.cycle).toBe(0);
    const hol = sim("2026-11-10T02:00:00Z");
    hol.deps.hours = loadMarketHours({ TWINS_KITE_HOLIDAYS: "2026-11-10" });
    expect(feedWindowOpen(new Date("2026-11-10T06:00:00Z"), hol.deps.hours)).toBe(false);
    await runFeedLoop(hol.deps);
    expect(hol.calls.cycle).toBe(0);
  });
  it("a failing preparation or cycle is retried later, never a crash and never a tight loop", async () => {
    const s = sim("2026-11-03T03:30:00Z", { prepareFails: 2, cycleFails: 2 });
    await runFeedLoop(s.deps);
    expect(s.calls.prepare).toBe(3);
    expect(s.calls.cycle).toBeGreaterThan(300);
    expect(s.log.filter((e) => e === "kite.feed.cycle_failed")).toHaveLength(4);
    expect(s.calls.sleeps.filter((ms) => ms === 30_000).length).toBeGreaterThanOrEqual(4);
  });
  it("stops with a reason when the health check fails (e.g. the ticker's authentication was rejected)", async () => {
    const s = sim("2026-11-03T04:00:00Z", { healthAfter: 5 });
    expect(await runFeedLoop(s.deps)).toEqual({ stoppedBecause: "auth_failed" });
    expect(s.calls.cycle).toBe(5);
  });
});
