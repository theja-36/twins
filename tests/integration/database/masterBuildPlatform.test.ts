/**
 * Migration 0033 against REAL PostgreSQL: the protections it adds actually hold (row-level security, owner-tied foreign keys, the decision guard, the live-mode lock,
 * append-only evidence, the mandatory-stop floor). Everything is synthetic; rows are keyed by fresh UUIDs because protected tables cannot be cleaned up.
 * The connection role owns the tables, and FORCE ROW LEVEL SECURITY applies the policies to it, so these tests exercise the real policies.
 */
import { allowSystemBinding, bindEveryTransaction } from "../support/boundSession";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl();
const clients: pg.Client[] = [];
const ROLE = "twins_rls_test";
let prepared = false;
/** The CI connection is a superuser, and superusers bypass row-level security even when it is FORCEd. So the policies are exercised through an unprivileged role (SET ROLE), the way twins_app meets them. */
async function prepareRole(c: pg.Client): Promise<void> {
  if (prepared) return;
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${ROLE}') then create role ${ROLE} nologin nosuperuser nobypassrls; end if; end $$`);
  await c.query(`grant usage on schema public to ${ROLE}`);
  await c.query(`grant select, insert, update, delete, truncate on all tables in schema public to ${ROLE}`);
  prepared = true;
}
/** Owner/superuser session for fixtures and for checks that do not depend on RLS. */
async function owner(): Promise<pg.Client> { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); clients.push(c); await prepareRole(c); return c; }
/** An application-like session: unprivileged role, with `twins.user_id` set to the user (or no user at all for a system-style session). */
async function session(userId: string | null): Promise<pg.Client> {
  const c = await owner();
  await allowSystemBinding(c, ROLE);
  await c.query(`set role ${ROLE}`);
  return bindEveryTransaction(c, userId);
}
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
const rows = async (c: pg.Client, sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as Array<Record<string, unknown>>;

async function newUserWithAccount(admin: pg.Client): Promise<{ userId: string; accountId: string }> {
  const userId = randomUUID(), accountId = randomUUID();
  await admin.query("insert into users (id, email, password_hash) values ($1, $2, 'x')", [userId, `${userId}@example.invalid`]);
  await admin.query("insert into accounts (id, user_id, name, trading_mode) values ($1, $2, 'paper account', 'paper')", [accountId, userId]);
  return { userId, accountId };
}
async function newCandidate(admin: pg.Client, stop: number | null): Promise<string> {
  const scanId = randomUUID(), id = randomUUID();
  await admin.query("insert into opportunity_scans (id, scan_kind, detector_version, data_source) values ($1, 'fixture-scan', 'test-v1', 'FIXTURE')", [scanId]);
  await admin.query("insert into opportunity_candidates (id, source, scan_id, underlying, side, entry_kind, stop_loss, data_source, correlation_id, expires_at) values ($1, 'INDEPENDENT', $2, 'NIFTY', 'BUY', 'above', $3, 'FIXTURE', $4, now() + interval '1 hour')", [id, scanId, stop, randomUUID()]);
  return id;
}
const capital = (c: pg.Client, user: string, account: string, version = 1) => c.query("insert into user_capital_profiles (id, user_id, account_id, version, total_capital, available_capital, created_by) values ($1, $2, $3, $4, 100000, 80000, 'test')", [randomUUID(), user, account, version]);
const decision = (c: pg.Client, o: { user: string; account: string; candidate: string; outcome: string; state?: string }) =>
  c.query("insert into user_decisions (id, user_id, account_id, candidate_id, outcome, workflow_state, explanation, valid_until) values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, now() + interval '15 minutes') returning id", [randomUUID(), o.user, o.account, o.candidate, o.outcome, o.state ?? "PENDING"]);

/** Stage 07 (migration 0038, guard v2): a QUALIFIED decision can only be created with a recorded VALID stop-loss validation, a non-blocked risk assessment, a permitted size and a research package. This helper supplies them. */
async function qualified(admin: pg.Client, s: pg.Client, u: { userId: string; accountId: string }, candidate: string): Promise<string> {
  const pkg = randomUUID(), risk = randomUUID();
  await admin.query("insert into research_packages (id, candidate_id, version, agent_results, assessment) values ($1, $2, 1, '{}'::jsonb, 'RESEARCH_SUPPORTIVE')", [pkg, candidate]);
  await admin.query("insert into risk_assessments (id, user_id, account_id, candidate_id, policy_version, passed, verdict, result) values ($1, $2, $3, $4, 1, false, 'RESTRICTED', '{}'::jsonb)", [risk, u.userId, u.accountId, candidate]);
  const r = await s.query("insert into user_decisions (id, user_id, account_id, candidate_id, outcome, explanation, stop_loss_validation, permitted_size, research_package_id, risk_assessment_id, valid_until) values ($1, $2, $3, $4, 'QUALIFIED', '{}'::jsonb, '{\"result\":\"VALID\",\"ruleVersion\":\"stop-loss-v1\"}'::jsonb, '{\"lots\":1,\"quantity\":25}'::jsonb, $5, $6, now() + interval '15 minutes') returning id", [randomUUID(), u.userId, u.accountId, candidate, pkg, risk]);
  return String(r.rows[0]?.id);
}

describe("row-level security isolates users", () => {
  it("a user sees only their own rows; another user and a session with no user see none; a foreign user_id cannot be written", async () => {
    const admin = await owner(); const a = await newUserWithAccount(admin), b = await newUserWithAccount(admin);
    const asA = await session(a.userId), asB = await session(b.userId), nobody = await session(null);
    await capital(asA, a.userId, a.accountId);
    expect(await rows(asA, "select 1 from user_capital_profiles where account_id = $1", [a.accountId])).toHaveLength(1);
    expect(await rows(asB, "select 1 from user_capital_profiles where account_id = $1", [a.accountId])).toHaveLength(0);
    expect(await rows(nobody, "select 1 from user_capital_profiles where account_id = $1", [a.accountId])).toHaveLength(0);
    await expect(capital(asB, a.userId, a.accountId, 2)).rejects.toThrow(/row-level security/); // B cannot write a row owned by A
  });
  it("a row cannot name another user's account, even with the caller's own user_id (composite foreign key)", async () => {
    const admin = await owner(); const a = await newUserWithAccount(admin), b = await newUserWithAccount(admin);
    const asB = await session(b.userId);
    await expect(capital(asB, b.userId, a.accountId)).rejects.toThrow(/foreign key/);
    await capital(asB, b.userId, b.accountId); // their own account is fine
  });
  it("decisions of one user are invisible to another and to a session without a user", async () => {
    const admin = await owner(); const a = await newUserWithAccount(admin), b = await newUserWithAccount(admin); const cand = await newCandidate(admin, 100);
    const asA = await session(a.userId), asB = await session(b.userId);
    await decision(asA, { user: a.userId, account: a.accountId, candidate: cand, outcome: "WAIT" });
    expect(await rows(asA, "select 1 from user_decisions where user_id = $1", [a.userId])).toHaveLength(1);
    expect(await rows(asB, "select 1 from user_decisions where user_id = $1", [a.userId])).toHaveLength(0);
  });
});

describe("the live execution lock and risk ceiling hold in the database", () => {
  it("PAPER may be enabled; ASSISTED_LIVE and CONTROLLED_AUTO can never be recorded as enabled", async () => {
    const admin = await owner(); const u = await newUserWithAccount(admin); const s = await session(u.userId);
    const perm = (mode: string, enabled: boolean) => s.query("insert into user_execution_permissions (user_id, account_id, mode, enabled, changed_by) values ($1, $2, $3, $4, 'test')", [u.userId, u.accountId, mode, enabled]);
    await perm("PAPER", true); await perm("ASSISTED_LIVE", false);
    await expect(perm("CONTROLLED_AUTO", true)).rejects.toThrow(/live_disabled_check/);
    await expect(s.query("update user_execution_permissions set enabled = true where account_id = $1 and mode = 'ASSISTED_LIVE'", [u.accountId])).rejects.toThrow(/live_disabled_check/);
  });
  it("risk percent above the 5 percent hard ceiling is refused", async () => {
    const admin = await owner(); const u = await newUserWithAccount(admin); const s = await session(u.userId);
    const pol = (v: number, risk: number) => s.query("insert into user_risk_policies (id, user_id, account_id, version, risk_percent, max_daily_loss, max_concurrent_positions, max_lots, min_reward_to_risk, created_by) values ($1, $2, $3, $4, $5, 1000, 3, 10, 1.5, 'test')", [randomUUID(), u.userId, u.accountId, v, risk]);
    await pol(1, 5); await expect(pol(2, 5.01)).rejects.toThrow(/risk_check/);
  });
});

describe("user_decisions guard", () => {
  it("a QUALIFIED decision needs a candidate with a stop-loss; none can start APPROVED", async () => {
    const admin = await owner(); const u = await newUserWithAccount(admin); const s = await session(u.userId);
    const noStop = await newCandidate(admin, null), withStop = await newCandidate(admin, 100);
    await expect(decision(s, { user: u.userId, account: u.accountId, candidate: noStop, outcome: "QUALIFIED" })).rejects.toThrow(/needs a candidate with a stop-loss/);
    await expect(decision(s, { user: u.userId, account: u.accountId, candidate: withStop, outcome: "QUALIFIED", state: "APPROVED" })).rejects.toThrow(/must start PENDING/);
    await expect(decision(s, { user: u.userId, account: u.accountId, candidate: withStop, outcome: "QUALIFIED" })).rejects.toThrow(/VALID mandatory stop-loss validation/); // guard v2: a stop-loss alone is only the floor
    await qualified(admin, s, u, withStop);
    await decision(s, { user: u.userId, account: u.accountId, candidate: noStop, outcome: "WAIT" }); // non-qualified is allowed without a stop
  });
  it("only workflow_state changes; outcome is immutable; a non-QUALIFIED decision cannot be APPROVED; final states are final; no delete", async () => {
    const admin = await owner(); const u = await newUserWithAccount(admin); const s = await session(u.userId); const cand = await newCandidate(admin, 100);
    const q = await qualified(admin, s, u, cand);
    const w = String((await decision(s, { user: u.userId, account: u.accountId, candidate: cand, outcome: "WAIT" })).rows[0]?.id);
    await expect(s.query("update user_decisions set outcome = 'QUALIFIED' where id = $1", [w])).rejects.toThrow(/only workflow_state/);
    await expect(s.query("update user_decisions set workflow_state = 'APPROVED' where id = $1", [w])).rejects.toThrow(/approved_qualified_check|only through a recorded approval action/);
    await expect(s.query("update user_decisions set valid_until = valid_until + interval '1 day' where id = $1", [q])).rejects.toThrow(/only workflow_state/);
    await expect(s.query("update user_decisions set workflow_state = 'APPROVED' where id = $1", [q])).rejects.toThrow(/only through a recorded approval action/); // guard v2: no approval record, no APPROVED
    await admin.query("insert into decision_approvals (id, user_id, decision_id, action, approver_user_id, permission_mode, revalidation, idempotency_key) values ($1, $2, $3, 'APPROVE', $2, 'PAPER', '{\"passed\":true}'::jsonb, $4)", [randomUUID(), u.userId, q, `key-${randomUUID()}`]);
    await s.query("update user_decisions set workflow_state = 'APPROVED' where id = $1", [q]);
    await expect(s.query("update user_decisions set workflow_state = 'PENDING' where id = $1", [q])).rejects.toThrow(/final state/);
    await expect(s.query("delete from user_decisions where id = $1", [q])).rejects.toThrow(/append-only/);
    await expect(s.query("truncate user_decisions")).rejects.toThrow(/append-only|cannot truncate/); // the foreign-key rule already refuses it; the trigger is the second line
  });
});

describe("evidence tables are append-only and shared writes are system-only", () => {
  it("a capital profile cannot be updated, deleted or truncated", async () => {
    const admin = await owner(); const u = await newUserWithAccount(admin); const s = await session(u.userId);
    await capital(s, u.userId, u.accountId);
    await expect(s.query("update user_capital_profiles set total_capital = 1 where account_id = $1", [u.accountId])).rejects.toThrow(/append-only/);
    await expect(s.query("delete from user_capital_profiles where account_id = $1", [u.accountId])).rejects.toThrow(/append-only/);
    await expect(admin.query("truncate user_capital_profiles")).rejects.toThrow(/append-only/);
  });
  it("a shared performance snapshot can be written only with no user context, and a user's own snapshot is private", async () => {
    const admin = await owner(); const a = await newUserWithAccount(admin), b = await newUserWithAccount(admin);
    const snap = (c: pg.Client, scope: string, user: string | null) => c.query("insert into performance_snapshots (id, scope, user_id, mode, period_start, period_end, metrics) values ($1, $2, $3, 'PAPER', now() - interval '1 day', now(), '{}'::jsonb)", [randomUUID(), scope, user]);
    const asA = await session(a.userId), asB = await session(b.userId);
    await expect(snap(asA, "PLATFORM", null)).rejects.toThrow(/row-level security/); // a user session cannot write shared rows
    await snap(await session(null), "PLATFORM", null); // a system-style session (no user context) can
    await snap(asA, "USER", a.userId);
    expect(await rows(asA, "select 1 from performance_snapshots where user_id = $1", [a.userId])).toHaveLength(1);
    expect(await rows(asB, "select 1 from performance_snapshots where user_id = $1", [a.userId])).toHaveLength(0);
  });
});

describe("the two opportunity pipelines cannot be mixed, and learning must be evaluated", () => {
  it("TELEGRAM needs a claim and INDEPENDENT needs a scan, never both", async () => {
    const admin = await owner(); const scanId = randomUUID();
    await admin.query("insert into opportunity_scans (id, scan_kind, detector_version, data_source) values ($1, 'fixture-scan', 'test-v1', 'FIXTURE')", [scanId]);
    const ins = (source: string, scan: string | null) => admin.query("insert into opportunity_candidates (id, source, scan_id, underlying, side, entry_kind, data_source, correlation_id, expires_at) values ($1, $2, $3, 'NIFTY', 'BUY', 'above', 'FIXTURE', $4, now() + interval '1 hour')", [randomUUID(), source, scan, randomUUID()]);
    await expect(ins("TELEGRAM", scanId)).rejects.toThrow(/origin_check/); await expect(ins("INDEPENDENT", null)).rejects.toThrow(/origin_check/); await ins("INDEPENDENT", scanId);
  });
  it("unvalidated learning cannot influence live policy and calibration needs out-of-sample evidence", async () => {
    const admin = await owner();
    await expect(admin.query("insert into learning_versions (id, kind, version, state, influences_live) values ($1, 'PLAYBOOK', 1, 'PROPOSED', true)", [randomUUID()])).rejects.toThrow(/live_active_check/);
    await expect(admin.query("insert into learning_versions (id, kind, version, state, activated_at) values ($1, 'PLAYBOOK', 1, 'ACTIVE', now())", [randomUUID()])).rejects.toThrow(/active_evaluation_check/);
    await expect(admin.query("insert into confidence_calibration_runs (id, model_version, sample_size, out_of_sample, bins, calibration_status) values ($1, 'm1', 100, false, '[]'::jsonb, 'CALIBRATED')", [randomUUID()])).rejects.toThrow(/oos_check/);
    await admin.query("insert into confidence_calibration_runs (id, model_version, sample_size, out_of_sample, bins, calibration_status) values ($1, 'm1', 100, true, '[]'::jsonb, 'CALIBRATED')", [randomUUID()]);
  });
});
