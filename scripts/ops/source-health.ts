import { readFileSync } from "node:fs";
import { buildSourceHealth, observeProviderFiles, parsePassLog } from "@twins/providers";

/**
 * Source health profile (P0 #2), READ-ONLY. Reads the provider data files and, optionally, the exporter's pass log, and prints how healthy each source is. Writes nothing, calls no network,
 * prints no content from any file (only status, ages, counts and fixed reason codes).
 *
 *   node --import tsx scripts/ops/source-health.ts [--dir /var/lib/twins-providers] [--log <file|->] [--json]
 *   docker logs <exporter> 2>&1 | node --import tsx scripts/ops/source-health.ts --log -
 */
function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

const dir = arg("--dir") ?? process.env["TWINS_PROVIDERS_DIR"] ?? "/var/lib/twins-providers", logArg = arg("--log");
const events = logArg === undefined ? null : parsePassLog(readFileSync(logArg === "-" ? 0 : logArg, "utf8"));
const profile = buildSourceHealth({ now: new Date(), observations: observeProviderFiles(dir), events });

if (process.argv.includes("--json")) { process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`); process.exit(0); }
const age = (s: number | null): string => (s === null ? "-" : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);
console.log(`source health ${profile.generatedAt}: overall ${profile.overall}${profile.passLogAvailable ? "" : " (no pass log supplied)"}`);
for (const p of profile.providers) console.log(`${p.provider.padEnd(14)} ${p.status.padEnd(8)} data ${age(p.dataAgeSeconds).padEnd(5)} export ${age(p.exportAgeSeconds).padEnd(5)} count ${String(p.count ?? "-").padEnd(4)} usable ${p.usable ? "yes" : "no "} ${p.reasons.join(",")}`);
