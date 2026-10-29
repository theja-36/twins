import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBotDb } from "../../../services/approval-bot/src/db";
import { READ_CONTROLS_SQL } from "../../../packages/runtime-state/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";

/**
 * The real approval-bot-role.sql applied to a real (rehearsal) database inside ONE transaction that is always rolled back:
 * the role never persists. Each probe runs in a savepoint as the restricted role, so a denied statement does not poison the rest.
 */
const ROLE = "twins_bot"; // the self-check in PgBotDb insists on this exact name
const roleSql = readFileSync("infrastructure/staging/approval-bot-role.sql", "utf8").replaceAll(':"bot_role"', `"${ROLE}"`);
const client = new pg.Client({ connectionString: requireTestDatabaseUrl() });
let sp = 0;

async function asBot<T>(fn: () => Promise<T>): Promise<T> {
  await client.query(`savepoint s${++sp}`);
  await client.query(`set local role ${ROLE}`);
  try {
    return await fn();
  } finally {
    await client.query(`rollback to savepoint s${sp}`); // also undoes SET LOCAL ROLE and recovers from a denied statement
    await client.query("reset role");
  }
}
async function code(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await asBot(() => client.query(sql, params));
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
}

const claimId = randomUUID();
const cardId = randomUUID();
const testCardId = randomUUID();

beforeAll(async () => {
  await client.connect();
  const exists = await client.query("select 1 from pg_roles where rolname = $1", [ROLE]);
  if (exists.rowCount) throw new Error(`a role named ${ROLE} already exists in this database cluster; refusing to run`);
  await client.query("begin");
  await client.query(`create role ${ROLE} login`);
  await client.query(roleSql);
  await client.query(roleSql); // idempotent
  // Fixture rows (as the owner). Foreign keys are bypassed for these two inserts only; triggers are re-enabled afterwards.
  await client.query("set local session_replication_role = replica");
  await client.query(
    `insert into claim_review_cards (id, kind, claim_id, state, nonce, expires_at) values ($1,'claim',$2,'sent',$3, now() + interval '4 hours'), ($4,'test',null,'sent',$3, now() + interval '4 hours')`,
    [cardId, claimId, "a".repeat(32), testCardId],
  );
  await client.query(
    `insert into claim_reviews (id, card_id, claim_id, decision, approver_telegram_user_id, card_telegram_message_id, update_id, evidence) values ($1,$2,$3,'approve',1,1,1,'{}')`,
    [randomUUID(), cardId, claimId],
  );
  await client.query("set local session_replication_role = origin");
  await client.query(`insert into approval_bot_events (id, event_type) values ($1,'fixture_event')`, [randomUUID()]);
});
afterAll(async () => {
  await client.query("rollback").catch(() => undefined);
  await client.end().catch(() => undefined);
});

describe("restricted role twins_bot (real database)", () => {
  it("passes the bot's own startup privilege self-check", async () => {
    const pool = { query: (sql: string, params?: unknown[]) => asBot(() => client.query(sql, params)) } as unknown as pg.Pool;
    expect(await new PgBotDb("postgres://unused", pool).checkPrivileges()).toEqual([]);
  });
  it("cannot read the channel text or the raw payload, by name or with SELECT *", async () => {
    expect(await code("select raw_text from telegram_messages")).toBe("42501");
    expect(await code("select raw_payload from telegram_messages")).toBe("42501");
    expect(await code("select * from telegram_messages")).toBe("42501");
    expect(await code("select id, external_message_id, message_timestamp, telegram_source_id from telegram_messages")).toBe("ok");
    expect(await code("select id, channel_identifier from telegram_sources")).toBe("ok");
    expect(await code("select display_name from telegram_sources")).toBe("42501");
  });
  it("can read parsed claim columns but not the rest of options_claims", async () => {
    expect(await code("select id, telegram_message_id, parser_version, result_kind, claim, assessment_outcome, reasons, approval_possible, created_at from options_claims")).toBe("ok");
    expect(await code("select * from options_claims")).toBe("42501");
    expect(await code("select detail from options_claims")).toBe("42501");
  });
  it("cannot write claims, messages or sources, in any way", async () => {
    for (const sql of [
      "update options_claims set approval_possible = true",
      "insert into options_claims (id) values (gen_random_uuid())",
      "delete from options_claims",
      "truncate options_claims",
      "update telegram_messages set received_at = now()",
      "delete from telegram_messages",
      "update telegram_sources set channel_identifier = 'x'",
    ]) expect(await code(sql), sql).toBe("42501");
  });
  it("cannot touch any other table, create objects, or change roles", async () => {
    expect(await code("select 1 from signals")).toBe("42501");
    expect(await code("select 1 from drizzle.__drizzle_migrations")).toBe("42501");
    expect(await code("create table bot_made (a int)")).toBe("42501");
    expect(await code("create role other_role")).toBe("42501");
  });
  it("can create cards and events, and move a card only through the allowed columns", async () => {
    expect(await code(`insert into claim_review_cards (id, kind, claim_id, state, nonce, expires_at) values ($1,'test',null,'pending',$2, now() + interval '1 hour')`, [randomUUID(), "b".repeat(32)])).toBe("ok");
    expect(await code(`insert into approval_bot_events (id, event_type) values ($1,'test_event')`, [randomUUID()])).toBe("ok");
    expect(await code(`update claim_review_cards set state='decided', decided_at=now() where id=$1`, [testCardId])).toBe("ok");
    expect(await code(`update claim_review_cards set nonce = $2 where id=$1`, [testCardId, "c".repeat(32)])).toBe("42501");
    expect(await code(`update claim_review_cards set expires_at = now() + interval '9 days' where id=$1`, [testCardId])).toBe("42501");
    expect(await code("delete from claim_review_cards")).toBe("42501");
  });
  it("can insert a review but never alter or remove one (no privilege, and the trigger refuses even the owner)", async () => {
    expect(await code(`insert into claim_reviews (id, card_id, claim_id, decision, approver_telegram_user_id, card_telegram_message_id, update_id, evidence) values ($1,$2,$3,'reject',1,2,2,'{}')`, [randomUUID(), testCardId, claimId])).not.toBe("42501");
    expect(await code("update claim_reviews set decision = 'reject'")).toBe("42501");
    expect(await code("delete from claim_reviews")).toBe("42501");
    expect(await code("update approval_bot_events set detail = '{}'::jsonb")).toBe("42501");
    for (const sql of ["update claim_reviews set decision = 'reject'", "delete from claim_reviews", "truncate claim_reviews", "update approval_bot_events set event_type = 'x_y_z'", "delete from approval_bot_events", "truncate approval_bot_events"]) {
      await client.query("savepoint o");
      const err = await client.query(sql).then(() => null, (e: { code?: string }) => e.code);
      await client.query("rollback to savepoint o");
      expect(err, `owner: ${sql}`).toBe("23001");
    }
  });
  it("can read the three runtime safety control values (and only those columns) but can never change a control or see its audit", async () => {
    expect(await code("select control_name, value, version from system_controls")).toBe("ok");
    expect(await code(READ_CONTROLS_SQL)).toBe("ok"); // the exact statement the shared reader runs
    expect(await code("select * from system_controls")).toBe("42501");
    expect(await code("select reason from system_controls")).toBe("42501");
    expect(await code("select changed_by from system_controls")).toBe("42501");
    for (const sql of [
      "update system_controls set value = false",
      "update system_controls set value = true, version = version + 1, reason = 'bot trying to change a control'",
      "insert into system_controls (control_name, value, reason, changed_by) values ('KILL_SWITCH_ACTIVE', false, 'bot insert attempt', 'twins_bot')",
      "delete from system_controls",
      "truncate system_controls",
      "select 1 from system_control_events",
      "insert into system_control_events (control_name, new_value, reason, changed_by, changed_at, version, event_type) values ('KILL_SWITCH_ACTIVE', false, 'bot audit forgery', 'twins_bot', now(), 99, 'change')",
    ]) expect(await code(sql), sql).toBe("42501");
  });
  it("cannot read the audit hash-chain columns or the chain heads, and cannot touch the other audit tables (Task 3)", async () => {
    for (const sql of [
      "select event_hash from telegram_messages",
      "select chain_index from options_claims",
      "select payload_hash from options_claims",
      "select 1 from audit_events",
      "select 1 from signal_validations",
      "select 1 from audit_chain_heads",
      "update telegram_messages set raw_text = 'x'",
      "delete from audit_events",
      "truncate audit_events",
    ]) expect(await code(sql), sql).toBe("42501");
    expect(await code("select id, external_message_id, message_timestamp, telegram_source_id from telegram_messages")).toBe("ok");
  });
  it("can run the single bot state row, but only change the pause flag and offset", async () => {
    expect(await code(`insert into approval_bot_state (id, activated_at) values ('bot', now())`)).toBe("ok");
    await client.query(`insert into approval_bot_state (id, activated_at) values ('bot', now())`);
    expect(await code(`update approval_bot_state set paused = true, update_offset = 5, updated_at = now()`)).toBe("ok");
    expect(await code(`update approval_bot_state set activated_at = now() - interval '30 days'`)).toBe("42501");
  });
});
