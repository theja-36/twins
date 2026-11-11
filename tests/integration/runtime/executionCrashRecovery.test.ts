/**
 * REAL process crash/recovery test for paper execution (G-47): abrupt SIGKILL of a dedicated child worker between a COMMITTED order fill and the position update.
 *
 * GATED like the other crash tests: runs only with TWINS_CRASH_TEST=1 (plus the guarded twins_ci environment). It terminates ONLY the child pid this test spawned (the pid the child itself reported over IPC, checked against the
 * Node ChildProcess handle) and never touches PostgreSQL, Redis or any other process.
 *
 * The critical sequence, with the real worker cycle (`advanceOpenOrders`) in real child processes:
 *   1. an approved decision has an ACCEPTED entry order that has not filled (no price yet);
 *   2. the child's cycle reads a price and the fill transaction COMMITS in PostgreSQL; the child is held there and the parent verifies in the database that the fill exists and the position does NOT;
 *   3. the parent SIGKILLs the child;
 *   4. a NEW worker process starts: its cycle detects the committed fill and applies the missing position update, exactly once (one position, one OPENED event, the request completed);
 *   5. nothing financial is created twice: the same single fill row, the same quantity, price and costs; a further restart and a retried execution request change nothing.
 * A second case restarts TWO workers at the same moment: still one position and one opening event.
 */
import { fork, type ChildProcess } from "node:child_process";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { approveDecision } from "../../../packages/decision/src/index";
import { createDb, getDecision } from "../../../packages/database/src/index";
import { reconcilePosition, requestPaperExecution } from "../../../packages/execution/src/index";
import { makeFixtures, pricesFor } from "../../support/executionFixtures";
import { DATABASE_URL, waitFor } from "./harness";

const enabled = process.env.TWINS_CRASH_TEST === "1" && process.env.TWINS_CI === "1";
const CHILD = new URL("./crash/executionChild.ts", import.meta.url).pathname;
const db = createDb(DATABASE_URL), fx = makeFixtures(db), clients: pg.Client[] = [], procs: ChildProcess[] = [];
let ownerClient: pg.Client | null = null;
async function owner(): Promise<pg.Client> { if (!ownerClient) { ownerClient = new pg.Client({ connectionString: DATABASE_URL }); await ownerClient.connect(); clients.push(ownerClient); } return ownerClient; }
afterAll(async () => { for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); await Promise.all(clients.map((c) => c.end().catch(() => undefined))); }); // only children this test spawned

interface Child { proc: ChildProcess; ipc: Array<Record<string, unknown>>; exited: Promise<void> }
function spawn(mode: "crash" | "recover", underlying: string): Child {
  const proc = fork(CHILD, [`--mode=${mode}`, `--underlying=${underlying}`], { execArgv: ["--import", "tsx"], silent: true, env: { ...process.env, NODE_ENV: "test", LIVE_TRADING: "false", TWINS_CI: "1" } });
  procs.push(proc);
  const child: Child = { proc, ipc: [], exited: new Promise<void>((resolve) => { if (proc.exitCode !== null || proc.signalCode) resolve(); else proc.once("exit", () => resolve()); }) };
  proc.on("message", (m) => child.ipc.push(m as Record<string, unknown>));
  let err = ""; proc.stderr?.on("data", (d: Buffer) => { err += d.toString("utf8"); });
  proc.on("exit", (code, signal) => { if (code !== 0 && signal === null && err) process.stderr.write(`[execution child ${mode}] exit ${code}: ${err}\n`); });
  return child;
}
const ipc = (c: Child, type: string, ms = 60_000) => waitFor(async () => c.ipc.find((m) => m["type"] === type), ms, `child IPC '${type}'`);

/** Everything a duplicate could touch, read straight from PostgreSQL as the owner. */
async function snapshot(decisionId: string) {
  const c = await owner();
  const q = async (text: string) => (await c.query(text, [decisionId])).rows;
  return {
    fills: await q("select f.id, f.order_id, f.quantity::text as quantity, f.price::text as price, f.costs::text as costs from paper_fills f join paper_orders o on o.id = f.order_id where o.decision_id = $1 order by f.id"),
    orders: await q("select id, purpose, status, quantity::text as quantity, filled_quantity::text as filled_quantity from paper_orders where decision_id = $1 order by id"),
    positions: await q("select id, status, quantity::text as quantity, initial_quantity::text as initial_quantity, avg_entry_price::text as avg_entry_price, realized_pnl::text as realized_pnl from paper_positions where decision_id = $1"),
    positionEvents: await q("select e.kind, count(*)::int as n from paper_position_events e join paper_positions p on p.id = e.position_id where p.decision_id = $1 group by e.kind order by e.kind"),
    monitoring: await q("select kind, count(*)::int as n from trade_monitoring_events where decision_id = $1 group by kind order by kind"),
    request: await q("select state from execution_requests where decision_id = $1 and mode = 'PAPER'"),
  };
}
const sum = (rows: Array<{ quantity: string }>): number => rows.reduce((a, r) => a + Number(r.quantity), 0);

/** An approved decision with an ACCEPTED, unfilled entry order. */
async function arrange() {
  const c = await owner();
  const p = await fx.pipeline(async (text, params) => c.query(text, params as unknown[]));
  expect(p.outcome).toBe("QUALIFIED");
  await approveDecision(fx.evalDeps(), { userId: p.userId, decisionId: p.decisionId, idempotencyKey: "approve-key-0001" });
  const qty = (await getDecision(db, p.userId, p.decisionId))!.permittedSize!.quantity;
  const first = await requestPaperExecution(fx.execDeps(pricesFor(p.u, () => false)), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
  expect(first.status).toBe("ORDER_OPEN"); // no price: the order waits
  const before = await snapshot(p.decisionId);
  expect(before.fills).toHaveLength(0); expect(before.positions).toHaveLength(0); expect(before.request).toEqual([{ state: "ELIGIBLE" }]);
  return { p, qty };
}
/** Crash a worker right after the fill commit; verify in PostgreSQL that the fill is committed and the position is not; SIGKILL it. */
async function crashAfterFill(p: { u: string; decisionId: string }, qty: number) {
  const child = spawn("crash", p.u);
  await ipc(child, "ready");
  const cp = (await ipc(child, "checkpoint")) as { pid: number };
  expect(cp.pid).toBe(child.proc.pid); // the process that reported the checkpoint is the child this test spawned
  const mid = await snapshot(p.decisionId);
  expect(mid.fills).toHaveLength(1); expect(sum(mid.fills)).toBe(qty); // the fill IS committed ...
  expect(mid.orders).toMatchObject([{ purpose: "ENTRY", status: "FILLED" }]);
  expect(mid.positions).toHaveLength(0); // ... and the position write never started
  expect(mid.request).toEqual([{ state: "ELIGIBLE" }]); // the request is not completed
  child.proc.kill("SIGKILL"); await child.exited;
  expect(child.proc.signalCode).toBe("SIGKILL");
  expect(await snapshot(p.decisionId)).toEqual(mid); // the dead process changed nothing further
  return mid;
}

describe.skipIf(!enabled)("paper execution crash and recovery (real SIGKILL, guarded twins_ci)", () => {
  it("SIGKILL after the fill commit and before the position update: a restarted worker applies the missing position update exactly once, and nothing is duplicated", async () => {
    const { p, qty } = await arrange();
    const crashed = await crashAfterFill(p, qty);

    // the worker restarts: its cycle finds the committed fill and repairs the follow-up
    const w1 = spawn("recover", p.u); const done1 = (await ipc(w1, "done")) as { report: { healed: number } }; await w1.exited;
    expect(done1.report.healed).toBe(1);
    const healed = await snapshot(p.decisionId);
    expect(healed.fills).toEqual(crashed.fills); // the very same single fill row: no second fill, same id, quantity, price and costs
    expect(healed.orders).toEqual(crashed.orders);
    expect(healed.positions).toHaveLength(1);
    const pos = healed.positions[0] as { id: string; status: string; quantity: string; initial_quantity: string; avg_entry_price: string; realized_pnl: string };
    expect(pos.status).toBe("OPEN");
    expect(Number(pos.quantity)).toBe(qty); // exactly the filled quantity, not zero and not doubled
    expect(Number(pos.initial_quantity)).toBe(qty);
    expect(Number(pos.avg_entry_price)).toBe(Number((crashed.fills[0] as { price: string }).price)); // average entry = the one fill's price
    expect(Number(pos.realized_pnl)).toBe(0);
    expect(healed.positionEvents).toEqual([{ kind: "OPENED", n: 1 }]); // opened once
    expect(healed.monitoring).toEqual([{ kind: "ENTRY_FILLED", n: 1 }]);
    expect(healed.request).toEqual([{ state: "COMPLETED" }]);

    // a second restart and a retried execution request (same key) are no-ops
    const w2 = spawn("recover", p.u); const done2 = (await ipc(w2, "done")) as { report: { healed: number } }; await w2.exited;
    expect(done2.report.healed).toBe(0);
    const retried = await requestPaperExecution(fx.execDeps(pricesFor(p.u)), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(retried).toMatchObject({ status: "FILLED", duplicate: true });
    expect(await snapshot(p.decisionId)).toEqual(healed);
    // finally the position is reconciled against its fills (this records a RECONCILED event itself, so it is done after the comparison above)
    expect((await reconcilePosition(fx.execDeps(pricesFor(p.u)), p.userId, pos.id))?.ok).toBe(true);
    expect((await snapshot(p.decisionId)).positionEvents).toEqual([{ kind: "OPENED", n: 1 }, { kind: "RECONCILED", n: 1 }]);
  }, 180_000);

  it("a retried execution request after the crash repairs the follow-up too (it neither executes again nor re-validates the filled entry)", async () => {
    const { p, qty } = await arrange();
    const crashed = await crashAfterFill(p, qty);
    const retried = await requestPaperExecution(fx.execDeps(pricesFor(p.u)), { userId: p.userId, decisionId: p.decisionId, mode: "PAPER", idempotencyKey: "exec-key-00001" });
    expect(retried).toMatchObject({ status: "FILLED", duplicate: true });
    const healed = await snapshot(p.decisionId);
    expect(healed.fills).toEqual(crashed.fills); expect(healed.orders).toEqual(crashed.orders);
    expect(healed.positions).toHaveLength(1); expect(Number((healed.positions[0] as { quantity: string }).quantity)).toBe(qty);
    expect(healed.positionEvents).toEqual([{ kind: "OPENED", n: 1 }]); expect(healed.request).toEqual([{ state: "COMPLETED" }]);
    // and a restarted worker then finds nothing left to repair
    const w = spawn("recover", p.u); expect(((await ipc(w, "done")) as { report: { healed: number } }).report.healed).toBe(0); await w.exited;
    expect(await snapshot(p.decisionId)).toEqual(healed);
  }, 180_000);

  it("two workers restart at the same moment: one position, one opening event, the same single fill", async () => {
    const { p, qty } = await arrange();
    const crashed = await crashAfterFill(p, qty);
    const a = spawn("recover", p.u), b = spawn("recover", p.u);
    await Promise.all([ipc(a, "done"), ipc(b, "done")]); await Promise.all([a.exited, b.exited]);
    expect(a.proc.exitCode).toBe(0); expect(b.proc.exitCode).toBe(0);
    const healed = await snapshot(p.decisionId);
    expect(healed.fills).toEqual(crashed.fills);
    expect(healed.positions).toHaveLength(1); expect(Number((healed.positions[0] as { quantity: string }).quantity)).toBe(qty);
    expect(healed.positionEvents).toEqual([{ kind: "OPENED", n: 1 }]);
    expect(healed.monitoring).toEqual([{ kind: "ENTRY_FILLED", n: 1 }]);
    expect(healed.request).toEqual([{ state: "COMPLETED" }]);
  }, 180_000);
});
