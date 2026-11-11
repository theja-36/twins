/**
 * Dedicated child worker process for the execution crash/recovery test (G-47). It runs the REAL worker cycle, `advanceOpenOrders` (the function the worker calls on every management tick), against the guarded twins_ci database,
 * with the REAL database stores and the REAL fill / position code. The only test seam is a pass-through wrapper around `db.transaction`:
 *
 *   --mode=crash    after this process asks for the price of --underlying (which happens immediately before the fill is written), the NEXT database transaction is the fill insert. When that transaction has COMMITTED, the process reports
 *                   the checkpoint over IPC and blocks forever, so the parent can SIGKILL this exact pid. `syncPosition` (the position write) has not started: the fill is committed and the position is not.
 *   --mode=recover  a plain restarted worker: one `advanceOpenOrders` cycle, then reports the cycle's report over IPC and exits.
 *
 * Only --underlying's price is ever available (every other symbol has none), so the cycle can never touch another test's orders. Guarded like the other crash children: refuses anything but the loopback twins_ci database.
 * Synthetic data only; nothing here can reach a broker.
 */
import { advanceOpenOrders } from "../../../../packages/execution/src/index";
import { createDb } from "../../../../packages/database/src/index";
import { holdAfterArmedTransaction } from "../../../support/crashHold";
import { makeFixtures, pricesFor } from "../../../support/executionFixtures";

const arg = (name: string): string => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); if (!hit) throw new Error(`missing --${name}=...`); return hit.slice(name.length + 3); };
function assertSafeTarget(): void {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://missing"), loop = new Set(["127.0.0.1", "localhost"]);
  if (process.env.TWINS_CI !== "1" || process.env.LIVE_TRADING !== "false") throw new Error("unsafe environment (need TWINS_CI=1, LIVE_TRADING=false)");
  if (!loop.has(db.hostname) || db.pathname !== "/twins_ci" || decodeURIComponent(db.username) !== "twins_ci") throw new Error("refusing: DATABASE_URL is not the twins_ci test target");
}

async function main(): Promise<void> {
  assertSafeTarget();
  const mode = arg("mode"), underlying = arg("underlying");
  const raw = createDb(process.env.DATABASE_URL as string);
  let armed = false;
  const db = mode === "crash" ? holdAfterArmedTransaction(raw, () => armed, () => process.send?.({ type: "checkpoint", pid: process.pid })) : raw;
  const fx = makeFixtures(db);
  fx.instruments.push({ ...fx.spec, underlying });
  // the fixtures' clock is in 2031 while orders are stamped with the real time, so the order time-to-live must not elapse (as in the Stage 07 integration test)
  const deps = fx.execDeps(pricesFor(underlying, () => true, () => { if (mode === "crash") armed = true; }), { orderTtlMinutes: 1e9 });
  process.send?.({ type: "ready", pid: process.pid });
  const report = await advanceOpenOrders(deps);
  process.send?.({ type: "done", pid: process.pid, report }, () => process.exit(0));
}
main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(2); });
