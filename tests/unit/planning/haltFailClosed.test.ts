/**
 * Fail-closed behaviour of the planning cycle's halt step (risk-control hardening). The REAL runEvaluationCycle runs; only its database calls are stubbed so each failure can be injected exactly.
 * Policy: if the risk state cannot be read, or a required halt cannot be persisted, the account's candidates are NOT evaluated this cycle (no silent continue). One bounded retry for a transient failure; a configuration fault
 * (SQLSTATE 42501 or 42883: the runtime role cannot call the halt door) is not retried and is flagged for escalation. One account's failure never stops another's evaluation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ listActiveAccounts: vi.fn(), listActiveControls: vi.fn(), listCandidates: vi.fn(), getEffectiveRiskPolicy: vi.fn(), recordUserHalt: vi.fn() }));
const ev = vi.hoisted(() => ({ evaluateCandidateForAccount: vi.fn() }));
vi.mock("@twins/database", async (orig) => ({ ...(await orig<typeof import("@twins/database")>()), ...db })); // only the five functions the cycle calls are stubbed
vi.mock("../../../packages/planning/src/evaluate", () => ev);
import { DEFAULT_EVALUATION_CONFIG, runEvaluationCycle } from "../../../packages/planning/src/cycle";

const NOW = new Date("2031-01-06T05:00:00Z");
const A1 = { userId: "11111111-1111-4111-8111-111111111111", accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, A2 = { userId: "22222222-2222-4222-8222-222222222222", accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const policy = { maxDailyLoss: "1000", maxDrawdownPct: null };
const breached = { openPositions: [], realizedLossToday: "1500", equityCurve: null, asOf: NOW.toISOString() }, calm = { ...breached, realizedLossToday: "0" };
const portfolio = (state: unknown) => ({ name: "test", portfolioFor: async () => state as never });
const pgErr = (code: string): Error => Object.assign(new Error("db"), { code });
const run = (p: unknown, logs: Array<[string, Record<string, unknown>]> = []) => runEvaluationCycle({ db: {} as never, config: { ...DEFAULT_EVALUATION_CONFIG, enabled: true }, specs: null, regime: null, portfolio: portfolio(p) as never, quotes: null, strategy: null, now: () => NOW, log: (e, f) => void logs.push([e, f]) });

beforeEach(() => {
  for (const f of [...Object.values(db), ev.evaluateCandidateForAccount]) f.mockReset();
  db.listActiveAccounts.mockResolvedValue([A1]); db.listCandidates.mockResolvedValue([{ id: "c1" }]); db.getEffectiveRiskPolicy.mockResolvedValue(policy); db.listActiveControls.mockResolvedValue([]); db.recordUserHalt.mockResolvedValue("halt-1");
  ev.evaluateCandidateForAccount.mockResolvedValue({ status: "EVALUATED", verdict: "BLOCKED" });
});

describe("normal behaviour is unchanged", () => {
  it("a breached daily loss records the halt through the narrow door (kind, reason, next-day expiry) and then evaluates", async () => {
    const r = await run(breached); expect(db.recordUserHalt).toHaveBeenCalledTimes(1);
    const [, user, h] = db.recordUserHalt.mock.calls[0] as [unknown, string, { kind: string; reason: string; expiresAt: Date }]; expect(user).toBe(A1.userId); expect(h.kind).toBe("DAILY_LOSS_HALT"); expect(h.reason).toMatch(/realised loss 1500 reached the daily limit 1000/); expect(h.expiresAt.toISOString()).toBe("2031-01-06T18:30:00.000Z");
    expect(r).toMatchObject({ haltsSet: 1, haltCheckFailed: 0, haltConfigFault: false, failed: 0, evaluated: 1 }); expect(ev.evaluateCandidateForAccount).toHaveBeenCalledTimes(1);
  });
  it("a halt already in force is not recorded again, and a calm account records none", async () => {
    db.listActiveControls.mockResolvedValue([{ userId: A1.userId, scope: "USER", kind: "DAILY_LOSS_HALT" }]); await run(breached); expect(db.recordUserHalt).not.toHaveBeenCalled();
    db.listActiveControls.mockResolvedValue([]); await run(calm); expect(db.recordUserHalt).not.toHaveBeenCalled();
  });
  it("an account with no policy or no portfolio needs no halt and is still evaluated (the evaluation itself reports NOT_CONFIGURED / blocks)", async () => {
    db.getEffectiveRiskPolicy.mockResolvedValue(null); expect(await run(breached)).toMatchObject({ haltCheckFailed: 0, evaluated: 1 }); db.getEffectiveRiskPolicy.mockResolvedValue(policy); expect(await run(null)).toMatchObject({ haltCheckFailed: 0, evaluated: 1 });
  });
});

describe("a halt that cannot be persisted fails closed", () => {
  it("a transient failure is retried ONCE and, when the retry succeeds, the account is evaluated as normal", async () => {
    db.recordUserHalt.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue("halt-1"); const r = await run(breached);
    expect(db.recordUserHalt).toHaveBeenCalledTimes(2); expect(r).toMatchObject({ haltsSet: 1, haltCheckFailed: 0, failed: 0, evaluated: 1 });
  });
  it("two transient failures: the account's candidates are NOT evaluated, the failure is counted and logged without personal data, and nothing is retried a third time", async () => {
    db.recordUserHalt.mockRejectedValue(new Error("connection reset")); const logs: Array<[string, Record<string, unknown>]> = []; const r = await run(breached, logs);
    expect(db.recordUserHalt).toHaveBeenCalledTimes(2); expect(ev.evaluateCandidateForAccount).not.toHaveBeenCalled(); expect(r).toMatchObject({ haltsSet: 0, haltCheckFailed: 1, haltConfigFault: false, failed: 1, evaluated: 0 });
    expect(logs).toEqual([["planning.halt_write_failed", { errorName: "Error", code: null, configFault: false, failClosed: true }]]); expect(JSON.stringify(logs)).not.toContain(A1.userId);
  });
  it("a configuration fault (permission denied or missing function) is NOT retried, is flagged for escalation, and fails closed", async () => {
    for (const code of ["42501", "42883"]) {
      db.recordUserHalt.mockReset(); db.recordUserHalt.mockRejectedValue(pgErr(code)); ev.evaluateCandidateForAccount.mockClear(); const r = await run(breached);
      expect(db.recordUserHalt, code).toHaveBeenCalledTimes(1); expect(ev.evaluateCandidateForAccount, code).not.toHaveBeenCalled(); expect(r, code).toMatchObject({ haltCheckFailed: 1, haltConfigFault: true, evaluated: 0 });
    }
  });
  it("the SQLSTATE is also read from a wrapped driver error (error.cause.code)", async () => {
    db.recordUserHalt.mockRejectedValue(Object.assign(new Error("wrapped"), { cause: { code: "42501" } })); expect(await run(breached)).toMatchObject({ haltConfigFault: true, haltCheckFailed: 1 }); expect(db.recordUserHalt).toHaveBeenCalledTimes(1);
  });
  it("one account's failure never stops another account: the second is evaluated", async () => {
    db.listActiveAccounts.mockResolvedValue([A1, A2]); db.recordUserHalt.mockImplementation(async (_d: unknown, user: string) => { if (user === A1.userId) throw new Error("boom"); return "halt-2"; });
    const r = await run(breached); expect(r).toMatchObject({ accounts: 2, haltCheckFailed: 1, haltsSet: 1, evaluated: 1 }); expect(ev.evaluateCandidateForAccount).toHaveBeenCalledTimes(1);
    expect((ev.evaluateCandidateForAccount.mock.calls[0] as [unknown, { userId: string }])[1].userId).toBe(A2.userId);
  });
});

describe("risk state that cannot be read fails closed", () => {
  it("an unreadable risk policy: the account's candidates are not evaluated (after the one bounded retry)", async () => {
    db.getEffectiveRiskPolicy.mockRejectedValue(new Error("read failed")); const r = await run(breached); expect(db.getEffectiveRiskPolicy).toHaveBeenCalledTimes(2); expect(ev.evaluateCandidateForAccount).not.toHaveBeenCalled(); expect(r).toMatchObject({ haltCheckFailed: 1, evaluated: 0 });
  });
  it("unreadable controls: not evaluated, and no halt is attempted on guesswork", async () => {
    db.listActiveControls.mockRejectedValue(new Error("read failed")); const r = await run(breached); expect(db.recordUserHalt).not.toHaveBeenCalled(); expect(ev.evaluateCandidateForAccount).not.toHaveBeenCalled(); expect(r).toMatchObject({ haltCheckFailed: 1, evaluated: 0 });
  });
  it("an unreadable portfolio state: not evaluated", async () => {
    const r = await runEvaluationCycle({ db: {} as never, config: { ...DEFAULT_EVALUATION_CONFIG, enabled: true }, specs: null, regime: null, portfolio: { name: "t", portfolioFor: async () => { throw new Error("portfolio read failed"); } } as never, quotes: null, strategy: null, now: () => NOW });
    expect(ev.evaluateCandidateForAccount).not.toHaveBeenCalled(); expect(r).toMatchObject({ haltCheckFailed: 1, evaluated: 0 });
  });
  it("when the evaluation ITSELF cannot read the controls it throws: that candidate is counted failed and nothing is recorded as evaluated", async () => {
    ev.evaluateCandidateForAccount.mockRejectedValue(new Error("controls unreadable")); const r = await run(calm); expect(r).toMatchObject({ failed: 1, evaluated: 0, haltCheckFailed: 0 }); expect(r.verdicts).toEqual({});
  });
  it("a disabled cycle does nothing (no halt, no read)", async () => {
    const r = await runEvaluationCycle({ db: {} as never, config: DEFAULT_EVALUATION_CONFIG, specs: null, regime: null, portfolio: null, quotes: null, strategy: null }); expect(r).toMatchObject({ skipped: "DISABLED", haltCheckFailed: 0 }); expect(db.listActiveAccounts).not.toHaveBeenCalled();
  });
});
