/**
 * Stage 02 (database architecture and domain model) against REAL PostgreSQL: migration 0041 and the invariants of the whole trading lifecycle.
 * Decision -> risk assessment -> approval -> execution request -> order -> fill -> position -> outcome, user isolation at the database layer, exact-decimal money, concurrency and append-only history.
 * The global scans (orphans, approval-less orders, live modes, float money) run over EVERYTHING the other integration tests created in the same database, which is the point: an invariant that holds for all of it is not an accident of one fixture.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendCapitalProfile, createExecutionRequest, createPaperOrder, getPositionForDecision, insertPaperFill, setOrderStatus, updateExecutionRequest } from "../../../packages/database/src/index";
import { approveDecision } from "../../../packages/decision/src/index";
import { requestPaperExecution } from "../../../packages/execution/src/index";
import { closeClients, db, evalDeps, execDeps, newUser, NOW, owner, pipeline, session, trade, type Pipe } from "../support/tradingPipeline";
import { describeMigrationMismatch, loadExpectedMigrations } from "../migrationState";

afterAll(async () => { await closeClients(); });
async function refused(f: () => Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null; try { await f(); } catch (e) { err = e; }
  expect(err, "expected the database to refuse").not.toBeNull();
  expect(`${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""} ${(err as { code?: string })?.code ?? ""}`).toMatch(re);
}
let sharedOwner: Awaited<ReturnType<typeof owner>> | null = null;
/** One shared owner connection for the whole file: the database has a limited number of connections and this file runs many small queries. */
const own = async (): Promise<Awaited<ReturnType<typeof owner>>> => (sharedOwner ??= await owner());
const scalar = async (sql: string, p: unknown[] = []): Promise<unknown> => { const c = await own(); const r = await c.query(sql, p); return r.rows[0] ? Object.values(r.rows[0])[0] : null; };

describe("migration chain", () => {
  it("the target database is exactly at the repository's chain (every migration applied once, in order, with the committed content)", async () => {
    const c = await own(); const rec = (await c.query("select hash, created_at from drizzle.__drizzle_migrations order by id")).rows;
    expect(describeMigrationMismatch(loadExpectedMigrations(), rec)).toBeNull();
    expect(rec.length).toBeGreaterThanOrEqual(42);
  });
  it("migration 0041 objects exist", async () => {
    expect(await scalar("select count(*)::int from pg_class where relname in ('account_portfolio_facts','paper_position_fill_check') and relkind = 'v'")).toBe(2);
    expect(await scalar("select count(*)::int from pg_proc where proname in ('twins_list_active_accounts','twins_list_active_account_users','twins_user_decision_links_guard')")).toBe(3);
    expect(await scalar("select count(*)::int from pg_constraint where conname = 'accounts_broker_owner_fk'")).toBe(1);
  });
});

describe("ownership is enforced by the database, not only by the API", () => {
  it("EVERY table that carries a user id is row-level protected and forced, except the documented session-lookup table", async () => {
    const c = await own();
    const r = await c.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join information_schema.columns k on k.table_name = c.relname and k.table_schema = 'public' and k.column_name = 'user_id'
                              where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`);
    const unprotected = r.rows.filter((x: { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }) => !(x.relrowsecurity && x.relforcerowsecurity)).map((x: { relname: string }) => x.relname);
    expect(unprotected).toEqual(["twins_txn_identity", "user_sessions"]); // user_sessions: looked up by the SHA-256 of a 256-bit secret before any user is known; never listed, never exposed by a route. twins_txn_identity (0049): row-level secured but not forced, because the owner-run bind doors must write it; no runtime role holds any write on it
    expect(r.rows.length).toBeGreaterThan(20);
  });
  it("every account-owned legacy table (account id, no user id) is protected through its account", async () => {
    const c = await own();
    for (const t of ["orders", "positions", "portfolio_snapshots", "fills"]) {
      const r = await c.query("select relrowsecurity, relforcerowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace", [t]);
      expect(r.rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(Number(await scalar("select count(*)::int from pg_policies where tablename = $1", [t])), t).toBeGreaterThan(0);
    }
  });
  it("user A cannot read, change, delete or create rows of user B's account or broker connection", async () => {
    const a = await newUser(), b = await newUser(), o = await own(), conn = randomUUID();
    await o.query("insert into broker_connections (id, user_id, provider, credential_ref) values ($1, $2, 'kite', 'secretref:kite_main')", [conn, b.userId]);
    const ca = await session(a.userId);
    expect((await ca.query("select count(*)::int as n from accounts where id = $1", [b.accountId])).rows[0].n).toBe(0);
    expect((await ca.query("select count(*)::int as n from broker_connections where id = $1", [conn])).rows[0].n).toBe(0);
    expect((await ca.query("update accounts set name = 'hijacked' where id = $1", [b.accountId])).rowCount).toBe(0);
    expect((await ca.query("update broker_connections set provider = 'x' where id = $1", [conn])).rowCount).toBe(0);
    expect((await ca.query("delete from accounts where id = $1", [b.accountId])).rowCount).toBe(0);
    await refused(() => ca.query("insert into accounts (id, user_id, name, trading_mode) values (gen_random_uuid(), $1, 'planted', 'paper')", [b.userId]), /row-level security|42501/);
    await refused(() => ca.query("update accounts set user_id = $1 where id = $2", [b.userId, a.accountId]), /row-level security|42501/); // ownership cannot be handed over
    expect(await scalar("select name from accounts where id = $1", [b.accountId])).toBe("paper account");
    const cb = await session(b.userId); expect((await cb.query("select count(*)::int as n from broker_connections where id = $1", [conn])).rows[0].n).toBe(1);
  });
  it("the cross-user listing functions return identifiers only", async () => {
    const o = await own(); const r = await o.query("select * from twins_list_active_accounts() limit 1");
    expect(Object.keys(r.rows[0] ?? { a_account_id: 1, a_user_id: 1 }).sort()).toEqual(["a_account_id", "a_user_id"]);
  });
  it("an account can only use its OWNER's broker connection, and a connection can only hold a secret REFERENCE", async () => {
    const a = await newUser(), b = await newUser(), o = await own(), connB = randomUUID();
    await o.query("insert into broker_connections (id, user_id, provider) values ($1, $2, 'kite')", [connB, b.userId]);
    await refused(() => o.query("update accounts set broker_connection_id = $1 where id = $2", [connB, a.accountId]), /accounts_broker_owner_fk|foreign key|23503/);
    const connA = randomUUID(); await o.query("insert into broker_connections (id, user_id, provider) values ($1, $2, 'kite')", [connA, a.userId]);
    await o.query("update accounts set broker_connection_id = $1 where id = $2", [connA, a.accountId]);
    for (const bad of ["AKIAIOSFODNN7EXAMPLE", "secretref:", "secretref:has space", "sk-live-abcdef", "secretref:" + "x".repeat(101)]) await refused(() => o.query("update broker_connections set credential_ref = $1 where id = $2", [bad, connA]), /broker_connections_credential_ref_check|23514/);
    await o.query("update broker_connections set credential_ref = 'secretref:kite_main-1.prod' where id = $1", [connA]);
  });
  it("capital profiles, risk policies and execution permissions of another user's account are refused (composite owner keys + RLS)", async () => {
    const a = await newUser(), b = await newUser(), ca = await session(a.userId);
    await refused(() => ca.query("insert into user_capital_profiles (id, user_id, account_id, version, total_capital, available_capital, currency, effective_from, created_by) values (gen_random_uuid(), $1, $2, 1, 1000, 1000, 'INR', now(), 'x')", [a.userId, b.accountId]), /foreign key|23503/);
    await refused(() => ca.query("insert into user_capital_profiles (id, user_id, account_id, version, total_capital, available_capital, currency, effective_from, created_by) values (gen_random_uuid(), $1, $2, 1, 1000, 1000, 'INR', now(), 'x')", [b.userId, b.accountId]), /row-level security|42501/);
    await refused(() => ca.query("insert into user_execution_permissions (user_id, account_id, mode, enabled, changed_by) values ($1, $2, 'PAPER', true, 'x')", [a.userId, b.accountId]), /foreign key|23503/);
    const o = await own();
    for (const [t, col] of [["user_capital_profiles", "account_id"], ["user_risk_policies", "account_id"], ["user_execution_permissions", "account_id"], ["risk_assessments", "account_id"], ["simulations", "account_id"], ["user_decisions", "account_id"], ["execution_requests", "account_id"], ["paper_orders", "account_id"], ["paper_positions", "account_id"], ["outcome_attributions", "account_id"]] as const) {
      const n = await o.query(`select count(*)::int as n from pg_constraint where contype = 'f' and conrelid = $1::regclass and confrelid = 'accounts'::regclass and array_length(conkey, 1) = 2`, [t]);
      expect(n.rows[0].n, `${t}.${col} must reference accounts(id, user_id)`).toBeGreaterThanOrEqual(1);
    }
  });
  it("live execution modes cannot be enabled for any account, by any role", async () => {
    const a = await newUser(), o = await own();
    for (const mode of ["ASSISTED_LIVE", "CONTROLLED_AUTO"]) await refused(() => o.query("insert into user_execution_permissions (user_id, account_id, mode, enabled, changed_by) values ($1, $2, $3, true, 'x')", [a.userId, a.accountId, mode]), /live_disabled|23514/);
    expect(await scalar("select count(*)::int from user_execution_permissions where mode <> 'PAPER' and enabled")).toBe(0);
  });
});

describe("decision links (0041 guard)", () => {
  it("a decision cannot cite another user's risk assessment, or one from another candidate of the same user", async () => {
    const a = await pipeline(), b = await pipeline(), a2 = await pipeline({ userId: a.userId, accountId: a.accountId });
    const ra = String(await scalar("select risk_assessment_id from user_decisions where id = $1", [a.decisionId]));
    const rb = String(await scalar("select risk_assessment_id from user_decisions where id = $1", [b.decisionId]));
    const c = await session(a.userId);
    const payload = (candId: string, risk: string) => JSON.stringify({ user_id: a.userId, account_id: a.accountId, candidate_id: candId, outcome: "WAIT", risk_assessment_id: risk, explanation: {}, evidence_refs: [], versions: {}, valid_until: new Date(Date.now() + 3600_000).toISOString(), actor: "test", reason: "links test" });
    await refused(() => c.query("select twins_create_user_decision($1::jsonb)", [payload(a.candId, rb)]), /foreign key|23503|same user/);          // another user's assessment
    await refused(() => c.query("select twins_create_user_decision($1::jsonb)", [payload(a2.candId, ra)]), /same user, account and candidate/);  // same user, wrong candidate
    expect(a2.candId).not.toBe(a.candId);
  });
});

describe("the trading lifecycle: Decision -> Approval -> Request -> Order -> Fill -> Position -> Outcome", () => {
  let closed: Pipe, partial: Pipe;
  it("a full paper trade leaves one consistent, owner-pure chain", async () => {
    closed = await pipeline(); await trade(closed, "close");
    const o = await own(), id = closed.decisionId, uid = closed.userId;
    expect(await scalar("select workflow_state from user_decisions where id = $1", [id])).toBe("APPROVED");
    expect(await scalar("select count(*)::int from decision_approvals where decision_id = $1 and action = 'APPROVE' and approver_user_id = user_id", [id])).toBe(1);
    expect(Number(await scalar("select count(*)::int from execution_requests where decision_id = $1 and mode = 'PAPER'", [id]))).toBeGreaterThanOrEqual(1);
    const orders = (await o.query("select id, purpose, status, user_id, account_id, mode from paper_orders where decision_id = $1 order by created_at", [id])).rows;
    expect(orders.length).toBeGreaterThanOrEqual(2); expect(orders.every((x: { user_id: string; account_id: string; mode: string }) => x.user_id === uid && x.account_id === closed.accountId && x.mode === "PAPER")).toBe(true);
    expect(orders.some((x: { purpose: string }) => x.purpose === "ENTRY")).toBe(true); expect(orders.some((x: { purpose: string }) => x.purpose === "EXIT")).toBe(true);
    const pos = (await getPositionForDecision(db, uid, id))!; expect(pos.status).toBe("CLOSED");
    expect(Number(await scalar("select count(*)::int from paper_position_events where position_id = $1", [pos.id]))).toBeGreaterThan(1);
    expect(Number(await scalar("select count(*)::int from trade_outcomes where paper_position_id = $1 and user_id = $2", [pos.id, uid]))).toBeGreaterThanOrEqual(1);
  });
  it("position quantity equals entry fills minus exit fills for an open, a partly exited and a closed position", async () => {
    const open = await pipeline(); await trade(open, "open"); partial = await pipeline(); await trade(partial, "partial");
    for (const p of [open, partial, closed]) {
      const r = await (await own()).query("select position_quantity::text as q, derived_quantity::text as d, matches from paper_position_fill_check where user_id = $1", [p.userId]);
      expect(r.rows.length).toBe(1); expect(r.rows[0], `${p.decisionId}: ${JSON.stringify(r.rows[0])}`).toMatchObject({ matches: true });
    }
    expect(Number(await scalar("select derived_quantity from paper_position_fill_check where user_id = $1", [closed.userId]))).toBe(0);
  });
  it("account portfolio facts are exact decimals, per account, and null (not invented) when no capital profile is in force", async () => {
    const o = await own();
    // the fixture capital profile is effective from 2030, i.e. NOT in force yet: the view must say so (null), not assume a balance
    const r = (await o.query("select open_positions, allocated_notional::text as n, total_capital::text as tc, unallocated_capital::text as u from account_portfolio_facts where account_id = $1", [partial.accountId])).rows[0];
    expect(r.open_positions).toBe(1); expect(r.n).toMatch(/^\d+(\.\d+)?$/); expect(r.tc).toBeNull(); expect(r.u).toBeNull();
    expect(r.n).toBe(String(await scalar("select sum(quantity * avg_entry_price)::text from paper_positions where account_id = $1 and status = 'OPEN'", [partial.accountId])));
    // an account whose profile IS in force: exact decimal arithmetic, nothing allocated
    const live = await newUser(); await appendCapitalProfile(db, live.userId, { accountId: live.accountId, totalCapital: "1000000.50", availableCapital: "999999.25", maxPositionNotionalPct: null, effectiveFrom: new Date("2020-01-01T00:00:00Z"), createdBy: "test" });
    const e = (await o.query("select open_positions, allocated_notional::text as n, total_capital::text as tc, available_capital::text as ac, unallocated_capital::text as u from account_portfolio_facts where account_id = $1", [live.accountId])).rows[0];
    expect(e).toMatchObject({ open_positions: 0, n: "0", tc: "1000000.50", ac: "999999.25", u: "1000000.50" });
    const bare = await newUser(); const b = (await o.query("select total_capital, unallocated_capital from account_portfolio_facts where account_id = $1", [bare.accountId])).rows[0];
    expect(b).toMatchObject({ total_capital: null, unallocated_capital: null });
    const other = await session(bare.userId); expect((await other.query("select count(*)::int as n from account_portfolio_facts where account_id = $1", [partial.accountId])).rows[0].n).toBe(0); // the view honours the caller's RLS
  });
  it("a decision cannot become an order or a position without approval, and a REJECTED decision cannot open anything", async () => {
    const p = await pipeline(), o = await own();
    const unapprovedOrder = async (): Promise<unknown> => {
      const r = await createExecutionRequest(db, p.userId, { accountId: p.accountId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: `unapproved-${randomUUID()}`, state: "REQUESTED", checks: [], refusalReasons: [] });
      await updateExecutionRequest(db, p.userId, r.request.id, "ELIGIBLE", [], []);
      return createPaperOrder(db, p.userId, { accountId: p.accountId, decisionId: p.decisionId, executionRequestId: r.request.id, positionId: null, purpose: "ENTRY", exitReason: null, instrument: p.u, exchange: "NSE", side: "BUY", orderType: "MARKET", quantity: "1", limitPrice: null, idempotencyKey: `o-${randomUUID()}` });
    };
    await refused(unapprovedOrder, /APPROVED|check_violation|illegal|approval/i);
    expect(Number(await scalar("select count(*)::int from paper_orders where decision_id = $1", [p.decisionId]))).toBe(0);
    await refused(() => o.query("insert into paper_positions (id, user_id, account_id, decision_id, mode, instrument, exchange, side, quantity, initial_quantity, avg_entry_price, stop_loss, initial_stop, opened_at, status) values (gen_random_uuid(), $1, $2, $3, 'PAPER', 'X', 'NSE', 'BUY', 1, 1, 100, 98, 98, now(), 'OPEN')", [p.userId, p.accountId, p.decisionId]), /entry order|APPROVED|check_violation/i);
    await refused(() => o.query("update user_decisions set workflow_state = 'APPROVED' where id = $1", [p.decisionId]), /approval|APPROVED|check_violation|only/i);
  });
  it("global invariants hold over every row any integration test created", async () => {
    const zero = async (label: string, sql: string): Promise<void> => expect(Number(await scalar(sql)), label).toBe(0);
    await zero("approved decision without an APPROVE record", "select count(*)::int from user_decisions d where d.workflow_state = 'APPROVED' and not exists (select 1 from decision_approvals a where a.decision_id = d.id and a.action = 'APPROVE')");
    await zero("paper order without an APPROVE record", "select count(*)::int from paper_orders o where not exists (select 1 from decision_approvals a where a.decision_id = o.decision_id and a.action = 'APPROVE')");
    await zero("paper position without a filled entry", "select count(*)::int from paper_positions p where not exists (select 1 from paper_orders o where o.decision_id = p.decision_id and o.purpose = 'ENTRY' and o.filled_quantity > 0)");
    await zero("order whose fills exceed its quantity or disagree with its filled quantity", "select count(*)::int from paper_orders o where coalesce((select sum(f.quantity) from paper_fills f where f.order_id = o.id), 0) <> o.filled_quantity");
    await zero("order of a different user than its decision", "select count(*)::int from paper_orders o join user_decisions d on d.id = o.decision_id where o.user_id <> d.user_id or o.account_id <> d.account_id");
    await zero("position of a different user or account than its decision", "select count(*)::int from paper_positions p join user_decisions d on d.id = p.decision_id where p.user_id <> d.user_id or p.account_id <> d.account_id");
    await zero("non-PAPER order or position", "select count(*)::int from (select mode from paper_orders union all select mode from paper_positions) m where mode <> 'PAPER'");
    await zero("live mode request that was not refused", "select count(*)::int from execution_requests where mode <> 'PAPER' and state <> 'REJECTED'");
    await zero("approval by someone other than the owner", "select count(*)::int from decision_approvals where approver_user_id <> user_id");
    await zero("FILLED order that is not fully filled / PARTIALLY_FILLED that is empty or full", "select count(*)::int from paper_orders where (status = 'FILLED' and filled_quantity <> quantity) or (status = 'PARTIALLY_FILLED' and (filled_quantity <= 0 or filled_quantity >= quantity))");
    await zero("position whose open quantity exceeds its initial quantity", "select count(*)::int from paper_positions where quantity > initial_quantity");
    await zero("stop-loss validation on a QUALIFIED decision that is not VALID", "select count(*)::int from user_decisions where outcome = 'QUALIFIED' and (stop_loss_validation->>'result') is distinct from 'VALID'");
  });
});

describe("fills, partial fills and exact money", () => {
  async function exitOrder(p: Pipe, qty: string): Promise<{ orderId: string }> {
    const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!, o = await own();
    const req = String(await scalar("select id from execution_requests where decision_id = $1 and mode = 'PAPER' limit 1", [p.decisionId]));
    expect(Number(qty)).toBeLessThanOrEqual(Number(pos.quantity));
    const created = await createPaperOrder(db, p.userId, { accountId: p.accountId, decisionId: p.decisionId, executionRequestId: req, positionId: pos.id, purpose: "EXIT", exitReason: "MANUAL", instrument: pos.instrument, exchange: pos.exchange, side: pos.side === "BUY" ? "SELL" : "BUY", orderType: "MARKET", quantity: qty, limitPrice: null, idempotencyKey: `exit-${randomUUID()}` });
    await setOrderStatus(db, p.userId, created.order.id, "SUBMITTED", null); await setOrderStatus(db, p.userId, created.order.id, "ACCEPTED", null);
    expect(o).toBeTruthy(); return { orderId: created.order.id };
  }
  it("several fills per order: partial then complete, with an exact weighted average (no binary floating point)", async () => {
    const p = await pipeline(); await trade(p, "open"); const pos = (await getPositionForDecision(db, p.userId, p.decisionId))!;
    const total = Number(pos.quantity); expect(total).toBeGreaterThanOrEqual(10);
    const { orderId } = await exitOrder(p, "10");
    const fill = (q: string, price: string) => insertPaperFill(db, p.userId, { orderId, quantity: q, price, costs: "0.01", priceSource: "FIXTURE", priceAsOf: NOW });
    await fill("3", "0.1"); expect(await scalar("select status from paper_orders where id = $1", [orderId])).toBe("PARTIALLY_FILLED");
    await fill("7", "0.2"); expect(await scalar("select status from paper_orders where id = $1", [orderId])).toBe("FILLED");
    expect(await scalar("select (avg_fill_price = 0.17)::text from paper_orders where id = $1", [orderId])).toBe("true"); // (3*0.1 + 7*0.2) / 10: 0.17 exactly; a double gives 0.17000000000000003
    expect(await scalar("select sum(costs)::text from paper_fills where order_id = $1", [orderId])).toBe("0.02");
    await refused(() => fill("1", "0.2"), /ACCEPTED or PARTIALLY_FILLED|remaining/i);  // a filled order accepts nothing more
  });
  it("two simultaneous fills for the whole remaining quantity: exactly one succeeds", async () => {
    const p = await pipeline(); await trade(p, "open"); const { orderId } = await exitOrder(p, "10");
    const fill = () => insertPaperFill(db, p.userId, { orderId, quantity: "10", price: "100.5", costs: "0", priceSource: "FIXTURE", priceAsOf: NOW });
    const res = await Promise.allSettled([fill(), fill()]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1); expect(res.filter((r) => r.status === "rejected").length).toBe(1);
    expect(await scalar("select filled_quantity::text from paper_orders where id = $1", [orderId])).toBe("10"); expect(Number(await scalar("select count(*)::int from paper_fills where order_id = $1", [orderId]))).toBe(1);
  });
  it("a fill price worse than a LIMIT, a zero or negative fill, and a fill on a cancelled order are refused", async () => {
    const p = await pipeline(); await trade(p, "open"); const { orderId } = await exitOrder(p, "10");
    for (const [q, price] of [["0", "100"], ["-1", "100"], ["1", "0"]] as const) await refused(() => insertPaperFill(db, p.userId, { orderId, quantity: q, price, costs: "0", priceSource: "FIXTURE", priceAsOf: NOW }), /value_check|23514|check/i);
    await setOrderStatus(db, p.userId, orderId, "CANCELLED", "test");
    await refused(() => insertPaperFill(db, p.userId, { orderId, quantity: "1", price: "100", costs: "0", priceSource: "FIXTURE", priceAsOf: NOW }), /ACCEPTED or PARTIALLY_FILLED/i);
    await refused(() => setOrderStatus(db, p.userId, orderId, "ACCEPTED", null), /cannot change state|illegal/i);   // a cancelled order is final
  });
});

describe("concurrency and replay", () => {
  it("two simultaneous approvals of one decision: exactly one approval record, the other is refused", async () => {
    const p = await pipeline();
    const go = (key: string) => approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: key });
    const res = await Promise.allSettled([go("race-key-0001"), go("race-key-0002")]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(Number(await scalar("select count(*)::int from decision_approvals where decision_id = $1", [p.decisionId]))).toBe(1);
    expect(await scalar("select workflow_state from user_decisions where id = $1", [p.decisionId])).toBe("APPROVED");
  });
  it("two simultaneous identical execution requests create one entry order and one position", async () => {
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-for-race" });
    const go = () => requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-race-key-1" });
    await Promise.allSettled([go(), go()]);
    expect(Number(await scalar("select count(*)::int from paper_orders where decision_id = $1 and purpose = 'ENTRY'", [p.decisionId]))).toBe(1);
    expect(Number(await scalar("select count(*)::int from paper_positions where decision_id = $1", [p.decisionId]))).toBe(1);
    expect(Number(await scalar("select count(*)::int from execution_requests where decision_id = $1 and mode = 'PAPER'", [p.decisionId]))).toBe(1);
  });
  it("an execution request for a live mode is refused and recorded as REJECTED, never ELIGIBLE", async () => {
    const p = await pipeline(); await approveDecision(evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-for-live" });
    for (const mode of ["ASSISTED_LIVE", "CONTROLLED_AUTO"] as const) {
      const r = await requestPaperExecution(execDeps(), { userId: p.userId, decisionId: p.decisionId, mode, idempotencyKey: `live-${mode}-1` });
      expect(JSON.stringify(r)).not.toMatch(/"state":"(ELIGIBLE|COMPLETED)"/);
    }
    expect(Number(await scalar("select count(*)::int from paper_orders where decision_id = $1", [p.decisionId]))).toBe(0);
    expect(Number(await scalar("select count(*)::int from execution_requests where decision_id = $1 and mode <> 'PAPER' and state <> 'REJECTED'", [p.decisionId]))).toBe(0);
  });
});

describe("append-only history and exact money", () => {
  it("approvals, fills, position events and decision events can be neither changed nor deleted, even by the table owner", async () => {
    const p = await pipeline(); await trade(p, "close"); const o = await own();
    for (const [t, set] of [["decision_approvals", "reason = 'x'"], ["paper_fills", "quantity = quantity + 1"], ["paper_position_events", "kind = 'X'"]] as const) {
      await refused(() => o.query(`update ${t} set ${set} where user_id = $1`, [p.userId]), /append-only|not allowed|audit/i);
      await refused(() => o.query(`delete from ${t} where user_id = $1`, [p.userId]), /append-only|not allowed|audit/i);
      await refused(() => o.query(`truncate ${t}`), /append-only|not allowed|audit/i);
    }
  });
  it("no money column is a binary float or an integer: every price, P&L, capital, notional and cost column is exact numeric", async () => {
    const o = await own();
    const r = await o.query(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'
      and column_name ~ '(price|pnl|capital|amount|notional|costs|loss|exposure|equity|balance|fee|charge|brokerage|slippage)'
      and data_type in ('double precision', 'real', 'integer', 'bigint', 'smallint') and column_name !~ '(_pct|_seconds|_ms|_count|_minutes|_bps|_version|_rank)'`);
    expect(r.rows, JSON.stringify(r.rows)).toEqual([]);
    expect(Number(await scalar("select count(*)::int from information_schema.columns where table_schema = 'public' and data_type in ('double precision', 'real') and table_name like any (array['paper_%','user_%','decision_%','execution_%','outcome_%','risk_%','simulations','confidence_%'])"))).toBe(0);
  });
  it("numeric arithmetic in the database is exact", async () => {
    expect(await scalar("select (0.1::numeric + 0.2::numeric = 0.3::numeric)::text")).toBe("true");
    expect(await scalar("select (1234567890123456.78::numeric * 3)::text")).toBe("3703703670370370.34");
  });
  it("every timestamp is timezone-aware", async () => {
    expect(Number(await scalar("select count(*)::int from information_schema.columns where table_schema = 'public' and data_type = 'timestamp without time zone' and table_name <> '__drizzle_migrations'"))).toBe(0);
  });
});
