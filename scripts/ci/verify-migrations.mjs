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
  console.log(`[ci] ${expected} migrations recorded; 0004 structures present; parser_version has no default`);
} finally {
  await client.end();
}
