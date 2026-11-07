/**
 * Archive profile (dry-run tooling, no database): reads a LOCAL export, normalizes it in memory and prints what it contains and how much of it historical bars could verify. Writes nothing, contacts nothing,
 * prints no message text (counts, channel labels, dates, symbols and codes only; do not commit the output).
 *
 *   archive-profile <path> --label <label> [--default-market <CODE>] [--as-of <ISO with offset>] [--json]
 *
 * Exit codes: 0 ok, 2 usage, 3 refused / invalid input, 1 failure.
 */
import { pathToFileURL } from "node:url";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { parseSourceBasisConfig, SourceBasisConfigError } from "../../packages/signals/src/index";
import { inspectInput, InputError, profileArchive, type ArchiveProfile } from "../../packages/historical/src/index";

export interface CliDeps { out: (l: string) => void; err: (l: string) => void; now?: () => Date }
const USAGE = "usage: archive-profile <path> --label <label> [--default-market <CODE>] [--level-basis-default \"<source>=premium\"] [--as-of <ISO with offset>] [--json]";
const pct = (v: number | null): string => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);

export function renderProfile(p: ArchiveProfile): string[] {
  const t = p.totals;
  const L = [
    `${p.version}: ${t.records} records (${t.invalid} invalid), ${t.uniqueMessages} messages, ${t.revisions} revisions, ${t.duplicates} duplicates, ${t.parseable} parseable signals`,
    `dates: ${p.dateRange.first?.slice(0, 10) ?? "-"} .. ${p.dateRange.last?.slice(0, 10) ?? "-"} (${p.dateRange.spanDays ?? "-"} days)`,
    `instrument: ${JSON.stringify(p.byInstrumentType)}   market: ${JSON.stringify(p.byMarket)}   side: ${JSON.stringify(p.bySide)}`,
    `channels: ${p.byChannel.slice(0, 10).map((c) => `${c.channel}=${c.messages}/${c.parseable}`).join(", ") || "-"}`,
    `top underlyings (${p.distinctUnderlyings} distinct): ${p.topUnderlyings.slice(0, 10).map((u) => `${u.underlying}=${u.signals}`).join(", ") || "-"}`,
    `quality: missing SL ${p.quality.missingStopLoss}, invalid SL ${p.quality.stopLossInvalid}, ambiguous ${p.quality.ambiguous}, incomplete ${p.quality.incomplete}`,
    "bar coverage (estimate, parseable signals):",
    ...Object.entries(p.barCoverage).map(([k, v]) => `  ${k.padEnd(22)} ${String(v).padStart(6)}  ${pct(p.barCoverageShare[k as keyof typeof p.barCoverageShare])}`),
    `plausibly verifiable from bars: ${pct(p.plausiblyVerifiableShare)}`,
    `bar plan: ${p.barPlan.underlyings.join(", ") || "none"}; ~${p.barPlan.dailyCallsEstimate} daily-candle calls, ~${p.barPlan.fiveMinuteCallsEstimate} 5-minute calls (~${p.barPlan.estimatedSecondsAtHistoricalRate}s at the historical rate limit)`,
    ...p.notes.map((n) => `* ${n}`),
  ];
  return L;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [path, ...rest] = argv;
  if (!path || path.startsWith("--")) { deps.err(USAGE); return 2; }
  let basisRaw: string | undefined, label: string | undefined, market: string | null = null, asOf: Date | undefined, json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--json") json = true;
    else if (a === "--label" && rest[i + 1]) label = rest[++i];
    else if (a === "--default-market" && rest[i + 1]) market = rest[++i] as string;
    else if (a === "--level-basis-default" && rest[i + 1]) basisRaw = rest[++i] as string;
    else if (a === "--as-of" && rest[i + 1]) { const v = rest[++i] as string; asOf = new Date(v); if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(asOf.getTime())) { deps.err("--as-of must be an ISO instant with an offset"); return 2; } }
    else { deps.err(USAGE); return 2; }
  }
  if (!label) { deps.err(USAGE); return 2; }
  let sourceBasis;
  if (basisRaw !== undefined) { try { sourceBasis = parseSourceBasisConfig({ TWINS_SOURCE_DEFAULT_LEVEL_BASIS: basisRaw }); } catch (e) { if (e instanceof SourceBasisConfigError) { deps.err("--level-basis-default must look like <source>=premium[,<source>=premium]"); return 2; } throw e; } }
  try {
    const files = await inspectInput(path);
    const profile = await profileArchive(files, { label, defaultMarket: market, ...(sourceBasis ? { sourceBasis } : {}) }, asOf ?? deps.now?.() ?? new Date());
    if (json) deps.out(JSON.stringify(profile, null, 2)); else for (const l of renderProfile(profile)) deps.out(l);
    return 0;
  } catch (error) {
    if (error instanceof InputError) { deps.err(`refused: ${error.code}`); return 3; }
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("archive-profile");
  runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c), () => process.exit(1));
}
