import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { marketauxShapeReport } from "../../../packages/providers/src/index";

// Synthetic fixtures only; no request is made.
const NOW = new Date("2026-11-06T10:00:00.000Z");
const U = new Set(["NIFTY", "BANKNIFTY", "SENSEX", "RELIANCE"]);
const at = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const a = (uuid: string, m: number, entities: unknown[]) => ({ uuid, title: "SECRET-HEADLINE", url: "https://x.example/SECRET-URL", source: "x.example", published_at: at(m), snippet: "SECRET-SNIPPET", entities });
const body = (data: unknown[]) => JSON.stringify({ meta: { found: 9, returned: data.length, limit: 3, page: 1 }, data });

describe("Marketaux shape report", () => {
  it("reports names, types, counts and parameter checks, and never a headline, URL or snippet", async () => {
    const r = await marketauxShapeReport(body([a("1", 5, [{ symbol: "RELIANCE.NS", country: "in", sentiment_score: 0.4 }, { symbol: "^NSEI", country: "in", sentiment_score: -0.1 }]), a("2", 50, [{ symbol: "XYZ.BO", country: "in", sentiment_score: null }])]), { now: NOW, universe: U });
    expect(r.articleCount).toBe(2); expect(r.topLevelKeys).toEqual(["data", "meta"]);
    expect(r.articleKeyTypes["published_at"]).toEqual(["string"]); expect(r.entityKeyTypes["sentiment_score"]).toEqual(["null", "number"]);
    expect(r.checks).toMatchObject({ dataIsList: true, everyArticleHasEntities: true, everyPublishedAtHasOffset: true, sortedNewestFirst: true, allWithinWindow: true, scoresNumeric: 2, scoresMissing: 1, scoresOutOfRange: 0, countriesAllIndia: true });
    expect(r.symbolPatterns).toEqual({ ".NS": 1, "index (known)": 1, ".BO": 1 }); expect(r.symbolsSeen).toEqual(["RELIANCE.NS", "XYZ.BO", "^NSEI"]);
    expect(r.adapterDryRun).toMatchObject({ articles: 2, kept: 2, unmapped: 1, noScore: 0 });
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });
  it("flags what the assumptions get wrong: wrong order, stale article, article without entities, out-of-range or missing score", async () => {
    const r = await marketauxShapeReport(body([a("1", 60, [{ symbol: "^NSEI", sentiment_score: 2 }]), a("2", 5, []), a("3", 24 * 60 + 5, [{ symbol: "^NSEI" }])]), { now: NOW, universe: U });
    expect(r.checks).toMatchObject({ sortedNewestFirst: false, allWithinWindow: false, everyArticleHasEntities: false, scoresOutOfRange: 1, scoresMissing: 1, countriesAllIndia: "no country field" });
  });
  it("reports a refused answer instead of throwing from the dry run, and rejects non-JSON", async () => {
    expect((await marketauxShapeReport("{}", { now: NOW, universe: U })).adapterDryRun).toEqual({ refused: "MarketauxDataError" });
    await expect(marketauxShapeReport("nope", { now: NOW, universe: U })).rejects.toThrow();
  });
  it("the live check script refuses to run without --permission-confirmed and makes no request", () => {
    const r = spawnSync("node", ["--import", "tsx", "scripts/ops/marketaux-shape-check.ts", "--key-file", "/nonexistent"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/refused: pass --permission-confirmed/); expect(r.stdout).toBe("");
    const code = readFileSync("scripts/ops/marketaux-shape-check.ts", "utf8");
    expect(code).not.toMatch(/process\.env/); // the key comes from a file, never the environment
  });
});
