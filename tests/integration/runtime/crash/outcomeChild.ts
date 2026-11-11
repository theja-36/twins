/**
 * Dedicated child worker process for the outcome crash/recovery test (Stage 08 A1, G-49). It runs the REAL worker functions against the guarded twins_ci database: the execution cycle `advanceOpenOrders` (which closes a position
 * and writes its trade outcome) and the learning cycle `runLearningCycle` (which attributes it). The only seam is a pass-through database wrapper (tests/support/crashHold.ts) that holds the process at a chosen STATEMENT:
 *
 *   --mode=close-before-commit      held right after the trade-outcome insert, INSIDE the still-open close transaction (position update, event and outcome are uncommitted);
 *   --mode=close-after-commit       held right after that close transaction COMMITTED;
 *   --mode=attribute-before-commit  held right after the attribution insert, inside its still-open transaction;
 *   --mode=attribute-after-commit   held right after the attribution transaction COMMITTED;
 *   --mode=exec-recover             a restarted execution worker: one cycle, report over IPC, exit;
 *   --mode=learn-recover            a restarted learning worker: one cycle (its clock is ahead of any lapsed lease), report, exit.
 * The cycle is restricted to --user so it can never touch another test's data. Guarded like the other crash children: refuses anything but the loopback twins_ci database. Synthetic data only; nothing here can reach a broker.
 */
import { advanceOpenOrders } from "../../../../packages/execution/src/index";
import { createDb } from "../../../../packages/database/src/index";
import { DEFAULT_OUTCOME_LEARNING, runLearningCycle } from "../../../../packages/outcomes/src/index";
import { holdAtStatement, sqlText } from "../../../support/crashHold";
import { makeFixtures, pricesFor } from "../../../support/executionFixtures";

const arg = (name: string): string => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); if (!hit) throw new Error(`missing --${name}=...`); return hit.slice(name.length + 3); };
function assertSafeTarget(): void {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://missing"), loop = new Set(["127.0.0.1", "localhost"]);
  if (process.env.TWINS_CI !== "1" || process.env.LIVE_TRADING !== "false") throw new Error("unsafe environment (need TWINS_CI=1, LIVE_TRADING=false)");
  if (!loop.has(db.hostname) || db.pathname !== "/twins_ci" || decodeURIComponent(db.username) !== "twins_ci") throw new Error("refusing: DATABASE_URL is not the twins_ci test target");
}
/** The execution cycle iterates every active account; this keeps it on the one user under test. */
function onlyUser<T extends object>(db: T, userId: string): T {
  return new Proxy(db, { get(target, prop) {
    const v = Reflect.get(target, prop, target) as unknown;
    if (prop === "execute" && typeof v === "function") return async (q: unknown, ...r: unknown[]) => { const res = (await (v as (...x: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>).call(target, q, ...r)); return sqlText(q).includes("twins_list_active_accounts") ? { ...res, rows: res.rows.filter((x) => x["a_user_id"] === userId) } : res; };
    return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
  } }) as T;
}
async function main(): Promise<void> {
  assertSafeTarget();
  const mode = arg("mode"), userId = arg("user"), underlying = arg("underlying");
  const held = (): void => { process.send?.({ type: "checkpoint", pid: process.pid, mode }); };
  let db: ReturnType<typeof createDb> = createDb(process.env.DATABASE_URL as string);
  const close = mode.match(/^close-(before|after)-commit$/), attribute = mode.match(/^attribute-(before|after)-commit$/);
  if (close) db = holdAtStatement(db, { match: /insert into trade_outcomes/, when: close[1] === "before" ? "before-commit" : "after-commit", onHeld: held });
  if (attribute) db = holdAtStatement(db, { match: /insert into outcome_attributions/, when: attribute[1] === "before" ? "before-commit" : "after-commit", onHeld: held });
  process.send?.({ type: "ready", pid: process.pid });
  if (mode.startsWith("close-") || mode === "exec-recover") {
    const fx = makeFixtures(onlyUser(db, userId)); fx.instruments.push({ ...fx.spec, underlying });
    const report = await advanceOpenOrders(fx.execDeps(pricesFor(underlying), { orderTtlMinutes: 1e9 }));
    process.send?.({ type: "done", pid: process.pid, report }, () => process.exit(0));
  } else {
    // a restarted learning worker runs hours after the dead one: its clock is past the dead run's lease, so that run is marked ABANDONED and a new one starts
    const now = mode === "learn-recover" ? new Date(Date.now() + 2 * 3600_000) : new Date();
    const report = await runLearningCycle({ db, config: { ...DEFAULT_OUTCOME_LEARNING, enabled: true }, only: [userId], now: () => now });
    process.send?.({ type: "done", pid: process.pid, report }, () => process.exit(0));
  }
}
main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(2); });
