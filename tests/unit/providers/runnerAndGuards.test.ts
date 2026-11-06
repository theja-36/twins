import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNewsFile } from "../../../packages/agents/src/index";
import { ALL_PROVIDERS, FILES, publishJson, PublishRefusedError, runProviders, type RunContext } from "../../../packages/providers/src/index";

const KEY = "abcdef0123456789abcdef0123456789";
const NOW = new Date("2026-11-05T09:00:00.000Z");
const tmp = (): string => mkdtempSync(join(tmpdir(), "providers-"));

function snapshots(complete = true): string {
  const d = tmp();
  writeFileSync(join(d, ".snapshot-generation.json"), JSON.stringify({ status: complete ? "complete" : "building", generation: "g1" }));
  writeFileSync(join(d, "ohlc.json"), JSON.stringify({ format: "twins-ohlc-v1", series: { "NSE:NIFTY": { bars: [{ t: "2026-11-04T00:00:00+05:30", o: 24060, h: 24300, l: 24000, c: 24200 }] } } }));
  writeFileSync(join(d, "last-price.json"), JSON.stringify({ format: "twins-last-price-v1", prices: { "NSE:NIFTY": { price: 24450, as_of: "2026-11-05T08:58:00.000Z" } } }));
  return d;
}
const seen: string[] = [];
const fakeFetch = (async (input: string) => {
  const u = String(input); seen.push(u);
  const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (u.includes("api.gdeltproject.org") && u.includes("mode=ArtList")) return j({ articles: [{ url: "https://x.example/a", title: "Nifty 50 closes higher", seendate: "20261105T081500Z", domain: "x.example" }] });
  if (u.includes("api.gdeltproject.org") && u.includes("mode=timelinetone")) return j({ timeline: [{ data: [{ value: -3 }, { value: -5 }] }] });
  if (u.includes("api.gdeltproject.org") && u.includes("mode=timelinevolraw")) return j({ timeline: [{ data: [{ value: 7 }, { value: 9 }] }] });
  if (u.includes("releases/dates")) return j({ release_dates: [{ release_id: 10, release_name: "Consumer Price Index", date: "2026-11-12" }] });
  if (u.includes("series/observations")) return j({ observations: [{ date: "2026-11-04", value: "101" }, { date: "2026-11-03", value: "100" }] });
  return j({}, 404);
}) as unknown as typeof fetch;
const ctx = (o: Partial<RunContext> = {}): RunContext => ({ providersDir: join(tmp(), "out"), snapshotDir: snapshots(), now: () => NOW, fetchFn: fakeFetch, sleep: async () => undefined, fredApiKey: KEY, ...o });

describe("publishing", () => {
  it("validates before writing, writes mode 0600 atomically, and an invalid document leaves the previous good file alone", () => {
    const dir = join(tmp(), "pub");
    const good = { format: "twins-news-v1", source: "t", as_of: "2026-11-05T09:00:00.000Z", items: [] };
    const r = publishJson(dir, "news.json", good, parseNewsFile);
    expect(statSync(r.path).mode & 0o777).toBe(0o600); expect(JSON.parse(readFileSync(r.path, "utf8")).format).toBe("twins-news-v1");
    expect(() => publishJson(dir, "news.json", { ...good, format: "other" }, parseNewsFile)).toThrow(PublishRefusedError);
    expect(JSON.parse(readFileSync(r.path, "utf8")).format).toBe("twins-news-v1"); // untouched
    expect(readdirSync(dir)).toEqual(["news.json"]); // no temp file left behind
    expect(() => publishJson(dir, "../evil.json", good, parseNewsFile)).toThrow();
  });
});

describe("running the exporters", () => {
  it("publishes every provider that is configured, each file validated by the agents' own parser, in an order that lets the calendar feed the macro file", async () => {
    seen.length = 0;
    const c = ctx({ holidays: { csv: "2026-03-03,holiday,Holi\n", market: "NSE", from: "2026-01-01", to: "2026-12-31" }, constituents: { csv: "RELIANCE,9.5,Energy\n", index: "NIFTY" } });
    const r = await runProviders([...ALL_PROVIDERS], c);
    expect(r.map((x) => `${x.provider}:${x.status}`)).toEqual(ALL_PROVIDERS.map((p) => `${p}:published`));
    expect(readdirSync(c.providersDir).sort()).toEqual(Object.values(FILES).sort());
    const macro = JSON.parse(readFileSync(join(c.providersDir, FILES.macro), "utf8"));
    expect(macro.contexts["NSE:NIFTY"].releases.length).toBe(1); // the calendar's CPI event reached the macro file
    for (const u of seen) expect(u).toMatch(/^https:\/\/(api\.gdeltproject\.org|api\.stlouisfed\.org)\//);
  });
  it("constituents: several indices go into one file, each validated, with the provenance label the owner gave", async () => {
    const c = ctx({ constituents: [{ csv: "RELIANCE,50,Energy\nTCS,50,IT\n", index: "NIFTY", source: "nse-list-equal-weight" }, { csv: "HDFCBANK,50,Financial Services\nSBIN,50,Financial Services\n", index: "BANKNIFTY", source: "nse-list-equal-weight" }] });
    const r = await runProviders(["constituents"], c);
    expect(r.map((x) => `${x.provider}:${x.status}`)).toEqual(["constituents:published"]);
    const f = JSON.parse(readFileSync(join(c.providersDir, FILES.constituents), "utf8"));
    expect(Object.keys(f.indices).sort()).toEqual(["BANKNIFTY", "NIFTY"]); expect(f.source).toBe("nse-list-equal-weight");
  });
  it("skips what is not configured, with a fixed reason", async () => {
    const r = await runProviders(["calendar", "holidays", "constituents", "macro"], ctx({ fredApiKey: undefined as never }));
    expect(Object.fromEntries(r.map((x) => [x.provider, x.status === "skipped" ? x.reason : x.status]))).toEqual({ calendar: "key_missing", macro: "published", holidays: "file_not_configured", constituents: "file_not_configured" });
  });
  it("skips snapshot-based providers while the snapshot generation is not complete", async () => {
    const r = await runProviders(["macro", "market-quotes"], ctx({ snapshotDir: snapshots(false) }));
    expect(r.map((x) => (x.status === "skipped" ? x.reason : x.status))).toEqual(["snapshot_incomplete", "snapshot_incomplete"]);
  });
  it("reports a failing provider with a fixed code, keeps the others running, and leaks neither the key nor a URL", async () => {
    const failing = (async (input: string) => (String(input).includes("stlouisfed") ? new Response("boom", { status: 500 }) : fakeFetch(input as never))) as unknown as typeof fetch;
    const r = await runProviders(["news", "calendar", "macro"], ctx({ fetchFn: failing }));
    expect(r.find((x) => x.provider === "calendar")).toEqual({ provider: "calendar", status: "failed", reason: "fetch_http_error_500" });
    expect(r.find((x) => x.provider === "news")!.status).toBe("published"); expect(r.find((x) => x.provider === "macro")!.status).toBe("published"); // macro without releases and without FRED data still publishes the index
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${KEY}|api_key|https?://`));
  });
  it("a GDELT 429 ends GDELT use for the pass: the news failure is reported as fetch_rate_limited_429 and sentiment is skipped without a request", async () => {
    const limited = (async (u: string) => (String(u).includes("gdeltproject") ? new Response("slow down", { status: 429 }) : fakeFetch(u as never))) as unknown as typeof fetch;
    seen.length = 0; const calls: string[] = []; const spy = (async (u: string) => { calls.push(String(u)); return (limited as unknown as (u: string) => Promise<Response>)(u); }) as unknown as typeof fetch;
    const r = await runProviders(["news", "sentiment"], ctx({ fetchFn: spy }));
    expect(r).toEqual([{ provider: "news", status: "failed", reason: "fetch_rate_limited_429" }, { provider: "sentiment", status: "skipped", reason: "provider_rate_limited" }]);
    expect(calls.filter((c) => c.includes("timeline")).length).toBe(0); // sentiment asked for nothing
  });
  it("a bad CSV is reported as csv_invalid and publishes nothing", async () => {
    const c = ctx({ holidays: { csv: "2026-13-45,holiday,x", market: "NSE", from: "2026-01-01", to: "2026-12-31" } });
    expect((await runProviders(["holidays"], c))[0]).toEqual({ provider: "holidays", status: "failed", reason: "csv_invalid" });
    expect(() => readdirSync(c.providersDir)).toThrow();
  });
  it("treats GDELT's literal '{}' (no articles) as an empty list, but a malformed body as a failure", async () => {
    const quiet = (async (u: string) => (String(u).includes("ArtList") ? new Response("{}", { status: 200 }) : fakeFetch(u as never))) as unknown as typeof fetch;
    const c1 = ctx({ fetchFn: quiet }); expect((await runProviders(["news"], c1))[0]).toMatchObject({ status: "published", count: 0 });
    const garbage = (async () => new Response("<html>blocked</html>", { status: 200 })) as unknown as typeof fetch;
    expect((await runProviders(["news"], ctx({ fetchFn: garbage })))[0]).toEqual({ provider: "news", status: "failed", reason: "response_invalid" });
  });
});

describe("what the providers package may and may not do (static)", () => {
  const dir = join(process.cwd(), "packages/providers/src");
  const code = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")] as const);
  it("contacts only the two provider hosts, reads no environment, and has no broker, order or database access", () => {
    const hosts = new Set<string>();
    for (const [f, t] of code) {
      for (const m of t.matchAll(/https:\/\/([a-z0-9.-]+)/g)) hosts.add(m[1]!);
      expect(t, f).not.toMatch(/process\.env/); // configuration is passed in by the CLI
      expect(t, f).not.toMatch(/@twins\/kite|packages\/kite|@twins\/database|schema\.(orders|fills|positions)|placeOrder|zerodha/i);
    }
    const fredHost = /FRED_HOST = "([a-z0-9.-]+)"/.exec(code.find(([f]) => f === "fred.ts")![1])?.[1];
    expect(fredHost).toBe("api.stlouisfed.org"); // the FRED URLs are built from this constant
    const mxHost = /MARKETAUX_HOST = "([a-z0-9.-]+)"/.exec(code.find(([f]) => f === "marketaux.ts")![1])?.[1];
    expect(mxHost).toBe("api.marketaux.com"); // the Marketaux URL is built from this constant
    expect([...hosts]).toEqual(["api.gdeltproject.org"]); // every other literal https URL host would show up here
    expect(code.map(([, t]) => t).join("\n")).not.toMatch(/https:\/\/(?!api\.gdeltproject\.org|\$\{FRED_HOST\}|\$\{MARKETAUX_HOST\})/);
  });
  it("the CLI exposes no write command beyond publishing files", () => {
    const cli = readFileSync(join(process.cwd(), "scripts/ops/provider-exporter.ts"), "utf8");
    expect(cli).not.toMatch(/@twins\/(kite|database)|orders|placeOrder/);
  });
});
