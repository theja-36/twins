import { describe, expect, it } from "vitest";
import { channelLabelOf, captureRowsToRecords, inspectInput, profileArchive, type CaptureRow } from "../../../packages/historical/src/index";
import { renderStats, runCli } from "../../../scripts/ops/capture-export";
import { MSG, tempDir, writeJsonl } from "../../support/historicalFixtures";

// SYNTHETIC rows only.
const T = (m: number): Date => new Date(Date.UTC(2031, 0, 5, 4, m));
const row = (o: Partial<CaptureRow> = {}): CaptureRow => ({ sourceId: "s1", channelIdentifier: "-100123456789012", displayName: "Alpha Calls", externalId: "10", originId: null, messageTimestamp: T(0), editDate: null, rawText: MSG.completeOption, firstSeenEdited: false, captureMethod: "api_live", ...o });

describe("channel label", () => {
  it("prefers the display name and keeps only contract characters", () => {
    expect(channelLabelOf({ channelIdentifier: "-100123", displayName: "Alpha Calls" })).toBe("Alpha Calls");
    expect(channelLabelOf({ channelIdentifier: "-100123", displayName: null })).toBe("-100123");
    expect(channelLabelOf({ channelIdentifier: "x", displayName: "A/B*C" })).toBe("A_B_C");
    expect(channelLabelOf({ channelIdentifier: "x", displayName: "   " })).toBe("x");
    expect(channelLabelOf({ channelIdentifier: "x".repeat(200), displayName: null })).toHaveLength(80);
  });
});

describe("captureRowsToRecords (pure)", () => {
  it("exports an original and attaches its later revision as an EDIT, never as a message", () => {
    const { records, stats } = captureRowsToRecords([row(), row({ externalId: "10_edit_1", originId: "10", editDate: T(30), rawText: MSG.completeOption.replace("SL 90", "SL 60") })]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ channel: "Alpha Calls", message_id: "10", timestamp: T(0).toISOString(), text: MSG.completeOption });
    expect(records[0]?.edits).toEqual([{ edited_at: T(30).toISOString(), text: MSG.completeOption.replace("SL 90", "SL 60") }]);
    expect(stats).toMatchObject({ rowsRead: 2, messagesExported: 1, revisionsAttached: 1, revisionsOrphaned: 0, channels: 1 });
  });
  it("skips a revision with no original (never promotes it to a message) and counts it", () => {
    const { records, stats } = captureRowsToRecords([row({ externalId: "11_edit_1", originId: "11", editDate: T(5) })]);
    expect(records).toEqual([]);
    expect(stats.revisionsOrphaned).toBe(1);
  });
  it("excludes messages first seen already edited by default and includes them only on request", () => {
    const rows = [row({ firstSeenEdited: true }), row({ externalId: "12", messageTimestamp: T(2) })];
    const a = captureRowsToRecords(rows);
    expect(a.records.map((r) => r.message_id)).toEqual(["12"]);
    expect(a.stats.firstSeenEditedExcluded).toBe(1);
    const b = captureRowsToRecords(rows, { includeFirstSeenEdited: true });
    expect(b.records).toHaveLength(2);
    expect(b.stats.firstSeenEditedIncluded).toBe(1);
  });
  it("skips empty text and unusable ids, truncates oversize text, caps edits, and counts each", () => {
    const edits = Array.from({ length: 55 }, (_, i) => row({ externalId: `10_e${i}`, originId: "10", editDate: T(i + 1), rawText: `edit ${i}` }));
    const { records, stats } = captureRowsToRecords([row(), row({ externalId: "13", rawText: "  " }), row({ externalId: "bad id!" }), row({ externalId: "14", rawText: "x".repeat(25_000) }), ...edits]);
    expect(records.map((r) => r.message_id)).toEqual(["10", "14"]);
    expect(records[0]?.edits).toHaveLength(50);
    expect(records[1]?.text).toHaveLength(20_000);
    expect(stats).toMatchObject({ emptyTextSkipped: 1, badIdSkipped: 1, editsTruncated: 5, textTruncated: 1 });
  });
  it("keeps sources apart even when message ids collide, and counts capture methods", () => {
    const { records, stats } = captureRowsToRecords([row(), row({ sourceId: "s2", displayName: "Beta", captureMethod: "api_history" })]);
    expect(records.map((r) => r.channel).sort()).toEqual(["Alpha Calls", "Beta"]);
    expect(stats.channels).toBe(2);
    expect(stats.byCaptureMethod).toEqual({ api_live: 1, api_history: 1 });
  });
  it("is deterministic regardless of input order", () => {
    const rows = [row(), row({ externalId: "11", messageTimestamp: T(3) }), row({ externalId: "10_e", originId: "10", editDate: T(9), rawText: "later" })];
    expect(JSON.stringify(captureRowsToRecords(rows))).toBe(JSON.stringify(captureRowsToRecords([...rows].reverse())));
  });
  it("an exported file round-trips through the importer's own reader and the archive profiler", async () => {
    const { records } = captureRowsToRecords([row(), row({ externalId: "11", messageTimestamp: T(3), rawText: MSG.equity }), row({ externalId: "11_e", originId: "11", editDate: T(8), rawText: MSG.equity.replace("2750", "2700") })]);
    const file = writeJsonl(tempDir(), "cap.jsonl", records);
    const p = await profileArchive(await inspectInput(file), { label: "cap", defaultMarket: "NSE" }, new Date("2031-06-01T00:00:00Z"));
    expect(p.totals).toMatchObject({ records: 2, invalid: 0, uniqueMessages: 2, revisions: 1 });
    expect(p.totals.parseable).toBeGreaterThanOrEqual(2);
  });
});

describe("capture-export CLI (arguments only; the database path is covered by the integration test)", () => {
  const deps = { env: {} as Record<string, string | undefined>, out: () => undefined, err: () => undefined };
  it("rejects bad usage and a missing DATABASE_URL", async () => {
    expect(await runCli([], deps)).toBe(2);
    expect(await runCli(["--out", "x.jsonl", "--since", "yesterday"], deps)).toBe(2);
    expect(await runCli(["--out", "x.jsonl", "--capture-method", "nope"], deps)).toBe(2);
    expect(await runCli(["--bogus"], deps)).toBe(2);
    expect(await runCli(["--out", "x.jsonl"], deps)).toBe(1);
  });
  it("renders counts only", () => {
    const s = captureRowsToRecords([row()]).stats;
    const text = renderStats(s).join("\n");
    expect(text).toContain("1 messages");
    expect(text).not.toContain("BUY NIFTY");
  });
});
