import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConstituentsFile, parseEconomicCalendar, parseHolidayCalendar, parseMacroContext, parseNewsFile, parseQuotesFile, parseSentimentFile } from "@twins/agents";
import type { GdeltTransport } from "@twins/adapter-news";
import { buildEconomicCalendar, buildHolidayCalendar, HolidayCsvError } from "./calendar";
import { createFredClient, FRED_HOST, type FredClient } from "./fred";
import { createFetcher, ProviderFetchError, type Fetcher } from "./http";
import { NewsDataError } from "./news";
import { buildMacro } from "./macro";
import { buildConstituents, buildMarketQuotes, ConstituentsCsvError } from "./marketdata";
import { buildNews, buildSentiment, type WatchEntry } from "./news";
import { publishJson, PublishRefusedError } from "./publish";

/**
 * Runs the exporters. Every provider is independent: one that is not configured is SKIPPED with a fixed reason, one that fails is reported with a fixed reason code (never a message, never a
 * URL or a key), and a document is published only if the agents' own strict parser accepts it. Nothing here places an order, calls a broker, or writes anywhere but the providers directory.
 */
export type ProviderName = "news" | "sentiment" | "calendar" | "macro" | "market-quotes" | "holidays" | "constituents";
export const ALL_PROVIDERS: readonly ProviderName[] = ["news", "sentiment", "calendar", "macro", "market-quotes", "holidays", "constituents"];
export const FILES: Record<ProviderName, string> = { news: "news.json", sentiment: "sentiment.json", calendar: "economic-calendar.json", macro: "macro-context.json", "market-quotes": "market-quotes.json", holidays: "holiday-calendar.json", constituents: "index-constituents.json" };
export type RunResult = { provider: ProviderName; status: "published"; file: string; count: number; bytes: number } | { provider: ProviderName; status: "skipped" | "failed"; reason: string };

export interface RunContext {
  providersDir: string; snapshotDir: string; now: () => Date;
  fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  fredApiKey?: string; watch?: readonly WatchEntry[];
  holidays?: { csv: string; market: string; from: string; to: string };
  constituents?: { csv: string; index: string };
}
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
const pad = (n: number) => String(n).padStart(2, "0");
const gdeltTime = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

export function createContextClients(ctx: RunContext): { gdelt: Fetcher; fred: FredClient | null } {
  const common = { ...(ctx.fetchFn ? { fetchFn: ctx.fetchFn } : {}), ...(ctx.sleep ? { sleep: ctx.sleep } : {}) };
  return {
    gdelt: createFetcher({ allowedHosts: ["api.gdeltproject.org"], minIntervalMs: 5500, maxAttempts: 2, maxRetryAfterMs: 20_000, ...common }), // GDELT asks for one request every 5 seconds
    fred: ctx.fredApiKey ? createFredClient({ apiKey: ctx.fredApiKey, fetcher: createFetcher({ allowedHosts: [FRED_HOST], minIntervalMs: 600, maxAttempts: 3, ...common }) }) : null,
  };
}
/** The news adapter wraps transport failures; find the original fetch error (a few levels at most). */
function unwrap(e: unknown): unknown { let cur = e; for (let i = 0; i < 4; i += 1) { if (cur instanceof ProviderFetchError) return cur; const c = (cur as { cause?: unknown } | null)?.cause; if (!c) return cur; cur = c; } return cur; }
const transportOf = (fetcher: Fetcher): GdeltTransport => async ({ query, since, maxRecords }) => {
  const u = new URL(GDELT);
  u.searchParams.set("query", query); u.searchParams.set("mode", "ArtList"); u.searchParams.set("format", "JSON"); u.searchParams.set("sort", "DateDesc"); u.searchParams.set("maxrecords", String(Math.min(250, Math.max(1, maxRecords))));
  if (since) u.searchParams.set("startdatetime", gdeltTime(since));
  const body = await fetcher(u.toString());
  // Observed 2026-11-05: GDELT answers a query with no matching articles with the literal body `{}` (HTTP 200). The adapter, correctly, refuses a body without an "articles" list, so this one
  // known "no results" answer is translated into an empty list; any other shape still goes through the adapter's strict check.
  return { status: 200, bodyText: body.trim() === "{}" ? '{"articles":[]}' : body };
};

function readSnapshots(dir: string): { ohlc: unknown; last: unknown } | "snapshot_incomplete" {
  try {
    const gen = JSON.parse(readFileSync(join(dir, ".snapshot-generation.json"), "utf8")) as { status?: unknown };
    if (gen.status !== "complete") return "snapshot_incomplete";
    const ohlc = JSON.parse(readFileSync(join(dir, "ohlc.json"), "utf8")) as { format?: unknown }, last = JSON.parse(readFileSync(join(dir, "last-price.json"), "utf8")) as { format?: unknown };
    return ohlc.format === "twins-ohlc-v1" && last.format === "twins-last-price-v1" ? { ohlc, last } : "snapshot_incomplete";
  } catch { return "snapshot_incomplete"; }
}
const readExistingEvents = (dir: string): unknown[] => { try { const p = join(dir, FILES.calendar); return existsSync(p) ? ((JSON.parse(readFileSync(p, "utf8")) as { events?: unknown[] }).events ?? []) : []; } catch { return []; } };

export async function runProvider(name: ProviderName, ctx: RunContext, shared: { events?: unknown[]; gdeltLimited?: boolean } = {}): Promise<RunResult> {
  const skip = (reason: string): RunResult => ({ provider: name, status: "skipped", reason });
  const publish = (doc: unknown, validate: (r: unknown) => unknown, count: number): RunResult => { const r = publishJson(ctx.providersDir, FILES[name], doc, validate); return { provider: name, status: "published", file: FILES[name], count, bytes: r.bytes }; };
  try {
    const { gdelt, fred } = createContextClients(ctx);
    switch (name) {
      case "news": { if (shared.gdeltLimited) return skip("provider_rate_limited"); const b = await buildNews({ transport: transportOf(gdelt), ...(ctx.watch ? { watch: ctx.watch } : {}), now: ctx.now }); return publish(b.document, parseNewsFile, b.items); }
      case "sentiment": {
        if (shared.gdeltLimited) return skip("provider_rate_limited");
        const b = await buildSentiment({ fetcher: gdelt, ...(ctx.watch ? { watch: ctx.watch } : {}), now: ctx.now });
        if (b.entries > 0) return publish(b.document, parseSentimentFile, b.entries);
        if (b.errorCodes.length) { if (b.errorCodes[0]!.startsWith("rate_limited")) shared.gdeltLimited = true; return { provider: name, status: "failed", reason: `fetch_${b.errorCodes[0]}` }; }
        return skip("no_data");
      }
      case "calendar": { if (!fred) return skip("key_missing"); const b = await buildEconomicCalendar({ fred, now: ctx.now }); shared.events = (b.document["events"] as unknown[]) ?? []; return publish(b.document, parseEconomicCalendar, b.events); }
      case "macro": {
        const snap = readSnapshots(ctx.snapshotDir);
        if (snap === "snapshot_incomplete") return skip(snap);
        const b = await buildMacro({ ohlc: snap.ohlc, last: snap.last, fred, releases: shared.events ?? readExistingEvents(ctx.providersDir), now: ctx.now });
        return b === null ? skip("no_fresh_index") : publish(b.document, parseMacroContext, b.indices);
      }
      case "market-quotes": {
        const snap = readSnapshots(ctx.snapshotDir);
        if (snap === "snapshot_incomplete") return skip(snap);
        const b = buildMarketQuotes(snap.ohlc, snap.last, ctx.now());
        return b === null ? skip("no_fresh_index") : publish(b.document, parseQuotesFile, b.quotes);
      }
      case "holidays": { if (!ctx.holidays) return skip("file_not_configured"); const b = buildHolidayCalendar(ctx.holidays.csv, { ...ctx.holidays, source: "owner-supplied", now: ctx.now() }); return publish(b.document, parseHolidayCalendar, b.days); }
      case "constituents": { if (!ctx.constituents) return skip("file_not_configured"); const b = buildConstituents(ctx.constituents.csv, { index: ctx.constituents.index, source: "owner-supplied", asOf: ctx.now() }); return publish(b.document, parseConstituentsFile, b.constituents); }
    }
  } catch (raw) {
    const e = unwrap(raw);
    const reason = e instanceof ProviderFetchError ? `fetch_${e.code}${e.status ? `_${e.status}` : ""}` : e instanceof PublishRefusedError ? "refused_validation" : e instanceof NewsDataError ? "response_invalid" : e instanceof HolidayCsvError || e instanceof ConstituentsCsvError ? "csv_invalid" : "failed";
    if (e instanceof ProviderFetchError && e.code === "rate_limited" && (name === "news" || name === "sentiment")) shared.gdeltLimited = true; // GDELT said slow down: ask for nothing more in this pass
    return { provider: name, status: "failed", reason };
  }
}

/** Runs the requested providers in an order that lets the calendar feed the macro file. */
export async function runProviders(names: readonly ProviderName[], ctx: RunContext): Promise<RunResult[]> {
  const order = ALL_PROVIDERS.filter((p) => names.includes(p)), shared: { events?: unknown[]; gdeltLimited?: boolean } = {}, out: RunResult[] = [];
  for (const n of order) out.push(await runProvider(n, ctx, shared));
  return out;
}
