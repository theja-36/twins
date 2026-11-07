import { describe, expect, it } from "vitest";
import { combinedNewsImpact, summarizeChannelNews, type ChannelNewsItem } from "../../../packages/agents/src/index";

describe("summarizeChannelNews", () => {
  it("renders the Dashboard line", () => {
    const s = summarizeChannelNews([{ items: 3, polarity: -0.2, mixed: true }, { items: 2, polarity: 0.1, mixed: true }, { items: 1, polarity: 0.4, mixed: false }], "ok");
    expect(s).toMatchObject({ available: true, clusters: 3, mixed: 2, recommendation: "CAUTION", line: "3 clusters, 2 mixed, CAUTION" });
  });
  it("is NONE when nothing is mixed or clearly negative", () => {
    expect(summarizeChannelNews([{ items: 4, polarity: 0.6, mixed: false }, { items: 1, polarity: -0.9, mixed: false }], "ok")).toMatchObject({ recommendation: "NONE", negative: 0, line: "2 clusters, 0 mixed, NONE" });
  });
  it("flags a repeated, clearly negative cluster as CAUTION", () => {
    expect(summarizeChannelNews([{ items: 2, polarity: -0.6, mixed: false }], "ok")).toMatchObject({ recommendation: "CAUTION", negative: 1, line: "1 cluster, 0 mixed, CAUTION" });
  });
  it("says 'no commentary' for an empty feed, never 'all clear'", () => {
    const s = summarizeChannelNews([], "ok");
    expect(s.line).toBe("No channel commentary");
    expect(s.available).toBe(true);
    expect(s.line.toLowerCase()).not.toContain("clear");
  });
  it("says unavailable for a missing or invalid file, and marks stale data", () => {
    expect(summarizeChannelNews([], "missing")).toMatchObject({ available: false, line: "Channel news unavailable (missing)" });
    expect(summarizeChannelNews([], "invalid").line).toBe("Channel news unavailable (invalid)");
    expect(summarizeChannelNews([{ items: 1, polarity: 0, mixed: false }], "stale").line).toBe("1 cluster, 0 mixed, NONE (stale)");
  });
  it("CAUTION CAP: whatever the input, the recommendation is NONE or CAUTION", () => {
    const extreme = Array.from({ length: 50 }, (_, i) => ({ items: i + 1, polarity: -1, mixed: i % 2 === 0 }));
    for (const status of ["ok", "stale", "missing", "invalid"] as const) expect(["NONE", "CAUTION"]).toContain(summarizeChannelNews(extreme, status).recommendation);
  });
});

describe("channel-only evidence is capped at CAUTION (pinned)", () => {
  const now = new Date("2026-11-09T06:00:00Z");
  const items: ChannelNewsItem[] = Array.from({ length: 20 }, (_, i) => ({ id: `tm-${i}`, channel: `***${1000 + (i % 7)}`, publishedAt: new Date(now.getTime() - (5 + i) * 60_000).toISOString(), symbols: ["RELIANCE"], themes: ["regulation"], polarity: -1, reliability: 1 }));
  it("never reaches REVIEW_NEW_ENTRIES, and says CHANNEL_ONLY", () => {
    const r = combinedNewsImpact([], items, { symbol: "RELIANCE", themes: ["regulation"] }, now);
    expect(r.corroboration).toBe("CHANNEL_ONLY");
    expect(r.impact.recommendation).not.toBe("REVIEW_NEW_ENTRIES");
    expect(["NONE", "CAUTION"]).toContain(r.impact.recommendation);
    expect(r.impact.grantsApproval).toBe(false);
  });
});
