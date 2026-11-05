/**
 * Provider exporter CLI: fetches news, sentiment, macro, calendar and market data (see docs/twins/PROVIDERS.md) and publishes the files the research agents read.
 *   provider-exporter run [provider ...]     one pass (default: all); exit 0 even if a provider failed (the report says which)
 *   provider-exporter loop [--every-min N]   repeat every N minutes (default 60, minimum 30) until SIGTERM / SIGINT
 * Environment: TWINS_PROVIDERS_DIR (/var/lib/twins-providers), TWINS_AGENT_SNAPSHOT_DIR (/var/lib/twins-snapshots, read only), TWINS_FRED_API_KEY (optional; calendar and global macro are skipped
 * without it), TWINS_PROVIDERS_WATCH (JSON watch list), TWINS_HOLIDAYS_CSV + TWINS_HOLIDAYS_MARKET/FROM/TO, TWINS_CONSTITUENTS_CSV + TWINS_CONSTITUENTS_INDEX.
 * It reads no broker credential, makes requests only to the allow-listed provider hosts, and logs fixed codes and counts only.
 */
import { readFileSync } from "node:fs";
import { enforceLiveTradingGuard } from "@twins/config";
import { ALL_PROVIDERS, runProviders, type ProviderName, type RunContext, type WatchEntry } from "../../packages/providers/src/index";

enforceLiveTradingGuard("provider-exporter"); // first statement of every TWINS process: refuses to start unless live trading is locked

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: "provider-exporter", event, ...fields }));
const env = process.env;

function buildContext(): RunContext {
  const ctx: RunContext = { providersDir: env["TWINS_PROVIDERS_DIR"] || "/var/lib/twins-providers", snapshotDir: env["TWINS_AGENT_SNAPSHOT_DIR"] || "/var/lib/twins-snapshots", now: () => new Date() };
  const key = env["TWINS_FRED_API_KEY"];
  if (key) ctx.fredApiKey = key;
  const watch = env["TWINS_PROVIDERS_WATCH"];
  if (watch) { const w = JSON.parse(watch) as WatchEntry[]; if (!Array.isArray(w) || w.some((e) => typeof e.symbol !== "string" || typeof e.market !== "string" || !Array.isArray(e.keywords))) throw new Error("TWINS_PROVIDERS_WATCH is malformed"); ctx.watch = w; }
  const h = env["TWINS_HOLIDAYS_CSV"];
  if (h) ctx.holidays = { csv: readFileSync(h, "utf8"), market: env["TWINS_HOLIDAYS_MARKET"] || "NSE", from: env["TWINS_HOLIDAYS_FROM"] || `${new Date().getUTCFullYear()}-01-01`, to: env["TWINS_HOLIDAYS_TO"] || `${new Date().getUTCFullYear()}-12-31` };
  const c = env["TWINS_CONSTITUENTS_CSV"];
  if (c) ctx.constituents = { csv: readFileSync(c, "utf8"), index: env["TWINS_CONSTITUENTS_INDEX"] || "NIFTY" };
  return ctx;
}

async function pass(names: readonly ProviderName[]): Promise<void> {
  const results = await runProviders(names, buildContext());
  for (const r of results) log(`provider.${r.status}`, r.status === "published" ? { provider: r.provider, file: r.file, count: r.count, bytes: r.bytes } : { provider: r.provider, reason: r.reason });
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "run", ...rest] = argv;
  if (cmd === "run") {
    const names = rest.length ? rest : [...ALL_PROVIDERS];
    if (names.some((n) => !(ALL_PROVIDERS as readonly string[]).includes(n))) { log("usage", { providers: ALL_PROVIDERS }); return 2; }
    await pass(names as ProviderName[]);
    return 0;
  }
  if (cmd === "loop") {
    const i = rest.indexOf("--every-min");
    const everyMin = i >= 0 ? Number(rest[i + 1]) : 60;
    if (!Number.isFinite(everyMin) || everyMin < 30) { log("usage", { error: "--every-min must be at least 30 (the providers rate-limit hard)" }); return 2; }
    let stop = false;
    for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => { stop = true; });
    while (!stop) {
      try { await pass(ALL_PROVIDERS); } catch { log("pass.failed", { reason: "unexpected" }); }
      for (let waited = 0; waited < everyMin * 60 && !stop; waited += 1) await new Promise((r) => setTimeout(r, 1000));
    }
    log("stopped");
    return 0;
  }
  log("usage", { commands: ["run", "loop"] });
  return 2;
}
void main(process.argv.slice(2)).then((code) => process.exit(code), () => { log("fatal"); process.exit(1); });
