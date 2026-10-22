// READ-ONLY: classifies revision currentness for every (source, original message) group using the
// application's own pure function, and prints sorted lines. Run via `npx tsx` with DATABASE_URL in
// the environment (never printed). The session is forced read-only.
import pg from "pg";
import { classifyRevisions, originOf } from "../../../packages/ingestion/src/telegramRevisions.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on -c TimeZone=UTC" });
await client.connect();
try {
  const { rows } = await client.query(
    "select id, telegram_source_id, external_message_id, origin_message_id, edit_date from telegram_messages",
  );
  const groups = new Map();
  for (const r of rows) {
    const row = { id: r.id, externalMessageId: r.external_message_id, originMessageId: r.origin_message_id, editDate: r.edit_date };
    const key = `${r.telegram_source_id}|${originOf(row)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(row);
  }
  const lines = [];
  for (const [key, members] of groups) for (const c of classifyRevisions(members)) lines.push(`${key}|${c.id}|${c.state}`);
  lines.sort();
  console.log(lines.join("\n"));
  console.error(`groups=${groups.size} messages=${rows.length}`);
} finally {
  await client.end();
}
