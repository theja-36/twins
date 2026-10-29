/**
 * Dead-letter operations for the durable intake outbox (Stage 2 / Task 5). Owner credential (same boundary as safety-control / migrate); no HTTP endpoint.
 *
 *   outbox-deadletter list [--limit N]
 *   outbox-deadletter show <outbox-id>
 *   outbox-deadletter replay --id <outbox-id> --reason "<why, 8-500 chars>" --changed-by operator:<name>
 *
 * list/show print SAFE METADATA ONLY: id, channel id, message type, attempt counts, last error CODE, timestamps - never the payload, text or author.
 * replay reopens exactly ONE row named by id: in one transaction it records the replay (who, why, previous attempts/error) in the append-only
 * telegram_intake_outbox_replays log, writes a chained audit_events row, and moves the row DEAD_LETTER -> PENDING with attempt_count 0 (the only
 * transition the database allows out of DEAD_LETTER, and only together with the replay record). There is deliberately no "replay all" and no filter flag.
 * The worker's reconciler then enqueues the row like any other. Exit codes: 0 ok, 1 failed, 2 usage/config, 3 refused (not a dead letter / unknown id).
 */
import { pathToFileURL } from "node:url";
import pg from "pg";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";

export interface Deps {
  env: Record<string, string | undefined>;
  out: (l: string) => void;
  err: (l: string) => void;
  open?: (url: string) => { pool: pg.Pool; close: () => Promise<void> };
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^operator:[a-z0-9][a-z0-9._-]{1,40}$/;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
const USAGE = [
  "usage:",
  "  outbox-deadletter list [--limit N]",
  "  outbox-deadletter show <outbox-id>",
  '  outbox-deadletter replay --id <outbox-id> --reason "<8-500 chars>" --changed-by operator:<name>',
].join("\n");

const COLUMNS = "id, channel_id, message_type, intake_source, attempt_count, max_attempts, last_error, received_at, updated_at, status";
const meta = (r: Record<string, unknown>) => ({
  id: r["id"], channelId: r["channel_id"], messageType: r["message_type"], intakeSource: r["intake_source"], status: r["status"],
  attemptCount: r["attempt_count"], maxAttempts: r["max_attempts"], lastErrorCode: r["last_error"],
  receivedAt: (r["received_at"] as Date).toISOString(), updatedAt: (r["updated_at"] as Date).toISOString(),
});

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!["limit", "id", "reason", "changed-by"].includes(name) || rest[i + 1] === undefined) { deps.err(`usage error: unknown or incomplete flag ${JSON.stringify(a.slice(0, 20))}\n${USAGE}`); return 2; }
      flags[name] = rest[++i] as string;
    } else positional.push(a);
  }
  if (command !== "list" && command !== "show" && command !== "replay") { deps.err(USAGE); return 2; }
  if (command === "list" && positional.length > 0) { deps.err(USAGE); return 2; }
  if (command === "show" && (positional.length !== 1 || !UUID.test(positional[0] as string))) { deps.err(`usage error: show needs one outbox id\n${USAGE}`); return 2; }
  if (command === "replay") {
    const reason = (flags["reason"] ?? "").trim();
    if (positional.length > 0 || !UUID.test(flags["id"] ?? "") || reason.length < 8 || reason.length > 500 || CONTROL_CHARS.test(reason) || !ACTOR.test(flags["changed-by"] ?? "")) {
      deps.err(`usage error: replay needs --id <one outbox id>, --reason (8-500 printable characters) and --changed-by operator:<name>\n${USAGE}`);
      return 2;
    }
  }
  const url = deps.env["DATABASE_URL"];
  if (!url) { deps.err("configuration error: DATABASE_URL is not set"); return 2; }
  const { pool, close } = (deps.open ?? ((u) => { const p = new pg.Pool({ connectionString: u, max: 1, connectionTimeoutMillis: 5000, application_name: "twins-outbox-deadletter" }); p.on("error", () => undefined); return { pool: p, close: () => p.end() }; }))(url);
  try {
    if (command === "list") {
      const limit = flags["limit"] !== undefined && /^[0-9]{1,3}$/.test(flags["limit"]) && Number(flags["limit"]) > 0 ? Number(flags["limit"]) : 50;
      const rows = (await pool.query(`select ${COLUMNS} from telegram_intake_outbox where status = 'DEAD_LETTER' order by updated_at desc limit $1`, [limit])).rows;
      for (const r of rows) deps.out(JSON.stringify(meta(r)));
      deps.out(JSON.stringify({ deadLetters: rows.length, shown: rows.length, limit }));
      return 0;
    }
    if (command === "show") {
      const r = (await pool.query(`select ${COLUMNS} from telegram_intake_outbox where id = $1`, [positional[0]])).rows[0];
      if (!r) { deps.err("refused: no such outbox row"); return 3; }
      const replays = Number(((await pool.query("select count(*)::int as n from telegram_intake_outbox_replays where outbox_id = $1", [positional[0]])).rows[0] ?? {})["n"]);
      deps.out(JSON.stringify({ ...meta(r), replaysRecorded: replays }));
      return 0;
    }
    // replay
    const id = flags["id"] as string;
    const reason = (flags["reason"] as string).trim();
    const actor = flags["changed-by"] as string;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = (await client.query("select id, channel_id, message_type, status, attempt_count, last_error from telegram_intake_outbox where id = $1 for update", [id])).rows[0] as Record<string, unknown> | undefined;
      if (!row) { await client.query("rollback"); deps.err("refused: no such outbox row"); return 3; }
      if (row["status"] !== "DEAD_LETTER") { await client.query("rollback"); deps.err(`refused: the row is ${String(row["status"])}, only a DEAD_LETTER row can be replayed`); return 3; }
      await client.query(
        "insert into telegram_intake_outbox_replays (id, outbox_id, reason, requested_by, previous_attempt_count, previous_last_error) values (gen_random_uuid(), $1, $2, $3, $4, $5)",
        [id, reason, actor, row["attempt_count"], row["last_error"]],
      );
      await client.query("update telegram_intake_outbox set status = 'PENDING', attempt_count = 0, available_at = now(), enqueued_at = null, last_error = null where id = $1", [id]);
      await client.query(
        "insert into audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata) values (gen_random_uuid(), 'outbox.replayed', 'telegram_intake_outbox', $1, 'user', $2, $3)",
        [id, actor, JSON.stringify({ channelId: row["channel_id"], messageType: row["message_type"], previousAttemptCount: row["attempt_count"], previousErrorCode: row["last_error"], reason })],
      );
      await client.query("commit");
      deps.out(JSON.stringify({ ts: (deps.now ?? (() => new Date()))().toISOString(), level: "warn", event: "outbox.replayed", outboxId: id, channelId: row["channel_id"], previousAttemptCount: row["attempt_count"], previousErrorCode: row["last_error"], changedBy: actor, reasonLength: reason.length }));
      return 0;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    deps.err(`failed: ${error instanceof Error ? error.name : "error"}${typeof code === "string" && /^[A-Za-z0-9_]{1,24}$/.test(code) ? ` (${code})` : ""}`);
    return 1;
  } finally {
    await close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  enforceLiveTradingGuard("outbox-deadletter");
  void main(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c));
}
