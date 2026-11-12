/**
 * F5 at the HTTP layer, against REAL PostgreSQL: the API's onRequest hook (apps/api/src/sessionCredential.ts) carries the caller's own session token to `withUser`, and the database binds the transaction from it.
 * The database connection is a real LOGIN role built by app-role.sql (the API role: it can bind only a live session token, never name a user). Each request is a fresh Fastify inject; nothing is mocked.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, hasSessionCredential, withUser } from "../../../packages/database/src/index";
import { registerSessionCredentialHook } from "../../../apps/api/src/sessionCredential";
import { bearerSessionToken } from "../../../apps/api/src/authApi";
import { mintSessionToken } from "../support/boundSession";
import { requireTestDatabaseUrl } from "../targetConfig";

const API = "twins_f5_http", PW = "f5_http_not_a_secret";
let owner: pg.Client, apiDb: ReturnType<typeof createDb>, app: ReturnType<typeof Fastify>;
let A: string, B: string, tokA: string, tokB: string;
const urlFor = (role: string): string => { const u = new URL(requireTestDatabaseUrl()); u.username = role; u.password = PW; return u.toString(); };
const mkUser = async (): Promise<string> => { const id = randomUUID(); await owner.query("begin"); await owner.query("select set_config('twins.privilege_door', 'open', true)"); await owner.query("insert into users (id, email, password_hash, role, is_active) values ($1, $2, 'x', 'TRADER', true)", [id, `${id}@example.com`]); await owner.query("commit"); return id; };
const who = (url: string, token?: string) => app.inject({ method: "GET", url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });

beforeAll(async () => {
  owner = new pg.Client({ connectionString: requireTestDatabaseUrl() }); await owner.connect();
  await owner.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${API}') then create role ${API} login password '${PW}'; end if; end $$`);
  await owner.query(readFileSync("infrastructure/staging/app-role.sql", "utf8").replaceAll(':"app_role"', `"${API}"`).replaceAll(":'app_role'", `'${API}'`));
  [A, B] = [await mkUser(), await mkUser()]; [tokA, tokB] = [await mintSessionToken(owner, A), await mintSessionToken(owner, B)];
  apiDb = createDb(urlFor(API));
  app = Fastify(); registerSessionCredentialHook(app);
  // the route claims a user id the way application code does (here: from the URL, i.e. a deliberately attacker-influenced value); the DATABASE decides whether that is who the caller is
  app.get<{ Params: { id: string } }>("/as/:id", async (request, reply) => {
    try {
      const out = await withUser(apiDb, request.params.id, async (tx) => { const r = (await tx.execute(await import("drizzle-orm").then((m) => m.sql`select user_id, via from public.twins_txn_identity`))) as unknown as { rows: Array<{ user_id: string; via: string }> }; return r.rows; });
      return { rows: out, hadCredentialInScope: hasSessionCredential(), tokenSeen: bearerSessionToken(request.headers.authorization) !== null };
    } catch (e) { return reply.code(500).send({ error: (e as Error).message.slice(0, 200) }); }
  });
  await app.ready();
});
afterAll(async () => { await app.close(); await owner.query(`drop owned by ${API}`).then(() => owner.query(`drop role if exists ${API}`)).catch(() => undefined); await owner.end(); });

describe("F5 over HTTP: the database binds the request to the user who owns the presented token", () => {
  it("a request with A's token acting for A is bound to A by SESSION, and the credential does not outlive the request", async () => {
    const r = await who(`/as/${A}`, tokA); expect(r.statusCode).toBe(200);
    expect(r.json().rows).toEqual([{ user_id: A, via: "SESSION" }]);
    expect(hasSessionCredential()).toBe(false);
  });
  it("a request with A's token that names B (a route bug, or an attacker-influenced id) is refused and binds nothing", async () => {
    const r = await who(`/as/${B}`, tokA); expect(r.statusCode).toBe(500); expect(r.json().error).toMatch(/does not match/);
  });
  it("no token, a malformed token, and a forged token all fail closed: the API role cannot fall back to naming a user", async () => {
    for (const t of [undefined, "garbage", "tws_" + "z".repeat(43)]) {
      const r = await who(`/as/${A}`, t); expect(r.statusCode, String(t)).toBe(500); expect(r.json().error, String(t)).toMatch(/Failed query: select public\.twins_bind_(system_user|session)/);
    }
  });
  it("many concurrent requests for different users never see each other's identity (the credential is request-scoped)", async () => {
    const calls = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? { id: A, tok: tokA } : { id: B, tok: tokB }));
    const out = await Promise.all(calls.map((c) => who(`/as/${c.id}`, c.tok)));
    out.forEach((r, i) => { expect(r.statusCode).toBe(200); expect(r.json().rows).toEqual([{ user_id: calls[i]!.id, via: "SESSION" }]); });
  });
  it("a revoked session stops binding on the very next request", async () => {
    const t = await mintSessionToken(owner, A); expect((await who(`/as/${A}`, t)).statusCode).toBe(200);
    await owner.query("update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [A]);
    expect((await who(`/as/${A}`, t)).statusCode).toBe(500);
    tokA = await mintSessionToken(owner, A);
  });
});
