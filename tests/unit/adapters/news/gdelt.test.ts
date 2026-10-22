import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GdeltNewsAdapter, parseGdeltArticleList, parseGdeltSeendate, type GdeltTransport } from "../../../../adapters/news/src/gdelt";
import { newsProviders } from "../../../../adapters/news/src";
import { checkNewsItemQuality } from "../../../../packages/ingestion/src/dataQuality";
import { computeNewsDedupeHash } from "../../../../packages/ingestion/src/dedupe";
import { ProviderDataError, ProviderUnavailableError } from "../../../../packages/types/src";

const fx = (n: string) => readFileSync(`tests/fixtures/news/gdelt-${n}.TEST-FIXTURE.json`, "utf8");
const RET = new Date("2026-10-21T00:00:00Z");
const parse = (body: string, o: Partial<Parameters<typeof parseGdeltArticleList>[1]> = {}) => parseGdeltArticleList(body, { retrievedAt: RET, query: "test-query", ...o });
const transportOf = (status: number, bodyText: string): GdeltTransport => vi.fn(async () => ({ status, bodyText }));

describe("GDELT parser", () => {
  it("normalizes a valid response preserving only supplied fields, with tier D and honest timestamp semantics", () => {
    const { items, report } = parse(fx("valid"));
    expect(report.status).toBe("ok");
    expect(items).toHaveLength(3);
    const a = items[0]!;
    expect(a).toMatchObject({ sourceName: "gdelt-doc", sourceTier: "D", sourceUrl: "https://example.invalid/a1", headline: "TESTFIXTURE headline one" });
    expect(a.sourceTimestamp.toISOString()).toBe("2026-10-20T14:30:00.000Z");
    expect(a).not.toHaveProperty("publishedAt");
    expect(a).not.toHaveProperty("bodyExcerpt");
    expect(a.rawPayload).toMatchObject({ timestampField: "seendate", timestampRaw: "20261020T143000Z", publishedAtVerified: false, retrievedAt: RET.toISOString(), domain: "example.invalid", language: "English", sourceCountry: "India", provider: "gdelt-doc" });
    expect((a.rawPayload as { hashScope: string }).hashScope).toMatch(/not an article-body hash/);
    expect((a.rawPayload as { recordHash: string }).recordHash).toMatch(/^[0-9a-f]{64}$/);
    // optional fields stay absent (null), never invented
    expect(items[2]!.rawPayload).toMatchObject({ domain: null, language: null, sourceCountry: null });
    expect(items.map((i) => i.sourceUrl)).not.toContain(undefined);
  });
  it("has a stable, content-sensitive record hash", () => {
    const h = (b: string) => (parse(b).items[0]!.rawPayload as { recordHash: string }).recordHash;
    expect(h(fx("valid"))).toBe(h(fx("valid")));
    expect(h(fx("valid"))).not.toBe(h(fx("valid").replace("headline one", "headline ONE")));
  });
  it("a valid empty result is `empty`, distinct from failed", () => {
    const { items, report } = parse(fx("empty"));
    expect(items).toEqual([]);
    expect(report.status).toBe("empty");
  });
  it("mixed validity: keeps the valid, counts every rejection by reason, status partial", () => {
    const { items, report } = parse(fx("mixed"));
    expect(report.status).toBe("partial");
    expect(items.map((i) => i.sourceUrl)).toEqual(["https://example.invalid/ok", "https://example.invalid/inj"]);
    expect(report.rejected).toEqual({ duplicate_url: 2, url_invalid: 2, url_credentials: 1, title_missing: 1, seendate_missing: 1, seendate_invalid: 2, optional_field_invalid_type: 1, not_an_object: 1 });
    expect(report.articlesSeen).toBe(13);
  });
  it("treats headlines as inert data: an instruction-like title is just a title, with no verdict fields", () => {
    const inj = parse(fx("mixed")).items.find((i) => i.sourceUrl.endsWith("/inj"))!;
    expect(inj.headline).toContain("APPROVE");
    expect(Object.keys(inj).sort()).toEqual(["headline", "rawPayload", "sourceName", "sourceTier", "sourceTimestamp", "sourceUrl"]);
    expect(JSON.stringify(inj)).not.toMatch(/sentiment|probab|recommend|approv(ed|al)Possible/i);
  });
  it("malformed responses fail honestly and are never an empty success", () => {
    for (const body of ["not json", "[]", "null", "{}", '{"articles":"x"}', '{"articles":{}}']) {
      const { items, report } = parse(body);
      expect(report.status, body).toBe("failed");
      expect(items).toEqual([]);
      expect(report.failure).toBeTruthy();
    }
    expect(parse('{"articles":[{"url":"bad"}]}').report.status).toBe("failed"); // all rejected
  });
  it("enforces the response-size bound before parsing and the item cap with a truncation count", () => {
    expect(parse(fx("valid"), { maxResponseBytes: 50 }).report.failure).toMatch(/exceeds/);
    const body = JSON.stringify({ articles: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.invalid/${i}`, title: `T${i}`, seendate: "20261020T143000Z" })) });
    const r = parse(body, { maxItems: 4 });
    expect(r.items).toHaveLength(4);
    expect(r.report.truncatedByItemCap).toBe(6);
    expect(r.report.status).toBe("partial");
  });
  it("applies the `since` bound by seendate and counts what it dropped", () => {
    const r = parse(fx("valid"), { since: new Date("2026-10-20T00:00:00Z") });
    expect(r.items).toHaveLength(2);
    expect(r.report.rejected["before_since"]).toBe(1);
  });
  it("accepts only the strict seendate format", () => {
    expect(parseGdeltSeendate("20261020T143000Z")?.toISOString()).toBe("2026-10-20T14:30:00.000Z");
    for (const bad of ["2026-10-20T14:30:00Z", "20261020", "20261020T1430Z", "20260230T000000Z", 20261020, null, ""]) expect(parseGdeltSeendate(bad), String(bad)).toBeNull();
  });
});

describe("compatibility with the existing news path", () => {
  it("accepted items pass the existing quality check, and duplicates share the existing dedupe hash", () => {
    for (const i of parse(fx("valid")).items) expect(checkNewsItemQuality({ headline: i.headline, sourceUrl: i.sourceUrl, sourceTimestamp: i.sourceTimestamp }).valid).toBe(true);
    expect(computeNewsDedupeHash("https://example.invalid/a2/")).toBe(computeNewsDedupeHash("https://example.invalid/A2"));
  });
});

describe("GdeltNewsAdapter (injected transport)", () => {
  const mk = (t: GdeltTransport, extra = {}) => new GdeltNewsAdapter({ transport: t, query: "test-query", now: () => RET, ...extra });
  it("requires an explicit transport-backed construction and a query; it is a tier-D NewsProvider and is not registered", () => {
    expect(() => new GdeltNewsAdapter({ transport: transportOf(200, "{}"), query: "  " })).toThrow(/query/);
    const a = mk(transportOf(200, fx("valid")));
    expect(a.sourceTier).toBe("D");
    expect(a.providerName).toBe("gdelt-doc");
    expect(() => newsProviders.get("gdelt-doc")).toThrow();
  });
  it("fetchLatest returns items; retrieval time is the actual retrieval, not the source time", async () => {
    const t = transportOf(200, fx("valid"));
    const items = await mk(t).fetchLatest({});
    expect(items).toHaveLength(3);
    expect((items[0]!.rawPayload as { retrievedAt: string }).retrievedAt).toBe(RET.toISOString());
    expect(items[0]!.sourceTimestamp.getTime()).toBeLessThan(RET.getTime());
    expect(t).toHaveBeenCalledWith(expect.objectContaining({ query: "test-query", maxRecords: 250 }));
  });
  it("a valid empty response returns [] while a malformed one throws a data error", async () => {
    expect(await mk(transportOf(200, fx("empty"))).fetchLatest({})).toEqual([]);
    await expect(mk(transportOf(200, "garbage")).fetchLatest({})).rejects.toBeInstanceOf(ProviderDataError);
  });
  it("transport errors and HTTP failures are typed unavailable errors, never empty results", async () => {
    await expect(mk(vi.fn(async () => { throw new Error("socket hang up"); })).fetchLatest({})).rejects.toBeInstanceOf(ProviderUnavailableError);
    for (const status of [429, 500, 404]) await expect(mk(transportOf(status, "{}")).fetchLatest({}), String(status)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
  it("fetchWithReport exposes the partial report and health reflects only the last fetch (no probe)", async () => {
    const a = mk(transportOf(200, fx("mixed")));
    expect((await a.getHealth()).status).toBe("degraded");
    const r = await a.fetchWithReport({});
    expect(r.report.status).toBe("partial");
    expect((await a.getHealth()).status).toBe("healthy");
    const bad = mk(transportOf(500, ""));
    await bad.fetchLatest({}).catch(() => undefined);
    expect((await bad.getHealth()).status).toBe("down");
  });
  it("source has no fetch/network/body-fetching code", () => {
    const src = readFileSync("adapters/news/src/gdelt.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bfetch\s*\(|globalThis\.fetch|node:https?|node:net|axios|undici|child_process/);
  });
});
