import { describe, expect, it } from "vitest";
import { analyzeOptionsText } from "../../../packages/signals/src/options/parse";
import type { OptionsClaim } from "../../../packages/signals/src/options/types";
import { CLASSIFIER_VERSION, RISK_BAND_PCT, classifySignal, reconstructContext, sessionBucket, storeClassification } from "../../../packages/signals/src/classification/index";

const claimOf = (text: string): OptionsClaim => { const a = analyzeOptionsText(text); if (a.kind !== "options_claim") throw new Error(`not a claim: ${text}`); return a.claim; };
// 2026-11-09 is a Monday. IST = UTC + 5:30
const MON_10_00_IST = new Date("2026-11-09T04:30:00Z");
const run = (text: string, at = MON_10_00_IST) => classifySignal({ claim: claimOf(text), messageText: text, messageTimestamp: at });

describe("signal type, horizon and setup come only from stated actions and fixed whole-word cues", () => {
  it("a BUY with entry, stop and targets is an OPTIONS_BUY with no invented horizon or setup", () => {
    const r = run("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 165 SL 96");
    expect(r).toMatchObject({ signalType: "OPTIONS_BUY", horizon: "UNKNOWN", setup: "UNKNOWN", classifierVersion: CLASSIFIER_VERSION });
    expect(r.evidenceCodes).toContain("parsed.action.buy");
  });
  it("explicit words set the horizon and the setup", () => {
    expect(run("INTRADAY BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96")).toMatchObject({ horizon: "INTRADAY" });
    expect(run("BUY BANKNIFTY 52000 PE ABOVE 210 TARGET 250 SL 172 POSITIONAL")).toMatchObject({ horizon: "POSITIONAL" });
    expect(run("BREAKOUT BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96")).toMatchObject({ setup: "BREAKOUT" });
    expect(run("BUY NIFTY 24500 PE ABOVE 118 TARGET 140 SL 96 GAP DOWN")).toMatchObject({ setup: "GAP" });
    expect(run("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96 SCALP")).toMatchObject({ setup: "SCALP", horizon: "SCALPING" });
  });
  it("conflicting cues are reported and resolved to UNKNOWN / OTHER, never guessed", () => {
    const r = run("INTRADAY POSITIONAL BREAKOUT REVERSAL BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96");
    expect(r.horizon).toBe("UNKNOWN"); expect(r.setup).toBe("OTHER"); expect(r.evidenceCodes).toEqual(expect.arrayContaining(["conflict.horizon", "conflict.setup"]));
  });
  it("without text no cue is found (nothing is guessed)", () => {
    const c = claimOf("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96");
    expect(classifySignal({ claim: c, messageText: null, messageTimestamp: MON_10_00_IST })).toMatchObject({ horizon: "UNKNOWN", setup: "UNKNOWN" });
  });
  it("the result carries cue codes only, never the message text", () => {
    const text = "SECRETWORD BREAKOUT BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96";
    expect(JSON.stringify(run(text))).not.toContain("SECRETWORD");
  });
  it("a SELL is an OPTIONS_SELL (the parser keeps its intent unresolved; this only labels the action)", () => { expect(run("SELL NIFTY 24500 CE BELOW 118 TARGET 100 SL 130").signalType).toBe("OPTIONS_SELL"); });
});

describe("structure validation", () => {
  it("a complete, consistent long signal is valid", () => { const r = run("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 165 SL 96 12 NOV"); expect(r.structureValid).toBe(true); expect(r.structureIssues).not.toContain("stop_missing"); });
  it("a missing stop, missing targets and an unspecified entry are reported", () => {
    const r = run("BUY NIFTY 24500 CE"); expect(r.structureValid).toBe(false); expect(r.structureIssues).toEqual(expect.arrayContaining(["entry_missing", "stop_missing", "targets_missing"]));
  });
  it("a long signal whose stop is above the entry, or a target below it, is flagged", () => {
    expect(run("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 130").structureIssues).toContain("stop_not_beyond_entry");
    expect(run("BUY NIFTY 24500 CE ABOVE 118 TARGET 100 SL 96").structureIssues).toContain("targets_not_beyond_entry");
    expect(run("BUY NIFTY 24500 CE ABOVE 118 TARGET 165 140 SL 96").structureIssues).toContain("targets_not_ordered");
  });
  it("an unstated level basis is flagged but does not by itself make the structure invalid", () => { const r = run("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96"); expect(r.structureIssues).toContain("level_basis_unclear"); expect(r.structureValid).toBe(true); });
});

describe("risk profile (descriptive, never used to approve)", () => {
  it("bands on stop distance; unknown stays unknown", () => {
    expect(RISK_BAND_PCT).toEqual({ conservativeMax: 15, moderateMax: 30 });
    expect(run("BUY NIFTY 24500 CE ABOVE 100 TARGET 130 SL 90").riskProfile).toBe("CONSERVATIVE");
    expect(run("BUY NIFTY 24500 CE ABOVE 100 TARGET 140 SL 75").riskProfile).toBe("MODERATE");
    expect(run("BUY NIFTY 24500 CE ABOVE 100 TARGET 160 SL 50").riskProfile).toBe("AGGRESSIVE");
    expect(run("BUY NIFTY 24500 CE ABOVE 100 TARGET 130").riskProfile).toBe("UNKNOWN"); // no stop is unknown, not aggressive
  });
});

describe("context reconstruction", () => {
  it("buckets the IST time of day, and weekends", () => {
    expect(sessionBucket(1, 9 * 60 + 20)).toBe("OPENING"); expect(sessionBucket(1, 10 * 60)).toBe("MORNING"); expect(sessionBucket(1, 12 * 60)).toBe("MIDDAY"); expect(sessionBucket(1, 14 * 60)).toBe("AFTERNOON");
    expect(sessionBucket(1, 15 * 60 + 10)).toBe("CLOSING"); expect(sessionBucket(1, 8 * 60)).toBe("OUTSIDE_SESSION"); expect(sessionBucket(6, 10 * 60)).toBe("WEEKEND"); expect(sessionBucket(0, 10 * 60)).toBe("WEEKEND");
  });
  it("converts UTC to IST before bucketing (04:30Z is 10:00 IST on a Monday)", () => {
    const c = reconstructContext(claimOf("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96"), MON_10_00_IST); expect(c).toMatchObject({ sessionBucket: "MORNING", istWeekday: 1, minutesSinceMidnightIst: 600 });
  });
  it("computes days to expiry, assuming and flagging the year (the message states none)", () => {
    const c = reconstructContext(claimOf("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96 12 NOV"), MON_10_00_IST);
    expect(c).toMatchObject({ daysToExpiry: 3, expiryYearAssumed: true, expiryStated: true });
    const past = reconstructContext(claimOf("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96 5 NOV"), MON_10_00_IST); // already passed this year: next occurrence
    expect(past.daysToExpiry).toBeGreaterThan(300);
    expect(reconstructContext(claimOf("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96"), MON_10_00_IST)).toMatchObject({ daysToExpiry: null, expiryStated: false });
  });
  it("derives stop distance, first-target distance and reward-to-risk from the stated levels only", () => {
    const c = reconstructContext(claimOf("BUY NIFTY 24500 CE ABOVE 100 TARGET 130 160 SL 90"), MON_10_00_IST);
    expect(c.stopDistancePct).toBe(10); expect(c.firstTargetDistancePct).toBe(30); expect(c.rewardToRisk).toEqual([3, 6]); expect(c.entry).toMatchObject({ kind: "above", conditional: true });
  });
  it("a range entry uses its midpoint, and unknown values stay null", () => {
    const c = reconstructContext(claimOf("BUY NIFTY 24500 CE BETWEEN 100-110 TARGET 140 SL 90"), MON_10_00_IST); expect(c.entry.low).toBe(100); expect(c.entry.high).toBe(110);
    const none = reconstructContext(claimOf("BUY NIFTY 24500 CE"), MON_10_00_IST); expect(none.stopDistancePct).toBeNull(); expect(none.rewardToRisk).toEqual([]);
  });
});

describe("completeness and storage", () => {
  it("confidence is the share of the five dimensions determined, and is not a probability", () => {
    expect(run("BUY NIFTY 24500 CE").confidence).toBe(0.2);
    expect(run("INTRADAY BREAKOUT BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96").confidence).toBe(1);
  });
  it("is deterministic", () => { const t = "INTRADAY BUY NIFTY 24500 CE ABOVE 118 TARGET 140 165 SL 96 12 NOV"; expect(run(t)).toEqual(run(t)); });
  it("stores once per claim and version, and records nothing on a re-run", async () => {
    const seen: unknown[] = []; let calls = 0;
    const db = { insert: () => ({ values: (v: unknown) => { seen.push(v); return { onConflictDoNothing: () => ({ returning: async () => (calls++ === 0 ? [{ id: "x" }] : []) }) }; } }) } as never;
    const r = run("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96");
    expect(await storeClassification(db, "claim-1", r)).toBe(true); expect(await storeClassification(db, "claim-1", r)).toBe(false);
    expect(JSON.stringify(seen)).not.toContain("BUY NIFTY"); // no message text reaches the row
  });
});

import { classifyBatch, type PendingClaim } from "../../../packages/signals/src/classification/index";
import { runCli } from "../../../scripts/ops/classify-claims";
describe("backfill batch and CLI", () => {
  const pending = (n: number): PendingClaim[] => Array.from({ length: n }, (_, i) => ({ claimId: `c${i}`, claim: claimOf("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96"), text: "BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96", at: MON_10_00_IST }));
  it("counts stored and already-recorded claims", async () => {
    const seen = new Set<string>(["c1"]);
    const r = await classifyBatch(pending(3), async (id) => { if (seen.has(id)) return false; seen.add(id); return true; });
    expect(r).toEqual({ considered: 3, stored: 2, alreadyDone: 1 });
  });
  it("the CLI validates its arguments and prints counts only", async () => {
    const out: string[] = [], err: string[] = [];
    const deps = (env: Record<string, string>) => ({ env, out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
    expect(await runCli(["--bogus"], deps({}))).toBe(2); expect(await runCli(["--limit", "0"], deps({}))).toBe(2); expect(await runCli(["--limit", "9999"], deps({}))).toBe(2);
    expect(await runCli([], deps({}))).toBe(1); expect(err.at(-1)).toBe("DATABASE_URL is not set");
    const openDb = () => ({ db: {} as never, close: async () => undefined });
    const code = await runCli([], { ...deps({ DATABASE_URL: "postgresql://x.invalid/none" }), openDb });
    expect(code).toBe(1); expect(err.at(-1)).toMatch(/^failed: /); // a fake database fails the read; nothing leaks
    expect(out).toEqual([]);
  });
});
