import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCoverage, inspectInput, profileArchive, profileArchiveFromRows } from "../../../packages/historical/src/index";
import { runCli, renderProfile } from "../../../scripts/ops/archive-profile";
import { MSG, tempDir, writeJsonl, type RecordInput } from "../../support/historicalFixtures";

// SYNTHETIC archive only. The option expiry 29 OCT 2031 is in the future of the as-of below, so it counts as listed.
const NOW = new Date("2031-06-01T00:00:00Z");
const PAST_OPTION = "BUY NIFTY 24500 CE 29 OCT 2029 ABOVE 120 SL 90 TGT 150 180 premium";
const rec = (channel: string, id: number, text: string, day: number, extra: Record<string, unknown> = {}): RecordInput => ({ channel, message_id: id, timestamp: new Date(Date.UTC(2031, 0, day, 4, 0)).toISOString(), text, ...extra });
const archive = (): RecordInput[] => [
  rec("alpha", 1, MSG.equity, 1), rec("alpha", 2, MSG.completeOption, 2), rec("alpha", 3, PAST_OPTION, 3), rec("alpha", 4, MSG.noise, 4), rec("alpha", 5, MSG.equityNoStop, 5),
  rec("beta", 1, MSG.equity, 6), rec("beta", 2, MSG.completeOption, 40), rec("beta", 3, MSG.several, 41),
];
const profile = async (records: RecordInput[], market: string | null = "NSE") => {
  const dir = tempDir();
  const files = await inspectInput(writeJsonl(dir, "a.jsonl", records));
  return profileArchive(files, { label: "t", defaultMarket: market }, NOW);
};

describe("coverage classification", () => {
  const n = (o: Record<string, unknown>) => ({ parseStatus: "SIGNAL" as const, instrumentType: "equity", underlying: "RELIANCE", expiryDate: null, ...o });
  it("index underlyings, stocks, listed and expired options", () => {
    expect(classifyCoverage(n({ underlying: "NIFTY" }), "2031-06-01")).toBe("INDEX_UNDERLYING");
    expect(classifyCoverage(n({}), "2031-06-01")).toBe("STOCK_NOT_IN_CATALOG");
    expect(classifyCoverage(n({ parseStatus: "OPTIONS_CLAIM", instrumentType: "option", underlying: "NIFTY", expiryDate: "2031-10-29" }), "2031-06-01")).toBe("OPTION_LISTED");
    expect(classifyCoverage(n({ parseStatus: "OPTIONS_CLAIM", instrumentType: "option", underlying: "NIFTY", expiryDate: "2029-10-29" }), "2031-06-01")).toBe("OPTION_EXPIRED");
    expect(classifyCoverage(n({ parseStatus: "OPTIONS_CLAIM", instrumentType: "option", underlying: "NIFTY", expiryDate: "2031-06-01" }), "2031-06-01")).toBe("OPTION_LISTED");
    expect(classifyCoverage(n({ parseStatus: "OPTIONS_CLAIM", instrumentType: "option", underlying: "TCS", expiryDate: "2031-10-29" }), "2031-06-01")).toBe("STOCK_NOT_IN_CATALOG");
    expect(classifyCoverage(n({ parseStatus: "OPTIONS_CLAIM", instrumentType: "option", underlying: "NIFTY", expiryDate: null }), "2031-06-01")).toBe("NOT_ASSESSABLE");
    expect(classifyCoverage(n({ parseStatus: "NO_SIGNAL" }), "2031-06-01")).toBe("NOT_ASSESSABLE");
  });
});

describe("archive profile (dry-run tooling)", () => {
  it("counts messages, dates, channels and instruments", async () => {
    const p = await profile(archive());
    expect(p.totals).toMatchObject({ records: 8, invalid: 0, uniqueMessages: 8, revisions: 0, duplicates: 0 });
    expect(p.dateRange.first?.slice(0, 10)).toBe("2031-01-01");
    expect(p.dateRange.last?.slice(0, 10)).toBe("2031-02-10");
    expect(p.dateRange.spanDays).toBe(41);
    expect(p.byMonth).toEqual({ "2031-01": 6, "2031-02": 2 });
    expect(p.byChannel.map((c) => [c.channel, c.messages])).toEqual([["alpha", 5], ["beta", 3]]);
    expect(p.byParseStatus["NO_SIGNAL"]).toBe(1);
  });
  it("estimates Kite coverage and the bar plan", async () => {
    const p = await profile(archive());
    expect(p.barCoverage.OPTION_LISTED).toBe(2);
    expect(p.barCoverage.OPTION_EXPIRED).toBe(1);
    expect(p.barCoverage.STOCK_NOT_IN_CATALOG).toBeGreaterThanOrEqual(2);
    const parseable = p.totals.parseable;
    expect(Object.values(p.barCoverage).reduce((a, b) => a + b, 0)).toBe(parseable);
    expect(p.plausiblyVerifiableShare).toBeCloseTo(2 / parseable, 3);
    expect(p.barPlan.underlyings).toEqual(["NIFTY"]);
    expect(p.barPlan.dailyCallsEstimate).toBe(1);
    expect(p.grantsApproval).toBe(false);
    expect(p.wroteAnything).toBe(false);
  });
  it("counts invalid records and duplicates, and folds edits into revisions", async () => {
    const dir = tempDir();
    const r = archive();
    const file = writeJsonl(dir, "a.jsonl", [...r, r[0], { channel: "alpha", message_id: 99 }, { ...rec("alpha", 6, MSG.equity, 7), edits: [{ edited_at: new Date(Date.UTC(2031, 0, 7, 5)).toISOString(), text: MSG.equity.replace("2750", "2700") }] }]);
    const p = await profileArchive(await inspectInput(file), { label: "t", defaultMarket: "NSE" }, NOW);
    expect(p.totals.invalid).toBe(1);
    expect(p.totals.duplicates).toBe(1);
    expect(p.totals.revisions).toBe(1);
  });
  it("never includes message text, even from a redacted-secret message", async () => {
    const p = await profile([rec("alpha", 1, MSG.withSecret, 1), rec("alpha", 2, MSG.equity, 2)]);
    const text = JSON.stringify(p) + renderProfile(p).join("\n");
    expect(text).not.toContain("RELIANCE @ 2800");
    expect(text).not.toContain("trader@example.com");
    expect(text).not.toMatch(/\d{9}:B{5}/);
  });
  it("an empty-signal archive gives null shares, not NaN", async () => {
    const p = await profile([rec("alpha", 1, MSG.noise, 1)]);
    expect(p.totals.parseable).toBe(0);
    expect(p.plausiblyVerifiableShare).toBeNull();
    expect(p.barCoverageShare.INDEX_UNDERLYING).toBeNull();
    expect(p.barPlan.dailyCallsEstimate).toBe(0);
  });
  it("is deterministic for the same input", async () => {
    const a = JSON.stringify(await profile(archive())), b = JSON.stringify(await profile(archive()));
    expect(a).toBe(b);
  });
  it("profileArchiveFromRows needs no files", () => {
    const p = profileArchiveFromRows([], { asOf: NOW, defaultMarket: null, totals: { records: 0, invalid: 0, messageVersions: 0, uniqueMessages: 0, revisions: 0, duplicates: 0 } });
    expect(p.dateRange.spanDays).toBeNull();
  });
});

describe("archive-profile CLI", () => {
  it("prints a text report, JSON, and refuses bad usage and bad input", async () => {
    const dir = tempDir();
    const path = writeJsonl(dir, "a.jsonl", archive());
    const out: string[] = [], err: string[] = [];
    const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => NOW };
    expect(await runCli([path, "--label", "t", "--default-market", "NSE"], deps)).toBe(0);
    expect(out.join("\n")).toContain("plausibly verifiable from bars");
    out.length = 0;
    expect(await runCli([path, "--label", "t", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n")).version).toBe("archive-profile-v1");
    expect(await runCli([], deps)).toBe(2);
    expect(await runCli([path], deps)).toBe(2);
    expect(await runCli([path, "--label", "t", "--as-of", "yesterday"], deps)).toBe(2);
    expect(await runCli([join(dir, "missing.jsonl"), "--label", "t"], deps)).toBe(3);
  });
});
