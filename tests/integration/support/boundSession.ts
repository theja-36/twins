import type pg from "pg";

/**
 * F5 (migration 0049) test support. Policies and doors no longer read a settable `twins.user_id`; the acting user is bound to each TRANSACTION by a database door. The older application-like test sessions run many
 * single statements in autocommit (each its own transaction), so this wraps a client so that every transaction it runs is bound to `userId` through `twins_bind_system_user` (the system-role door), exactly as a worker
 * cycle would: a single statement becomes BEGIN; bind; statement; COMMIT, and an explicit BEGIN is bound straight after it. The role the client runs as must hold EXECUTE on the system door (see `allowSystemBinding`).
 * These sessions model the SYSTEM identity. The API identity (token-bound) is exercised against real API-style roles in tests/integration/database/userBinding.test.ts.
 */
export async function allowSystemBinding(owner: pg.Client, role: string): Promise<void> {
  await owner.query(`grant execute on function public.twins_bind_system_user(uuid), public.twins_bound_user_id() to ${role}`);
}

export function bindEveryTransaction(client: pg.Client, userId: string | null): pg.Client {
  if (!userId) return client;
  const raw = client.query.bind(client) as (...a: unknown[]) => Promise<pg.QueryResult>;
  let inTransaction = false;
  const bind = (): Promise<pg.QueryResult> => raw("select public.twins_bind_system_user($1::uuid)", [userId]);
  const textOf = (a: unknown): string => (typeof a === "string" ? a : ((a as { text?: string })?.text ?? ""));
  (client as unknown as { query: (...a: unknown[]) => Promise<pg.QueryResult> }).query = async (...args: unknown[]): Promise<pg.QueryResult> => {
    const text = textOf(args[0]);
    if (/^\s*(begin|start\s+transaction)\b/i.test(text)) { const r = await raw(...args); inTransaction = true; await bind(); return r; }
    if (/^\s*(commit|end|rollback)\b(?!\s+to)/i.test(text) && !/^\s*rollback\s+to\b/i.test(text)) { inTransaction = false; return raw(...args); }
    if (inTransaction || /^\s*(set|reset|select\s+set_config)\b/i.test(text)) return raw(...args);
    await raw("begin");
    try { await bind(); const r = await raw(...args); await raw("commit"); return r; } catch (e) { await raw("rollback").catch(() => undefined); throw e; }
  };
  return client;
}

/** A live session for `userId` created by the OWNER connection (the way a login would), returning the raw token that the API presents to twins_bind_session. Only the sha256 hash is stored. */
export async function mintSessionToken(owner: pg.Client, userId: string, opts: { ttlMs?: number; revoked?: boolean; expired?: boolean } = {}): Promise<string> {
  const { createHash, randomBytes } = await import("node:crypto");
  const token = "tws_" + randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await owner.query("insert into user_sessions (id, user_id, token_hash, created_at, expires_at, revoked_at) values (gen_random_uuid(), $1::uuid, $2, now() - ($5 || ' milliseconds')::interval, now() + ($3 || ' milliseconds')::interval, $4)", [userId, hash, String(opts.expired ? -3_600_000 : (opts.ttlMs ?? 3_600_000)), opts.revoked ? new Date() : null, String(opts.expired ? 7_200_000 : 0)]);
  return token;
}
