/**
 * Stage 08 A1 (G-49) against REAL PostgreSQL: every successfully CLOSED paper position ends with exactly ONE trade outcome and exactly ONE FINAL attribution, however the workers crash, restart, repeat or race.
 * (The real-SIGKILL cases are in tests/integration/runtime/outcomeCrashRecovery.test.ts.) Synthetic data, FIXTURE prices, Monday 10:30 IST in 2031. The connection is a superuser (it bypasses row-level security, not triggers or constraints).
 */
import { afterAll, describe, expect, it } from "vitest";
import { advanceOpenOrders, syncPosition } from "../../../packages/execution/src/index";
import { ingestOutcomes } from "../../../packages/outcomes/src/index";
import { recordPaperOutcome } from "../../../packages/database/src/index";
import { NOW } from "../../support/executionFixtures";
import { makeOutcomeHarness } from "../../support/outcomeHarness";
import { requireTestDatabaseUrl } from "../targetConfig";

const { db, close, learn, counts, unsyncedClose, closedWithoutOutcome } = makeOutcomeHarness(requireTestDatabaseUrl());
afterAll(close);

describe("A1 (G-49): a closed position always ends with exactly one trade outcome and one FINAL attribution", () => {
  it("the database refuses a second trade outcome for the same position, however the writers race", async () => {
    const a = await closedWithoutOutcome();
    const o = { accountId: a.accountId, decisionId: a.decisionId, positionId: a.pos.id, instrument: a.cand.underlying, side: "BUY" as const, quantity: String(a.qty), entryPrice: "100.05", exitPrice: "101", pnl: "100.00", rMultiple: "0.5", exitReason: "TARGET_HIT", openedAt: new Date("2030-01-06T05:00:00Z"), closedAt: NOW };
    await Promise.all([recordPaperOutcome(db, a.userId, o), recordPaperOutcome(db, a.userId, o), recordPaperOutcome(db, a.userId, o)]);
    expect((await counts(a.decisionId, a.pos.id)).outcomes).toBe(1);
  });

  it("a CLOSED position whose outcome was never written (crash between close and outcome) is repaired by the worker sweep, then attributed FINAL exactly once", async () => {
    const a = await closedWithoutOutcome();
    expect(await counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 0, final: 0 });
    await learn(a.userId); // before the repair the position can only be PARTIAL
    expect((await counts(a.decisionId, a.pos.id)).final).toBe(0);
    const swept = await advanceOpenOrders(a.deps);
    expect(swept.healed).toBeGreaterThanOrEqual(1);
    expect((await counts(a.decisionId, a.pos.id)).outcomes).toBe(1);
    await learn(a.userId);
    const c1 = await counts(a.decisionId, a.pos.id);
    expect(c1).toMatchObject({ status: "CLOSED", outcomes: 1, final: 1 });
    // repeating everything changes nothing
    await advanceOpenOrders(a.deps); await learn(a.userId); await syncPosition(a.deps, { userId: a.userId, decision: a.dec0, rules: a.rules });
    expect(await counts(a.decisionId, a.pos.id)).toEqual(c1);
  }, 120_000);

  it("the normal close writes the position close and its trade outcome together: six concurrent closers leave one CLOSED event and one outcome, then one FINAL attribution", async () => {
    const a = await unsyncedClose();
    await Promise.all(Array.from({ length: 6 }, () => syncPosition(a.deps, { userId: a.userId, decision: a.dec0, rules: a.rules })));
    expect(await counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 1, closedEvents: 1, final: 0, fills: 2 });
    await learn(a.userId);
    expect(await counts(a.decisionId, a.pos.id)).toMatchObject({ outcomes: 1, final: 1, attributions: 1, closedEvents: 1 });
  }, 120_000);

  it("concurrent attribution workers on one closed position create exactly one FINAL version (the unique version index, not luck)", async () => {
    const a = await closedWithoutOutcome();
    await advanceOpenOrders(a.deps); // the outcome is repaired first
    const runs = await Promise.all(Array.from({ length: 5 }, () => ingestOutcomes(db, a.userId, 200)));
    expect(runs.reduce((n, r) => n + r.final, 0)).toBe(1); // exactly one worker wrote it; the others saw a duplicate or nothing to do
    expect(await counts(a.decisionId, a.pos.id)).toMatchObject({ outcomes: 1, final: 1, attributions: 1 });
  }, 120_000);
});
