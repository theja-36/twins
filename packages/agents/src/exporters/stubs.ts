/**
 * Data-exporter STUBS (structure only). The research agents read versioned JSON files named by settings (`TWINS_AGENT_*_PROVIDER` = `file:<path>`); today nothing writes five of those files, so
 * the agents that need them report UNAVAILABLE (never a pass). Each stub below describes ONE future exporter: which file it will write, in which format, which setting points the agents at it,
 * and which credential the owner must supply. Every stub is inert: it performs no network call, reads no credential and writes no file; `run()` always answers NOT_CONFIGURED.
 * A real exporter replaces its stub in its own reviewed task, after the owner chooses a vendor and supplies the key (Q-004).
 */
export type ExporterKind = "calendar" | "news" | "macro" | "sentiment" | "market-data";
export interface ExporterStub {
  kind: ExporterKind;
  /** File names (inside the snapshot directory) the real exporter would publish, with their format ids. */
  outputs: ReadonlyArray<{ file: string; format: string }>;
  /** The agent settings that would be set to `file:<snapshot dir>/<file>` once the exporter exists. */
  settings: readonly string[];
  /** What the owner must provide. Values are never read by the stub. */
  requires: readonly string[];
  /** The agents that stay UNAVAILABLE until then. */
  agents: readonly string[];
}
export interface ExporterRunResult { status: "NOT_CONFIGURED"; kind: ExporterKind; reason: "exporter_not_implemented" }

export const EXPORTER_STUBS: readonly ExporterStub[] = [
  { kind: "calendar", outputs: [{ file: "holiday-calendar.json", format: "twins-holiday-calendar-v1" }, { file: "economic-calendar.json", format: "twins-economic-calendar-v1" }], settings: ["TWINS_AGENT_HOLIDAY_CALENDAR", "TWINS_AGENT_ECONOMIC_CALENDAR"], requires: ["economic-calendar vendor + API key (or an owner-maintained file)"], agents: ["market-calendar-v1"] },
  { kind: "news", outputs: [{ file: "news.json", format: "twins-news-v1" }], settings: ["TWINS_AGENT_NEWS_PROVIDER"], requires: ["news vendor + API key"], agents: ["news-sentiment-v1"] },
  { kind: "sentiment", outputs: [{ file: "sentiment.json", format: "twins-sentiment-v1" }], settings: ["TWINS_AGENT_SENTIMENT_PROVIDER"], requires: ["sentiment source / vendor + API key"], agents: ["news-sentiment-v1"] },
  { kind: "macro", outputs: [{ file: "macro-context.json", format: "twins-macro-context-v1" }], settings: ["TWINS_AGENT_MACRO_PROVIDER"], requires: ["macro / global-markets data vendor + API key"], agents: ["macro-global-v1"] },
  { kind: "market-data", outputs: [{ file: "index-constituents.json", format: "twins-index-constituents-v1" }, { file: "market-quotes.json", format: "twins-market-quotes-v1" }], settings: ["TWINS_AGENT_CONSTITUENT_PROVIDER", "TWINS_AGENT_MARKET_DATA_PROVIDER"], requires: ["index-constituent list + a quote source (index and option quotes already arrive through the existing market-data subscription; constituents need a source)"], agents: ["index-constituent-impact-v1"] },
];

export function exporterStub(kind: ExporterKind): ExporterStub {
  const s = EXPORTER_STUBS.find((x) => x.kind === kind);
  if (!s) throw new Error("unknown exporter kind");
  return s;
}
/** Inert: reports that the exporter does not exist. Never touches the network, a credential or the file system. */
export async function runExporterStub(kind: ExporterKind): Promise<ExporterRunResult> {
  exporterStub(kind);
  return { status: "NOT_CONFIGURED", kind, reason: "exporter_not_implemented" };
}
