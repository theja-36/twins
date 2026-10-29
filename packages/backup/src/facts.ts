import type { SnapshotFacts } from "./manifest";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Tables whose exact row counts are compared between the source snapshot and a restored copy (only those that exist are counted). */
export const CRITICAL_TABLES = [
  "audit_events", "options_claims", "signal_validations", "signals", "stop_loss_validations", "system_control_events", "system_controls",
  "telegram_intake_outbox", "telegram_message_events", "telegram_messages", "telegram_sources",
] as const;

/** Non-sensitive facts: counts and one-way chain digests only. Call inside the transaction that exported the snapshot. */
export async function collectFacts(db: Queryable): Promise<SnapshotFacts> {
  const mig = await db.query("select count(*)::int as n from drizzle.__drizzle_migrations");
  const present = new Set((await db.query("select table_name from information_schema.tables where table_schema = 'public'")).rows.map((r) => String(r["table_name"])));
  const tableCounts: Record<string, number> = {};
  for (const t of CRITICAL_TABLES) {
    if (!present.has(t)) continue;
    tableCounts[t] = Number(((await db.query(`select count(*)::bigint as n from public."${t}"`)).rows[0] ?? {})["n"]);
  }
  const chainHeads: SnapshotFacts["chainHeads"] = {};
  if (present.has("audit_chain_heads")) {
    for (const r of (await db.query("select chain_name, last_index, last_hash from audit_chain_heads order by chain_name")).rows) {
      chainHeads[String(r["chain_name"])] = { lastIndex: Number(r["last_index"]), lastHash: String(r["last_hash"]) };
    }
  }
  return { migrations: Number((mig.rows[0] ?? {})["n"]), tableCounts, chainHeads };
}
