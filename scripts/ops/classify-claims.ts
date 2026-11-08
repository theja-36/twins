/**
 * Classifies stored options claims (Master Build Stage 03, Module 02): signal type, horizon, setup, risk profile, entry condition, exit pattern and structure validity, into the append-only
 * `signal_classifications` table (migration 0033). Idempotent per (claim, classifier version). Reads claim fields and the message text (for fixed whole-word cues only); writes codes and
 * structure only, never message text. Prints COUNTS only. Contacts no Telegram, provider or broker. NOT installed and NOT wired into live intake: an owner-run backfill.
 *
 *   classify-claims [--limit <n>]      (DATABASE_URL must be set; default limit 500, max 5000)
 *
 * Exit codes: 0 ok, 1 failure, 2 usage.
 */
import { pathToFileURL } from "node:url";
import { classifyBatch, loadPendingClaims, storeClassification } from "../../packages/signals/src/classification/index";
import { createBoundedDb, type Db } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";

export interface CliDeps { env: Record<string, string | undefined>; out: (l: string) => void; err: (l: string) => void; openDb?: (url: string) => { db: Db; close: () => Promise<void> } }
const USAGE = "usage: classify-claims [--limit <n>]";

export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  let limit = 500;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1] !== undefined) { limit = Number(args[++i]); } else { deps.err(USAGE); return 2; }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) { deps.err(USAGE); return 2; }
  const url = deps.env["DATABASE_URL"];
  if (!url) { deps.err("DATABASE_URL is not set"); return 1; }
  const handle = deps.openDb ? deps.openDb(url) : createBoundedDb(url, { max: 2, idleTimeoutMillis: 5000 });
  try {
    const pending = await loadPendingClaims(handle.db, limit);
    const r = await classifyBatch(pending, (id, res) => storeClassification(handle.db, id, res));
    deps.out(`classify-claims: ${r.considered} pending, ${r.stored} stored, ${r.alreadyDone} already recorded`);
    return 0;
  } catch (e) { deps.err(`failed: ${e instanceof Error ? e.name : "Error"}`); return 1; }
  finally { await handle.close().catch(() => undefined); }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("classify-claims");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c), () => process.exit(1));
}
