/**
 * Operations CLI for the historical archive import (Stage 4 / Task 1). A LOCAL, user-provided export only (JSONL / JSON / CSV, see packages/historical/src/contract.ts): it never
 * contacts Telegram, needs no bot or user API access, and refuses session / credential-like files. Nothing is imported automatically anywhere; there is no compose service for it.
 *
 *   historical-import validate <path>                                  validate the input and print the summary (no database)
 *   historical-import dry-run  <path> --label <label> [--default-market <CODE>] [--level-basis-default "<source>=premium"]   the summary, plus how many versions are already imported (read-only database access)
 *   historical-import import   <path> --label <label> --created-by operator:<name> --confirm-source <path> --confirm-manifest <12+ hex of the dry-run manifest>
 *                              [--default-market <CODE>] [--chunk-size N] [--allow-invalid]
 *   historical-import report   --batch <uuid>
 *
 * `import` writes only after an explicit confirmation of the exact source path and of the manifest hash the dry run printed (so the operator has seen THIS input). It is resumable:
 * re-run the same command and it continues after the last checkpoint (a completed import is a no-op). Output carries counts, codes and ids only - never message content.
 * Exit codes: 0 ok, 1 failure, 2 usage error, 3 refused / invalid input. The connection string is never printed.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { parseSourceBasisConfig, SourceBasisConfigError } from "../../packages/signals/src/index";
import { buildReport, dryRun, inspectInput, InputError, renderReport, runImport } from "../../packages/historical/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
  now?: () => Date;
}

const USAGE = [
  "usage:",
  "  historical-import validate <path>",
  "  historical-import dry-run <path> --label <label> [--default-market <CODE>] [--level-basis-default \"<source>=premium\"]",
  "  historical-import import <path> --label <label> --created-by operator:<name> --confirm-source <path> --confirm-manifest <hex> [--default-market <CODE>] [--level-basis-default \"<source>=premium\"] [--chunk-size N] [--allow-invalid]",
  "  historical-import report --batch <uuid>",
].join("\n");

function parseArgs(args: string[]): { values: Map<string, string>; bare: Set<string>; positional: string[] } | null {
  const values = new Map<string, string>(), bare = new Set<string>(), positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    if (a === "--allow-invalid" || a === "--json") { bare.add(a.slice(2)); continue; }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    values.set(a.slice(2), v);
    i++;
  }
  return { values, bare, positional };
}
const json = (o: unknown): string => JSON.stringify(o, null, 2);
const MARKET = /^[A-Z0-9]{2,20}$/;

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (!cmd || !a) { deps.err(USAGE); return 2; }
  const now = deps.now?.() ?? new Date();
  const label = a.values.get("label") ?? "";
  const defaultMarket = a.values.get("default-market") ?? null;
  if (defaultMarket !== null && !MARKET.test(defaultMarket)) { deps.err("--default-market must be an upper-case market code"); return 2; }
  let sourceBasis: ReturnType<typeof parseSourceBasisConfig> | undefined;
  const basisRaw = a.values.get("level-basis-default");
  if (basisRaw !== undefined) { try { sourceBasis = parseSourceBasisConfig({ TWINS_SOURCE_DEFAULT_LEVEL_BASIS: basisRaw }); } catch (e) { if (e instanceof SourceBasisConfigError) { deps.err("--level-basis-default must look like <source>=premium[,<source>=premium]"); return 2; } throw e; } }
  let handle: { db: Db; close: () => Promise<void> } | undefined;
  const open = (): { db: Db; close: () => Promise<void> } | undefined => {
    const url = deps.env["DATABASE_URL"];
    if (!url) return undefined;
    handle ??= deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
    return handle;
  };
  try {
    if (cmd === "report") {
      const id = a.values.get("batch");
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { deps.err(USAGE); return 2; }
      const h = open();
      if (!h) { deps.err("DATABASE_URL is not set"); return 1; }
      const r = await buildReport(h.db, id);
      if (!r) { deps.err("refused: batch_not_found"); return 3; }
      deps.out(a.bare.has("json") ? json(r) : renderReport(r));
      return 0;
    }
    const path = a.positional[0];
    if (!path || (cmd !== "validate" && cmd !== "dry-run" && cmd !== "import")) { deps.err(USAGE); return 2; }
    if (cmd !== "validate" && !label) { deps.err("--label is required"); return 2; }
    const files = await inspectInput(path);
    const summary = await dryRun(files, { label: label || "validate", defaultMarket, ...(sourceBasis ? { sourceBasis } : {}) }, cmd === "dry-run" ? open()?.db : undefined, now);
    if (cmd !== "import") { deps.out(json(summary)); return summary.invalidRecords > 0 ? 3 : 0; }

    const by = a.values.get("created-by"), confirmSource = a.values.get("confirm-source"), confirmManifest = a.values.get("confirm-manifest");
    if (!by || !confirmSource || !confirmManifest) { deps.err("import needs --created-by, --confirm-source and --confirm-manifest (run dry-run first)"); return 2; }
    if (resolve(confirmSource) !== resolve(path)) { deps.err("refused: source_not_confirmed (--confirm-source must equal the source path)"); return 3; }
    if (!/^[0-9a-f]{12,64}$/.test(confirmManifest) || !summary.manifestSha256.startsWith(confirmManifest)) { deps.err("refused: manifest_not_confirmed (the input changed, or --confirm-manifest is not the dry-run manifest hash)"); return 3; }
    const chunkRaw = a.values.get("chunk-size");
    const chunkSize = chunkRaw === undefined ? undefined : Number(chunkRaw);
    if (chunkSize !== undefined && !(Number.isInteger(chunkSize) && chunkSize >= 1 && chunkSize <= 5000)) { deps.err("--chunk-size must be a whole number from 1 to 5000"); return 2; }
    const h = open();
    if (!h) { deps.err("DATABASE_URL is not set"); return 1; }
    const r = await runImport(h.db, files, { label, defaultMarket, ...(sourceBasis ? { sourceBasis } : {}), createdBy: by, confirmedSource: confirmSource, ...(chunkSize ? { chunkSize } : {}), allowInvalid: a.bare.has("allow-invalid"), now });
    const report = await buildReport(h.db, r.batchId);
    deps.out(`import ${r.outcome}: batch ${r.batchId} (resumed from record ${r.resumedFromRecord}, ${r.checkpoints} checkpoints)`);
    if (report) deps.out(renderReport(report));
    return 0;
  } catch (error) {
    if (error instanceof InputError) { deps.err(`refused: ${error.code}${error.file ? ` (${error.file})` : ""}`); return 3; }
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`); // never the message: a driver error can embed row values
    return 1;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("historical-import");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => process.exit(code), () => process.exit(1));
}
