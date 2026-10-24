import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { telegramMessageEvents, telegramMessages } from "../../../packages/database/src/schema/telegram";
import { loadExpectedMigrations } from "../../integration/migrationState";

/**
 * Text-level checks of migration 0007 (no database is touched). The behavioural checks (constraints and trigger firing) are
 * integration tests that run in T2a-2 against a migrated database.
 */
const DIR = "packages/database/drizzle";
const TAG = "0007_telegram_user_capture_provenance";
const sql = readFileSync(`${DIR}/${TAG}.sql`, "utf8");
const journal = JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, "utf8")) as { entries: Array<{ idx: number; tag: string; when: number; breakpoints: boolean }> };
const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
/** The hand-written part starts at the marker comment; everything before it is drizzle-kit output. */
const HAND_MARKER = "-- HAND-WRITTEN";
const generated = sql.slice(0, sql.indexOf(HAND_MARKER));
const handWritten = sql.slice(sql.indexOf(HAND_MARKER));

describe("migration 0007 ledger entry", () => {
  it("is the 8th entry, idx 7, with the expected tag and a strictly increasing timestamp", () => {
    expect(journal.entries.length).toBeGreaterThanOrEqual(8);
    const entry = journal.entries[7];
    expect(entry).toMatchObject({ idx: 7, tag: TAG, breakpoints: true });
    expect(entry?.when).toBeGreaterThan(journal.entries[6]?.when ?? Infinity);
    expect(journal.entries[6]?.when).toBe(1792493154072); // 0006 is untouched
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    expect(new Set(journal.entries.map((e) => e.tag)).size).toBe(journal.entries.length);
    expect(journal.entries.map((e) => e.when)).toEqual([...journal.entries.map((e) => e.when)].sort((a, b) => a - b));
  });
  it("the repository's expected-migration loader sees 8 migrations whose last hash is this file's hash", () => {
    const expected = loadExpectedMigrations();
    expect(expected.length).toBeGreaterThanOrEqual(8);
    expect(expected[7]?.hash).toBe(createHash("sha256").update(sql).digest("hex"));
  });
  it("earlier migrations are byte-identical (their hashes are what every database recorded)", () => {
    const hashes = loadExpectedMigrations().slice(0, 7).map((m) => m.tag);
    expect(hashes).toEqual([
      "0000_late_the_leader", "0001_cheerful_lady_mastermind", "0002_curly_rage", "0003_colorful_sheva_callister",
      "0004_r0b_idempotency_revisions_identity", "0005_r0b_signal_evidence_unique_links", "0006_options_claims_unverified",
    ]);
  });
  it("the snapshot chain is consistent", () => {
    const s7 = JSON.parse(readFileSync(`${DIR}/meta/0007_snapshot.json`, "utf8")) as { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown> }> };
    const s6 = JSON.parse(readFileSync(`${DIR}/meta/0006_snapshot.json`, "utf8")) as { id: string };
    expect(s7.prevId).toBe(s6.id);
    expect(Object.keys(s7.tables["public.telegram_message_events"]?.columns ?? {}).sort()).toEqual(getTableConfig(telegramMessageEvents).columns.map((c) => c.name).sort());
    for (const col of ["capture_method", "observed_at", "imported_at", "first_seen_edited"]) expect(s7.tables["public.telegram_messages"]?.columns).toHaveProperty(col);
  });
});

describe("migration 0007 SQL text", () => {
  it("is FROZEN: its hash is pinned (change this value only while no database has recorded 0007)", () => {
    expect(createHash("sha256").update(sql).digest("hex")).toBe("d21f49e69a8459dfabfa39a4e1cbc0abe2be51d63b9f2f69a33356046471037b");
  });
  it("adds the four provenance columns with the approved shapes: constant defaults, nullable observed_at/imported_at", () => {
    expect(generated).toContain('ALTER TABLE "telegram_messages" ADD COLUMN "capture_method" text DEFAULT \'bot_webhook\' NOT NULL;');
    expect(generated).toContain('ALTER TABLE "telegram_messages" ADD COLUMN "observed_at" timestamp with time zone;');
    expect(generated).toContain('ALTER TABLE "telegram_messages" ADD COLUMN "imported_at" timestamp with time zone;');
    expect(generated).toContain('ALTER TABLE "telegram_messages" ADD COLUMN "first_seen_edited" boolean DEFAULT false NOT NULL;');
    expect(generated).not.toMatch(/"observed_at"[^;]*NOT NULL;\s*--> statement-breakpoint\s*ALTER TABLE "telegram_messages"/); // observed_at is NOT NULL only on the events table
  });
  it("carries the approved CHECK constraints on telegram_messages and on the events table", () => {
    expect(generated).toContain('CONSTRAINT "telegram_messages_capture_method_check" CHECK ("telegram_messages"."capture_method" in (\'bot_webhook\', \'api_live\', \'api_history\'))');
    expect(generated).toContain('"telegram_messages_imported_at_check" CHECK (("telegram_messages"."capture_method" = \'api_history\') = ("telegram_messages"."imported_at" is not null))');
    expect(generated).toContain('"telegram_messages_observed_at_check" CHECK ("telegram_messages"."capture_method" = \'bot_webhook\' or "telegram_messages"."observed_at" is not null)');
    expect(generated).toContain("\"telegram_message_events_event_type_check\" CHECK (\"telegram_message_events\".\"event_type\" in ('seen', 'edited_observed', 'deleted_observed'))");
    expect(generated).toContain("\"telegram_message_events_capture_method_check\" CHECK (\"telegram_message_events\".\"capture_method\" in ('api_live', 'api_history'))");
    expect(generated).toMatch(/telegram_message_events_content_sha256_check" CHECK \(.*\[0-9a-f\]\{64\}/);
    expect(generated).toMatch(/telegram_message_events_raw_meta_size_check" CHECK \(octet_length\(.*<= 4096\)/);
  });
  it("the events table has no text column: a content hash only, and metadata bounded by a CHECK", () => {
    const columns = getTableConfig(telegramMessageEvents).columns.map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["content_sha256", "raw_meta", "idempotency_key", "observed_at", "event_type", "telegram_message_id"]));
    expect(columns.some((c) => /(^|_)text($|_)|body|content$|message_text|raw_payload/.test(c))).toBe(false);
    expect(generated).toContain('"idempotency_key" text NOT NULL');
    expect(generated).toContain('CREATE UNIQUE INDEX "telegram_message_events_idempotency_key_unique"');
    expect(generated).toContain('"telegram_message_id" uuid,'); // nullable: a deletion of an unknown message
    expect(generated).toContain('REFERENCES "public"."telegram_messages"("id") ON DELETE restrict');
  });
  it("NEVER rewrites, deletes or drops existing data: the generated part has no UPDATE, DELETE, TRUNCATE, DROP, ALTER COLUMN or SET NOT NULL", () => {
    for (const forbidden of [/(?<!ON )\bUPDATE\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bDROP\b/i, /\bALTER\s+COLUMN\b/i, /\bSET\s+NOT\s+NULL\b/i, /\bINSERT\b/i]) {
      expect(generated, String(forbidden)).not.toMatch(forbidden);
    }
    // every statement that alters the existing raw table only ADDS a column or a constraint
    for (const statement of statements.filter((s) => /^ALTER TABLE "telegram_messages"/.test(s))) expect(statement).toMatch(/ADD (COLUMN|CONSTRAINT)/);
    // the only statements touching existing tables are those ALTERs plus the two foreign keys on the NEW events table
    const touching = statements.filter((s) => /"telegram_messages"/.test(s) && !/^ALTER TABLE "telegram_messages"/.test(s));
    for (const statement of touching) expect(statement).toMatch(/^ALTER TABLE "telegram_message_events" ADD CONSTRAINT .* FOREIGN KEY/);
  });
  it("the hand-written function body only raises an error (no data statements at all)", () => {
    const body = /AS \$\$([\s\S]*?)\$\$/.exec(handWritten)?.[1] ?? "";
    expect(body.replace(/\s+/g, " ").trim()).toBe("BEGIN RAISE EXCEPTION 'telegram_message_events is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation'; END;");
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|SELECT|RETURN)\b/i);
  });
  it("the ONLY hand-written SQL is the append-only trigger block: one function and two triggers", () => {
    expect(handWritten.startsWith(HAND_MARKER)).toBe(true);
    const handStatements = handWritten.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    // first chunk is the marker comment + function; then the two triggers
    expect(handStatements).toHaveLength(3);
    expect(handStatements[0]).toMatch(/CREATE FUNCTION "telegram_message_events_append_only"\(\) RETURNS trigger LANGUAGE plpgsql/);
    expect(handStatements[0]).toContain("RAISE EXCEPTION");
    expect(handStatements[0]).toContain("ERRCODE = 'restrict_violation'");
    expect(handStatements[1]).toBe('CREATE TRIGGER "telegram_message_events_no_update_delete" BEFORE UPDATE OR DELETE ON "telegram_message_events" FOR EACH ROW EXECUTE FUNCTION "telegram_message_events_append_only"();');
    expect(handStatements[2]).toBe('CREATE TRIGGER "telegram_message_events_no_truncate" BEFORE TRUNCATE ON "telegram_message_events" FOR EACH STATEMENT EXECUTE FUNCTION "telegram_message_events_append_only"();');
    expect(generated).not.toMatch(/TRIGGER|FUNCTION/);
  });
  it("every drizzle-generated statement is separated by a breakpoint and the trigger block comes last", () => {
    expect(sql.indexOf("CREATE TRIGGER")).toBeGreaterThan(sql.lastIndexOf("ADD CONSTRAINT"));
    expect(sql.endsWith(";\n")).toBe(true);
    expect(statements.length).toBe(sql.split("--> statement-breakpoint").length);
  });
});

describe("schema <-> SQL consistency", () => {
  it("every column and constraint the schema declares appears in the migration", () => {
    for (const table of [telegramMessageEvents]) {
      const config = getTableConfig(table);
      for (const column of config.columns) expect(generated).toContain(`"${column.name}"`);
      for (const check of config.checks) expect(generated).toContain(`"${check.name}"`);
      for (const index of config.indexes) expect(generated).toContain(`"${index.config.name}"`);
    }
    const messages = getTableConfig(telegramMessages);
    for (const check of messages.checks) expect(generated).toContain(`"${check.name}"`);
    expect(messages.checks.map((c) => c.name).sort()).toEqual(["telegram_messages_capture_method_check", "telegram_messages_imported_at_check", "telegram_messages_observed_at_check"]);
  });
  it("the schema documents that raw rows are immutable (no updated_at on telegram_messages)", () => {
    expect(getTableConfig(telegramMessages).columns.map((c) => c.name)).not.toContain("updated_at");
  });
});
