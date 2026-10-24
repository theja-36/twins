// CI: after `npm run db:migrate`, verify that every checked-in migration is recorded,
// and that the 0004 structures exist. Read-only. Uses DATABASE_URL (CI-only database).
import fs from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const journal = JSON.parse(fs.readFileSync("packages/database/drizzle/meta/_journal.json", "utf8"));
const expected = journal.entries.length;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query("select count(*)::int as n from drizzle.__drizzle_migrations");
  if (rows[0].n !== expected) throw new Error(`migrations recorded ${rows[0].n}, expected ${expected}`);
  const cols = await client.query(
    `select table_name || '.' || column_name as c from information_schema.columns
     where (table_name, column_name) in (('signals','parser_version'),('signal_validations','idempotency_key'),
       ('telegram_sources','chat_id'),('telegram_messages','origin_message_id'),('telegram_messages','edit_date'))`,
  );
  if (cols.rowCount !== 5) throw new Error(`expected 5 new columns from 0004, found ${cols.rowCount}`);
  const def = await client.query(
    "select column_default from information_schema.columns where table_name='signals' and column_name='parser_version'",
  );
  if (def.rows[0].column_default !== null) throw new Error("signals.parser_version must have no default");
  // 0007: capture provenance columns, the append-only events table and its trigger (read-only catalog checks).
  const capCols = await client.query(
    `select column_name from information_schema.columns
     where table_name = 'telegram_messages' and column_name in ('capture_method','observed_at','imported_at','first_seen_edited')`,
  );
  if (capCols.rowCount !== 4) throw new Error(`expected 4 capture provenance columns from 0007, found ${capCols.rowCount}`);
  const events = await client.query("select to_regclass('public.telegram_message_events') is not null as ok");
  if (!events.rows[0].ok) throw new Error("telegram_message_events (0007) is missing");
  const triggers = await client.query(
    `select tgname from pg_trigger
     where tgrelid = 'public.telegram_message_events'::regclass and not tgisinternal order by tgname`,
  );
  const names = triggers.rows.map((r) => r.tgname).join(",");
  if (names !== "telegram_message_events_no_truncate,telegram_message_events_no_update_delete") {
    throw new Error(`append-only triggers missing or unexpected on telegram_message_events: [${names}]`);
  }
  // 0008: approval-bot tables; the review log and event log are append-only (read-only catalog checks).
  for (const t of ["claim_review_cards", "claim_reviews", "approval_bot_events", "approval_bot_state"]) {
    const r = await client.query("select to_regclass($1) is not null as ok", [`public.${t}`]);
    if (!r.rows[0].ok) throw new Error(`${t} (0008) is missing`);
  }
  for (const t of ["claim_reviews", "approval_bot_events"]) {
    const tr = await client.query(
      "select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname",
      [`public.${t}`],
    );
    const got = tr.rows.map((r) => r.tgname).join(",");
    if (got !== `${t}_no_truncate,${t}_no_update_delete`) throw new Error(`append-only triggers missing or unexpected on ${t}: [${got}]`);
  }
  console.log(`[ci] ${expected} migrations recorded; 0004 structures present; parser_version has no default; 0007 capture structures and append-only triggers present; 0008 approval-bot tables and append-only triggers present`);
} finally {
  await client.end();
}
