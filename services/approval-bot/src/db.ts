import pg from "pg";
import type { ClaimRow } from "./card";

/** What the bot logic needs from the database (a port, so tests can drive it with an in-memory fake that has the same semantics). */
export type CardState = "pending" | "sent" | "decided" | "expired";
export type CardKind = "claim" | "test";

export interface CardRow {
  id: string;
  kind: CardKind;
  claimId: string | null;
  state: CardState;
  nonce: string;
  telegramMessageId: number | null;
  cardTextSha256: string | null;
  expiresAt: Date;
}

export interface BotState {
  activatedAt: Date;
  paused: boolean;
  updateOffset: number;
}

export type DecideResult = { outcome: "recorded"; kind: CardKind } | { outcome: "not_pending" } | { outcome: "expired" } | { outcome: "unknown" };

export interface DecideInput {
  cardId: string;
  action: "approve" | "reject";
  approverId: number;
  updateId: number;
  cardMessageId: number;
}

export interface BotDb {
  /** Problems with the role's privileges (empty = exactly as designed). */
  checkPrivileges(): Promise<string[]>;
  getState(): Promise<BotState | null>;
  ensureState(activatedAt: Date): Promise<void>;
  setUpdateOffset(offset: number): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  selectNewClaims(since: Date, channels: readonly string[], limit: number): Promise<ClaimRow[]>;
  getClaimForCard(cardId: string): Promise<ClaimRow | null>;
  listPendingCards(limit: number): Promise<CardRow[]>;
  createCard(input: { id: string; kind: CardKind; claimId: string | null; nonce: string; ttlSeconds: number }): Promise<CardRow | null>;
  markSent(cardId: string, telegramMessageId: number, cardTextSha256: string): Promise<boolean>;
  getCard(cardId: string): Promise<CardRow | null>;
  decide(input: DecideInput): Promise<DecideResult>;
  expireDue(): Promise<CardRow[]>;
  countSentSince(since: Date): Promise<number>;
  countByState(): Promise<Record<string, number>>;
  recordEvent(type: string, cardId: string | null, detail: Record<string, string | number | boolean>): Promise<void>;
  close(): Promise<void>;
}

/** Tables the bot may write. A static test pins this list and checks that no other table appears in an INSERT/UPDATE/DELETE statement. */
export const WRITE_TABLES = ["claim_review_cards", "claim_reviews", "approval_bot_events", "approval_bot_state"] as const;
/** Everything the role may read, with the column lists granted (raw_text and raw_payload are NOT among them). */
const READABLE = ["options_claims", "telegram_messages", "telegram_sources", ...WRITE_TABLES];

const CARD_COLUMNS = "id, kind, claim_id, state, nonce, telegram_message_id, card_text_sha256, expires_at";

function toCard(r: Record<string, unknown>): CardRow {
  return {
    id: r["id"] as string,
    kind: r["kind"] as CardKind,
    claimId: (r["claim_id"] as string | null) ?? null,
    state: r["state"] as CardState,
    nonce: r["nonce"] as string,
    telegramMessageId: r["telegram_message_id"] === null || r["telegram_message_id"] === undefined ? null : Number(r["telegram_message_id"]),
    cardTextSha256: (r["card_text_sha256"] as string | null) ?? null,
    expiresAt: r["expires_at"] as Date,
  };
}

function toClaim(r: Record<string, unknown>): ClaimRow {
  return {
    claimId: r["claim_id"] as string,
    createdAt: r["created_at"] as Date,
    parserVersion: r["parser_version"] as string,
    claim: r["claim"],
    reasons: r["reasons"],
    assessmentOutcome: (r["assessment_outcome"] as string | null) ?? null,
    externalMessageId: r["external_message_id"] as string,
    messageTimestamp: r["message_timestamp"] as Date,
  };
}

const CLAIM_SELECT = `select c.id as claim_id, c.created_at, c.parser_version, c.claim, c.reasons, c.assessment_outcome, m.external_message_id, m.message_timestamp
  from options_claims c
  join telegram_messages m on m.id = c.telegram_message_id
  join telegram_sources s on s.id = m.telegram_source_id`;

export class PgBotDb implements BotDb {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, pool?: pg.Pool) {
    this.pool = pool ?? new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: "twins-approval-bot" });
  }

  async checkPrivileges(): Promise<string[]> {
    const problems: string[] = [];
    const q = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await this.pool.query(sql, params)).rows;
    const role = (await q("select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname = current_user"))[0];
    if (!role) problems.push("role_not_found");
    else for (const k of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"]) if (role[k] === true) problems.push(`role_is:${k}`);
    if ((await q("select current_user as u"))[0]?.["u"] !== "twins_bot") problems.push("not_connected_as_twins_bot");
    if ((await q("select has_schema_privilege('public', 'CREATE') as c"))[0]?.["c"] === true) problems.push("can_create_in_schema_public");
    const claims = (await q(
      `select has_any_column_privilege('options_claims','INSERT') or has_any_column_privilege('options_claims','UPDATE') or has_table_privilege('options_claims','DELETE') or has_table_privilege('options_claims','TRUNCATE') as w`,
    ))[0];
    if (claims?.["w"] === true) problems.push("can_write:options_claims");
    const messages = (await q(
      `select has_any_column_privilege('telegram_messages','INSERT') or has_any_column_privilege('telegram_messages','UPDATE') or has_table_privilege('telegram_messages','DELETE') or has_table_privilege('telegram_messages','TRUNCATE') as w,
              has_column_privilege('telegram_messages','raw_text','SELECT') as t, has_column_privilege('telegram_messages','raw_payload','SELECT') as p`,
    ))[0];
    if (messages?.["w"] === true) problems.push("can_write:telegram_messages");
    if (messages?.["t"] === true) problems.push("can_read:raw_text");
    if (messages?.["p"] === true) problems.push("can_read:raw_payload");
    const append = await q(
      `select c.relname from pg_class c where c.relname in ('claim_reviews','approval_bot_events') and c.relnamespace = 'public'::regnamespace
         and (has_any_column_privilege(c.oid,'UPDATE') or has_table_privilege(c.oid,'DELETE') or has_table_privilege(c.oid,'TRUNCATE'))`,
    );
    for (const r of append) problems.push(`can_modify_append_only:${String(r["relname"])}`);
    const others = await q(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','v','m','p','f') and c.relname <> all($1)
          and (has_any_column_privilege(c.oid,'SELECT') or has_any_column_privilege(c.oid,'INSERT') or has_any_column_privilege(c.oid,'UPDATE') or has_table_privilege(c.oid,'DELETE') or has_table_privilege(c.oid,'TRUNCATE'))
        order by c.relname limit 5`,
      [READABLE],
    );
    for (const r of others) problems.push(`can_access_other_table:${String(r["relname"])}`);
    return problems;
  }

  async getState(): Promise<BotState | null> {
    const r = (await this.pool.query("select activated_at, paused, update_offset from approval_bot_state where id = 'bot'")).rows[0];
    return r ? { activatedAt: r.activated_at as Date, paused: r.paused as boolean, updateOffset: Number(r.update_offset) } : null;
  }

  async ensureState(activatedAt: Date): Promise<void> {
    await this.pool.query("insert into approval_bot_state (id, activated_at) values ('bot', $1) on conflict (id) do nothing", [activatedAt]);
  }

  async setUpdateOffset(offset: number): Promise<void> {
    await this.pool.query("update approval_bot_state set update_offset = $1, updated_at = now() where id = 'bot'", [offset]);
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.pool.query("update approval_bot_state set paused = $1, updated_at = now() where id = 'bot'", [paused]);
  }

  async selectNewClaims(since: Date, channels: readonly string[], limit: number): Promise<ClaimRow[]> {
    const rows = (
      await this.pool.query(
        `${CLAIM_SELECT}
          where c.result_kind = 'claim' and c.created_at > $1 and s.channel_identifier = any($2)
            and not exists (select 1 from claim_review_cards k where k.claim_id = c.id)
          order by c.created_at asc, c.id asc limit $3`,
        [since, channels, limit],
      )
    ).rows;
    return rows.map(toClaim);
  }

  async getClaimForCard(cardId: string): Promise<ClaimRow | null> {
    const r = (
      await this.pool.query(`${CLAIM_SELECT} join claim_review_cards k on k.claim_id = c.id where k.id = $1`, [cardId])
    ).rows[0];
    return r ? toClaim(r) : null;
  }

  async listPendingCards(limit: number): Promise<CardRow[]> {
    const rows = (
      await this.pool.query(`select ${CARD_COLUMNS} from claim_review_cards where state = 'pending' and kind = 'claim' and expires_at > now() order by created_at asc limit $1`, [limit])
    ).rows;
    return rows.map(toCard);
  }

  async createCard(input: { id: string; kind: CardKind; claimId: string | null; nonce: string; ttlSeconds: number }): Promise<CardRow | null> {
    const r = (
      await this.pool.query(
        `insert into claim_review_cards (id, kind, claim_id, state, nonce, expires_at)
         values ($1, $2, $3, 'pending', $4, now() + make_interval(secs => $5))
         on conflict (claim_id) do nothing
         returning ${CARD_COLUMNS}`,
        [input.id, input.kind, input.claimId, input.nonce, input.ttlSeconds],
      )
    ).rows[0];
    return r ? toCard(r) : null;
  }

  async markSent(cardId: string, telegramMessageId: number, cardTextSha256: string): Promise<boolean> {
    const r = await this.pool.query(
      "update claim_review_cards set state = 'sent', telegram_message_id = $2, card_text_sha256 = $3, sent_at = now() where id = $1 and state = 'pending'",
      [cardId, telegramMessageId, cardTextSha256],
    );
    return r.rowCount === 1;
  }

  async getCard(cardId: string): Promise<CardRow | null> {
    const r = (await this.pool.query(`select ${CARD_COLUMNS} from claim_review_cards where id = $1`, [cardId])).rows[0];
    return r ? toCard(r) : null;
  }

  /**
   * Single-use decision in ONE transaction: the card must be 'sent', unexpired and carry the message id the tap came from; the state flips to
   * 'decided' (exactly one row) and then the decision row is inserted. A second tap, a replay or a late tap finds no 'sent' card and records
   * nothing. A TEST card (handshake) records only an event. The decision never touches options_claims.
   */
  async decide(input: DecideInput): Promise<DecideResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const updated = (
        await client.query(
          `update claim_review_cards set state = 'decided', decided_at = now()
            where id = $1 and state = 'sent' and expires_at > now() and telegram_message_id = $2
            returning kind, claim_id, card_text_sha256`,
          [input.cardId, input.cardMessageId],
        )
      ).rows[0];
      if (!updated) {
        const card = (await client.query("select state, expires_at <= now() as late from claim_review_cards where id = $1", [input.cardId])).rows[0];
        await client.query("commit");
        if (!card) return { outcome: "unknown" };
        return card.late === true && (card.state === "sent" || card.state === "pending") ? { outcome: "expired" } : { outcome: "not_pending" };
      }
      if (updated.kind === "claim") {
        await client.query(
          `insert into claim_reviews (id, card_id, claim_id, decision, approver_telegram_user_id, card_telegram_message_id, update_id, evidence)
           select gen_random_uuid(), $1, c.id, $2, $3, $4, $5,
                  jsonb_build_object('claim_id', c.id, 'parser_version', c.parser_version,
                                     'claim_sha256', encode(sha256(convert_to(c.claim::text, 'UTF8')), 'hex'),
                                     'card_text_sha256', $6::text,
                                     'reason_codes', coalesce((select jsonb_agg(r ->> 'code') from jsonb_array_elements(c.reasons) r), '[]'::jsonb),
                                     'assessment_outcome', c.assessment_outcome)
             from options_claims c where c.id = $7`,
          [input.cardId, input.action, input.approverId, input.cardMessageId, input.updateId, updated.card_text_sha256, updated.claim_id],
        );
      }
      await client.query("insert into approval_bot_events (id, event_type, card_id, detail) values (gen_random_uuid(), $1, $2, $3::jsonb)", [
        updated.kind === "claim" ? "decision" : "test_decision",
        input.cardId,
        JSON.stringify({ action: input.action, update_id: input.updateId }),
      ]);
      await client.query("commit");
      return { outcome: "recorded", kind: updated.kind as CardKind };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async expireDue(): Promise<CardRow[]> {
    const rows = (
      await this.pool.query(`update claim_review_cards set state = 'expired' where state in ('pending', 'sent') and expires_at <= now() returning ${CARD_COLUMNS}`)
    ).rows;
    return rows.map(toCard);
  }

  async countSentSince(since: Date): Promise<number> {
    return Number((await this.pool.query("select count(*) as n from claim_review_cards where kind = 'claim' and sent_at > $1", [since])).rows[0]?.n ?? 0);
  }

  async countByState(): Promise<Record<string, number>> {
    const rows = (await this.pool.query("select state, count(*) as n from claim_review_cards where kind = 'claim' group by state")).rows;
    return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
  }

  async recordEvent(type: string, cardId: string | null, detail: Record<string, string | number | boolean>): Promise<void> {
    await this.pool.query("insert into approval_bot_events (id, event_type, card_id, detail) values (gen_random_uuid(), $1, $2, $3::jsonb)", [type, cardId, JSON.stringify(detail)]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
