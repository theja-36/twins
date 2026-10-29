/**
 * EXPLICIT, OFFLINE import of a Dhan instrument-master CSV that YOU downloaded separately. This command never downloads
 * anything, never runs in the background and is never invoked at startup. It reads one local CSV, validates it, and
 * writes a provider snapshot JSON (default: data/options-snapshots/, git-ignored).
 *
 *   npm run options:import-dhan -- --csv <local file> --source-url <https url you downloaded it from> \
 *       [--retrieved-at <ISO instant>] [--out <snapshot path>]
 *
 * Without --retrieved-at the file's modification time is used and the snapshot says so (an ESTIMATE). Enable the
 * snapshot only by explicit configuration: TWINS_OPTIONS_PROVIDER_SNAPSHOT=<path> for the worker, or
 * `--provider-snapshot <path>` for options:preview. Provider-listed is NOT exchange-independent verification, live
 * entitlement or proof of current tradability. Exit codes: 0 imported, 1 import failed, 2 usage error.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enforceLiveTradingGuard } from "../packages/config/src/liveGuard";
import { installNetworkGuard } from "../tests/support/networkGuard";
import { buildDhanSnapshot, DhanImportError } from "../packages/signals/src/options/dhanImport";

installNetworkGuard();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(argv: string[]): number {
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!["--csv", "--source-url", "--retrieved-at", "--out"].includes(a)) { console.error(`usage error: unknown argument ${JSON.stringify(a)}`); return 2; }
    opt[a] = argv[++i] ?? "";
  }
  const csv = opt["--csv"], url = opt["--source-url"];
  if (!csv || !url) { console.error("usage: npm run options:import-dhan -- --csv <local file> --source-url <https url> [--retrieved-at <ISO>] [--out <path>]"); return 2; }
  if (/^[a-z]+:\/\//i.test(csv)) { console.error("usage error: --csv must be a LOCAL file path; this command does not download."); return 2; }
  try {
    const csvText = readFileSync(csv, "utf8");
    const given = opt["--retrieved-at"];
    const retrievedAt = given ?? statSync(csv).mtime.toISOString();
    const snapshot = buildDhanSnapshot({ csvText, sourceUrl: url, retrievedAt: new Date(retrievedAt).toISOString(), retrievalTimeSource: given ? "owner_supplied" : "file_mtime_estimate", importedAt: new Date().toISOString() });
    if (snapshot.counts.kept === 0) { console.error("import FAILED: no supported index-option rows were kept; nothing written."); return 1; }
    const out = resolve(opt["--out"] ?? `${root}/data/options-snapshots/dhan-${snapshot.source.contentSha256.slice(0, 12)}.snapshot.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`Imported ${snapshot.counts.kept} of ${snapshot.counts.rowsRead} rows (${snapshot.source.csvFormat}).`);
    console.log(`  skipped: ${JSON.stringify(snapshot.counts.skipped)}`);
    console.log(`  rejected: ${JSON.stringify(snapshot.counts.rejected)}`);
    console.log(`  sha256: ${snapshot.source.contentSha256}`);
    console.log(`  retrieved: ${snapshot.source.retrievedAt} (${snapshot.source.retrievalTimeSource})`);
    console.log(`  wrote: ${out}`);
    console.log("  NOTE: provider-listed only - not exchange-independent verification, live entitlement or proof of current tradability.");
    console.log("  Not enabled anywhere: set TWINS_OPTIONS_PROVIDER_SNAPSHOT or pass --provider-snapshot explicitly.");
    return 0;
  } catch (err) {
    console.error(`import FAILED: ${err instanceof DhanImportError ? err.message : err instanceof Error ? `${err.name}` : "unknown error"}`);
    return 1;
  }
}

enforceLiveTradingGuard("options-import-dhan");
process.exit(main(process.argv.slice(2)));
