/**
 * Capture exporter CLI (Option A, READ-ONLY): writes the messages TWINS has already captured into a JSONL file in the historical importer's input contract. It only SELECTs from the database, writes
 * nothing to it, contacts no Telegram, provider or broker, and prints COUNTS only (never message text). The output file contains message text: it is created 0600, never overwritten, and must not be
 * committed to any repository.
 *
 *   capture-export --out <file.jsonl> [--since <ISO>] [--until <ISO>] [--capture-method bot_webhook|api_live|api_history] [--include-first-seen-edited]
 *
 * Then: archive-profile <file> --label <label> --default-market NSE, historical-import dry-run, and (separate owner go-ahead) historical-import import. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { createBoundedDb, schema, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { captureRowsToRecords, type CaptureRow, type ExportStats } from "../../packages/historical/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDb?: (databaseUrl: string) => { db: Db; close: () => Promise<void> };
}
const USAGE = "usage: capture-export --out <file.jsonl> [--since <ISO>] [--until <ISO>] [--capture-method bot_webhook|api_live|api_history] [--include-first-seen-edited]";
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

/** READ-ONLY: one SELECT over messages joined to their source. `since` inclusive, `until` exclusive (message time). */
export async function loadCaptureRows(db: Db, range: { since?: Date; until?: Date; captureMethod?: string } = {}): Promise<CaptureRow[]> {
  const M = schema.telegramMessages, S = schema.telegramSources;
  const conds = [range.since ? gte(M.messageTimestamp, range.since) : undefined, range.until ? lt(M.messageTimestamp, range.until) : undefined, range.captureMethod ? eq(M.captureMethod, range.captureMethod) : undefined].filter((c) => c !== undefined);
  const rows = await db.select({
    sourceId: M.telegramSourceId, channelIdentifier: S.channelIdentifier, displayName: S.displayName, externalId: M.externalMessageId, originId: M.originMessageId,
    messageTimestamp: M.messageTimestamp, editDate: M.editDate, rawText: M.rawText, firstSeenEdited: M.firstSeenEdited, captureMethod: M.captureMethod,
  }).from(M).innerJoin(S, eq(S.id, M.telegramSourceId)).where(conds.length ? and(...conds) : undefined).orderBy(asc(M.messageTimestamp), asc(M.externalMessageId));
  return rows;
}

export function renderStats(s: ExportStats): string[] {
  return [
    `${s.version}: ${s.rowsRead} rows read -> ${s.messagesExported} messages (${s.revisionsAttached} edits attached) across ${s.channels} channel(s); ${s.first?.slice(0, 10) ?? "-"} .. ${s.last?.slice(0, 10) ?? "-"}`,
    `by capture method: ${JSON.stringify(s.byCaptureMethod)}`,
    `skipped: orphan revisions ${s.revisionsOrphaned}, first-seen-edited excluded ${s.firstSeenEditedExcluded}, empty text ${s.emptyTextSkipped}, bad id ${s.badIdSkipped}; truncated: edits ${s.editsTruncated}, texts ${s.textTruncated}`,
  ];
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let out: string | undefined, since: Date | undefined, until: Date | undefined, method: string | undefined, includeFse = false;
  const date = (v: string | undefined): Date | undefined | "bad" => { if (v === undefined) return "bad"; const d = new Date(v); return ISO.test(v) && !Number.isNaN(d.getTime()) ? d : "bad"; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--include-first-seen-edited") includeFse = true;
    else if (a === "--out" && argv[i + 1]) out = argv[++i];
    else if (a === "--capture-method" && argv[i + 1]) { method = argv[++i]; if (!["bot_webhook", "api_live", "api_history"].includes(method as string)) { deps.err(USAGE); return 2; } }
    else if ((a === "--since" || a === "--until") && argv[i + 1]) { const d = date(argv[++i]); if (d === "bad" || d === undefined) { deps.err("--since/--until must be an ISO instant with an offset"); return 2; } if (a === "--since") since = d; else until = d; }
    else { deps.err(USAGE); return 2; }
  }
  if (!out) { deps.err(USAGE); return 2; }
  const url = deps.env["DATABASE_URL"];
  if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
  const handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
  try {
    const rows = await loadCaptureRows(handle.db, { ...(since ? { since } : {}), ...(until ? { until } : {}), ...(method ? { captureMethod: method } : {}) });
    const { records, stats } = captureRowsToRecords(rows, { includeFirstSeenEdited: includeFse });
    const path = resolve(out);
    try { writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), { flag: "wx", mode: 0o600 }); chmodSync(path, 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") { deps.err("refused: output_exists"); return 3; } throw e; }
    for (const l of renderStats(stats)) deps.out(l);
    deps.out(`wrote ${path} (mode 0600; contains message text, do not commit)`);
    return 0;
  } catch (error) {
    deps.err(`failed: ${error instanceof Error ? error.name : "Error"}`);
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("capture-export");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c), () => process.exit(1));
}
