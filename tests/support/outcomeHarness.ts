/**
 * Helpers shared by the Stage 08 A1 tests (in-process and real-SIGKILL): a database handle, the execution fixtures, an owner connection for raw reads, and the counts that define "exactly one outcome and one FINAL attribution".
 * Synthetic data only. The connection is a superuser (it bypasses row-level security, not triggers or constraints).
 */
import pg from "pg";
import { createDb, updatePositionExit } from "../../packages/database/src/index";
import { DEFAULT_OUTCOME_LEARNING, runLearningCycle } from "../../packages/outcomes/src/index";
import { makeFixtures, NOW } from "./executionFixtures";

export function makeOutcomeHarness(url: string) {
  const db = createDb(url), fx = makeFixtures(db), clients: pg.Client[] = [];
  let ownerClient: pg.Client | null = null;
  const owner = async (): Promise<pg.Client> => { if (!ownerClient) { ownerClient = new pg.Client({ connectionString: url }); await ownerClient.connect(); clients.push(ownerClient); } return ownerClient; };
  const close = async (): Promise<void> => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); };
  const learn = (userId: string, o: { now?: Date } = {}) => runLearningCycle({ db, config: { ...DEFAULT_OUTCOME_LEARNING, enabled: true }, only: [userId], now: () => o.now ?? NOW });
  const counts = async (decisionId: string, positionId: string) => {
    const c = await owner(), one = async (text: string) => (await c.query(text, [positionId])).rows[0].n as number;
    return {
      outcomes: await one("select count(*)::int as n from trade_outcomes where paper_position_id = $1"),
      final: await one("select count(*)::int as n from outcome_attributions where paper_position_id = $1 and finality = 'FINAL'"),
      attributions: await one("select count(*)::int as n from outcome_attributions where paper_position_id = $1"),
      closedEvents: await one("select count(*)::int as n from paper_position_events where position_id = $1 and kind = 'CLOSED'"),
      status: (await c.query("select status from paper_positions where id = $1", [positionId])).rows[0].status as string,
      fills: (await c.query("select count(*)::int as n from paper_fills f join paper_orders o on o.id = f.order_id where o.decision_id = $1", [decisionId])).rows[0].n as number,
    };
  };
  /** An open position whose full EXIT fill is committed but not yet applied to the position (what a worker leaves when it dies after the fill). */
  const unsyncedClose = async () => { const c = await owner(), a = await fx.openPosition(async (t, p) => c.query(t, p as unknown[])); await fx.commitExitFill(a, a.qty, "101.00000000", `exit-1:${a.decisionId}`); return a; };
  /** A position closed the way the code did BEFORE the A1 fix after a crash: CLOSED, and no trade outcome was ever written. */
  const closedWithoutOutcome = async () => {
    const c = await owner(), a = await unsyncedClose();
    const entry = (await c.query("select sum(f.quantity*f.price)/sum(f.quantity) as avg, sum(f.costs) as costs from paper_fills f join paper_orders o on o.id = f.order_id where o.decision_id = $1 and o.purpose = 'ENTRY'", [a.decisionId])).rows[0];
    const gross = Math.floor(a.qty * (101 - Number(entry.avg)) * 100) / 100, costs = Math.ceil((Number(entry.costs) + 9) * 100) / 100;
    await updatePositionExit(db, a.userId, a.pos.id, { quantity: "0", realizedPnl: gross.toFixed(2), realizedCosts: costs.toFixed(2), close: { reason: "TARGET_HIT", at: NOW } });
    return a;
  };
  return { db, fx, owner, close, learn, counts, unsyncedClose, closedWithoutOutcome };
}
