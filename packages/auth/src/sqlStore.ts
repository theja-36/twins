import { sql } from "drizzle-orm";
import { withUser, type Db } from "@twins/database";
import type { Role, UserId } from "@twins/types";
import type { AuditSink, AuthStore, SessionRecord, UserRecord } from "./service";

/**
 * PostgreSQL AuthStore (Stage 01). Every privileged write goes through a SECURITY DEFINER door of migration 0040 (twins_create_user, twins_set_user_role, twins_set_user_active, twins_clear_login_failures),
 * each wrapped in withUser(actor) so the database itself checks that the actor is the active administrator bound to the transaction. The runtime role cannot write users.role or users.is_active directly (G-13).
 */
type Row = Record<string, unknown>;
const rows = (r: unknown): Row[] => ((r as { rows?: Row[] }).rows ?? []);
const userOf = (r: Row): UserRecord => ({ id: r["id"] as UserId, email: r["email"] as string, passwordHash: r["password_hash"] as string, displayName: (r["display_name"] as string | null) ?? null, role: r["role"] as Role, isActive: r["is_active"] as boolean });
const sessionOf = (r: Row): SessionRecord => ({ id: r["id"] as string, userId: r["user_id"] as UserId, tokenHash: r["token_hash"] as string, createdAt: new Date(r["created_at"] as string), expiresAt: new Date(r["expires_at"] as string), revokedAt: r["revoked_at"] ? new Date(r["revoked_at"] as string) : null, lastSeenAt: r["last_seen_at"] ? new Date(r["last_seen_at"] as string) : null });
const COLS = sql.raw("id, email, password_hash, display_name, role, is_active");

export function sqlAuthStore(db: Db): AuthStore {
  return {
    async findUserByEmail(email) { const r = rows(await db.execute(sql`select ${COLS} from users where email = ${email} limit 1`))[0]; return r ? userOf(r) : null; },
    async findUserById(id) { const r = rows(await db.execute(sql`select ${COLS} from users where id = ${id}::uuid limit 1`))[0]; return r ? userOf(r) : null; },
    async createUser(u) {
      const exec = async (tx: Pick<Db, "execute">, actor: string | null): Promise<string | null> => {
        const r = rows(await tx.execute(sql`select twins_create_user(${u.email}, ${u.passwordHash}, ${u.displayName}, ${u.role}, ${actor}::uuid) as id`))[0];
        return (r?.["id"] as string | null) ?? null;
      };
      const id = u.actorId ? await withUser(db, u.actorId, (tx) => exec(tx as Pick<Db, "execute">, u.actorId)) : await exec(db, null);
      return id ? { id: id as UserId, email: u.email, passwordHash: u.passwordHash, displayName: u.displayName, role: u.role, isActive: true } : null;
    },
    async countActiveAdmins() { return Number(rows(await db.execute(sql`select count(*)::int as n from users where role = 'ADMIN' and is_active`))[0]?.["n"] ?? 0); },
    async setPasswordHash(id, h) { await db.execute(sql`update users set password_hash = ${h}, updated_at = now() where id = ${id}::uuid`); },
    async setRole(actorId, targetId, role) { return withUser(db, actorId, async (tx) => rows(await tx.execute(sql`select twins_set_user_role(${actorId}::uuid, ${targetId}::uuid, ${role}) as ok`))[0]?.["ok"] === true); },
    async setActive(actorId, targetId, active) { return withUser(db, actorId, async (tx) => rows(await tx.execute(sql`select twins_set_user_active(${actorId}::uuid, ${targetId}::uuid, ${active}) as ok`))[0]?.["ok"] === true); },
    async createSession(s) {
      const r = rows(await db.execute(sql`insert into user_sessions (id, user_id, token_hash, created_at, expires_at) values (gen_random_uuid(), ${s.userId}::uuid, ${s.tokenHash}, ${s.createdAt.toISOString()}::timestamptz, ${s.expiresAt.toISOString()}::timestamptz) returning *`))[0];
      return sessionOf(r as Row);
    },
    async findSessionByTokenHash(h) { const r = rows(await db.execute(sql`select * from user_sessions where token_hash = ${h} limit 1`))[0]; return r ? sessionOf(r) : null; },
    async touchSession(id, expiresAt, seenAt) { await db.execute(sql`update user_sessions set expires_at = ${expiresAt.toISOString()}::timestamptz, last_seen_at = ${seenAt.toISOString()}::timestamptz where id = ${id}::uuid and revoked_at is null`); },
    async revokeSession(id, at) { await db.execute(sql`update user_sessions set revoked_at = ${at.toISOString()}::timestamptz where id = ${id}::uuid and revoked_at is null`); },
    async revokeUserSessions(userId, at, except) {
      const r = await db.execute(sql`update user_sessions set revoked_at = ${at.toISOString()}::timestamptz where user_id = ${userId}::uuid and revoked_at is null and (${except ?? null}::uuid is null or id <> ${except ?? null}::uuid)`);
      return Number((r as { rowCount?: number }).rowCount ?? 0);
    },
    async recordLoginFailure(key, at) { await db.execute(sql`insert into auth_login_failures (id, key_hash, at) values (gen_random_uuid(), ${key}, ${at.toISOString()}::timestamptz)`); },
    async countLoginFailures(key, since) { return Number(rows(await db.execute(sql`select count(*)::int as n from auth_login_failures where key_hash = ${key} and at >= ${since.toISOString()}::timestamptz`))[0]?.["n"] ?? 0); },
    async clearLoginFailures(key) { await db.execute(sql`select twins_clear_login_failures(${key})`); },
  };
}

const DOOR_AUDITED = new Set(["auth.role_changed"]); // the SQL door already wrote this event in the same transaction
/** Audit sink writing to the existing append-only audit_events table (the role/active/create doors already write their own events inside the transaction; this records the rest: logins, failures, logouts, password changes). */
export function sqlAuditSink(db: Db): AuditSink {
  return async (e) => {
    if (DOOR_AUDITED.has(e.type)) return;
    await db.execute(sql`insert into audit_events (id, event_type, entity_type, entity_id, actor_type, actor_id, metadata) values (gen_random_uuid(), ${e.type}, 'user', ${e.targetId}::uuid, ${e.actorId ? "user" : "system"}::actor_type, ${e.actorId}, ${JSON.stringify(e.detail)}::jsonb)`);
  };
}
