import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = { record: [] as Array<Record<string, unknown>>, pendingOpts: [] as unknown[] };
let pending: Array<Record<string, unknown>> = [];
let failClaim: string | null = null, recordedFlag = true, revisionState: "current" | "superseded" = "current", activeRows: Array<Record<string, unknown>> = [];
vi.mock("@twins/database", () => ({
  listPendingClaims: async (_db: unknown, o: unknown) => { calls.pendingOpts.push(o); return pending; },
  listActiveTelegramCandidates: async () => activeRows,
  recordCandidacy: async (_db: unknown, r: Record<string, unknown>) => { if (r["claimId"] === failClaim) throw new Error("boom with secret row values"); calls.record.push(r); return { recorded: recordedFlag, candidateId: r["outcome"] === "CREATED" ? `cand-${calls.record.length}` : null, created: r["outcome"] === "CREATED", superseded: ((r["supersedes"] as string[] | undefined) ?? []).length }; },
}));
vi.mock("@twins/ingestion", () => ({ getRevisionStates: async (_db: unknown, _s: string, _o: string) => [{ id: "m-ok", state: revisionState, reason: "t" }, { id: "m-2", state: revisionState, reason: "t" }, { id: "m-3", state: revisionState, reason: "t" }] }));
vi.mock("../../../packages/signals/src/classification/persist", () => ({ storeClassification: async () => true }));
import { DEFAULT_TELEGRAM_CANDIDATE_RUN, loadTelegramCandidateConfig, runTelegramCandidateCycle } from "@twins/signals";

const NOW = new Date("2031-01-06T05:00:00Z"), AT = new Date("2031-01-06T04:50:00Z");
const claim = (o: Record<string, unknown> = {}) => ({ action: "buy", intent: "long_entry_presumed", underlying: "NIFTY", underlyingAliasUsed: false, strike: 24500, optionType: "CE", compactCodeUnrecognized: false, optionTypeConflict: false, expiry: { status: "missing" }, entry: { type: "above", price: 118 }, stopLoss: 96, targets: [140], levelBasis: "premium", levelBasisConflict: false, impliedUnderlyingView: "bullish", ...o });
const row = (id: string, o: Record<string, unknown> = {}) => ({ claimId: id, parserVersion: "p", claim: claim(), messageId: id === "c1" ? "m-ok" : id === "c2" ? "m-2" : "m-3", sourceId: "s1", externalMessageId: id, originMessageId: id, messageTimestamp: AT, receivedAt: AT, observedAt: null, firstSeenEdited: false, captureMethod: "bot_webhook", editDate: null, rawText: "BUY NIFTY 24500 CE ABOVE 118", ...o });
const cfg = { ...DEFAULT_TELEGRAM_CANDIDATE_RUN, enabled: true };
const run = (o: Record<string, unknown> = {}) => runTelegramCandidateCycle({ db: {} as never, config: cfg, now: () => NOW, ...o });
beforeEach(() => { calls.record.length = 0; calls.pendingOpts.length = 0; pending = [row("c1")]; failClaim = null; recordedFlag = true; revisionState = "current"; activeRows = []; });

describe("the cycle", () => {
  it("does nothing while disabled or while the safety state stops it, and reads nothing", async () => {
    expect(await runTelegramCandidateCycle({ db: {} as never, config: { ...cfg, enabled: false }, now: () => NOW })).toMatchObject({ skipped: "DISABLED", examined: 0 });
    expect(await run({ allowed: async () => false })).toMatchObject({ skipped: "SAFETY_STOPPED", examined: 0 });
    expect(calls.pendingOpts).toEqual([]);
  });
  it("creates a candidate for a good claim, bounded by its batch and lookback", async () => {
    const r = await run();
    expect(r).toMatchObject({ examined: 1, created: 1, failed: 0, byOutcome: { CREATED: 1 } });
    expect(calls.record[0]).toMatchObject({ claimId: "c1", outcome: "CREATED", policyVersion: "telegram-candidacy-v1" });
    expect(calls.pendingOpts[0]).toMatchObject({ limit: 50, policyVersion: "telegram-candidacy-v1" });
    expect((calls.pendingOpts[0] as { since: Date }).since.toISOString()).toBe("2031-01-05T05:00:00.000Z");
  });
  it("records WHY a claim did not become a candidate", async () => {
    pending = [row("c1", { claim: claim({ entry: { type: "unspecified" } }) })];
    const r = await run(); expect(r.byOutcome).toEqual({ INCOMPLETE: 1 }); expect(calls.record[0]).toMatchObject({ outcome: "INCOMPLETE", reasons: ["ENTRY_NOT_STATED"] });
  });
  it("a superseded revision is recorded and never becomes a candidate", async () => { revisionState = "superseded"; const r = await run(); expect(r.created).toBe(0); expect(calls.record[0]).toMatchObject({ outcome: "SUPERSEDED_REVISION" }); });
  it("one failing claim does not stop the others, is not recorded (so it is retried) and leaks no error text", async () => {
    pending = [row("c1"), row("c2"), row("c3")]; failClaim = "c2"; const logs: string[] = [];
    const r = await run({ log: (e: string, f: Record<string, unknown>) => logs.push(JSON.stringify({ e, f })) });
    expect(r).toMatchObject({ examined: 3, failed: 1 }); expect(calls.record.map((x) => x["claimId"])).toEqual(["c1", "c3"]);
    expect(logs.join("")).toContain("telegram.candidate.failed"); expect(logs.join("")).not.toMatch(/secret|boom/);
  });
  it("a decision another worker already recorded is not counted twice", async () => { recordedFlag = false; const r = await run(); expect(r).toMatchObject({ examined: 1, created: 0, byOutcome: {} }); });
  it("repeats inside one batch are caught as duplicates, and opposite views as contradictions", async () => {
    pending = [row("c1"), row("c2", { externalMessageId: "c2", originMessageId: "c2" }), row("c3", { claim: claim({ optionType: "PE", impliedUnderlyingView: "bearish" }), originMessageId: "c3", externalMessageId: "c3" })];
    const r = await run(); expect(r.byOutcome).toEqual({ CREATED: 1, DUPLICATE: 1, CONTRADICTORY: 1 });
  });
  it("a malformed stored claim is counted as failed, never as a candidate", async () => { pending = [row("c1", { claim: { nonsense: true } })]; const r = await run(); expect(r).toMatchObject({ failed: 1, created: 0 }); expect(calls.record).toEqual([]); });
});

describe("configuration", () => {
  it("is off by default and validates strictly", () => {
    expect(loadTelegramCandidateConfig({}).enabled).toBe(false); expect(loadTelegramCandidateConfig({ TWINS_TELEGRAM_CANDIDATES_ENABLED: "true" }).enabled).toBe(true);
    expect(() => loadTelegramCandidateConfig({ TWINS_TELEGRAM_CANDIDATES_ENABLED: "yes" })).toThrow(/exactly/); expect(() => loadTelegramCandidateConfig({ TWINS_TELEGRAM_CANDIDATE_TTL_MINUTES: "0" })).toThrow(/between/); expect(() => loadTelegramCandidateConfig({ TWINS_TELEGRAM_CANDIDATE_BATCH: "9999" })).toThrow(/between/);
    expect(loadTelegramCandidateConfig({ TWINS_TELEGRAM_CANDIDATE_TTL_MINUTES: "30" }).ttlMinutes).toBe(30);
  });
});
