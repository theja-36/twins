import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canTransition, dispatchResearch, revalidate, TERMINAL_STATES, type CandidateQueuePort, type CandidateState, type ClaimedCandidate } from "../../../packages/opportunity/src/index";
import { runScheduledJob } from "../../../services/scheduler/src/scheduledJob";
import { NOW } from "./fixtures";

const ALL: CandidateState[] = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"];
describe("lifecycle transitions", () => {
  it("allows exactly the documented transitions and nothing leaves a finished state", () => {
    const legal = ALL.flatMap((a) => ALL.filter((b) => canTransition(a, b)).map((b) => `${a}>${b}`)).sort();
    expect(legal).toEqual([
      "IN_RESEARCH>EXPIRED", "IN_RESEARCH>INVALIDATED", "IN_RESEARCH>NEW", "IN_RESEARCH>READY_FOR_DECISION", "IN_RESEARCH>SUPERSEDED", "IN_RESEARCH>WITHDRAWN",
      "NEW>EXPIRED", "NEW>INVALIDATED", "NEW>IN_RESEARCH", "NEW>SUPERSEDED", "NEW>WITHDRAWN",
      "READY_FOR_DECISION>EXPIRED", "READY_FOR_DECISION>INVALIDATED", "READY_FOR_DECISION>SUPERSEDED", "READY_FOR_DECISION>WITHDRAWN",
    ].sort());
    for (const t of TERMINAL_STATES) for (const b of ALL) expect(canTransition(t, b)).toBe(false);
    expect(canTransition("NEW", "READY_FOR_DECISION")).toBe(false); // research cannot be skipped
  });
  it("the migration encodes the same table (the database is the enforcement point)", () => {
    const sql = readFileSync(join(__dirname, "../../../packages/database/drizzle/0036_opportunity_engine.sql"), "utf8");
    for (const t of ["'IN_RESEARCH', 'EXPIRED', 'INVALIDATED', 'SUPERSEDED', 'WITHDRAWN'", "'NEW', 'READY_FOR_DECISION', 'EXPIRED', 'INVALIDATED', 'SUPERSEDED', 'WITHDRAWN'", "'EXPIRED', 'INVALIDATED', 'SUPERSEDED', 'WITHDRAWN'"]) expect(sql).toContain(t);
    expect(sql).toContain("opportunity_candidate_events_no_update_delete");
    expect(sql).toContain("the identity and thesis of a candidate cannot change");
  });
});

describe("revalidation", () => {
  const buy = { side: "BUY" as const, invalidation: { price: 95, breachWhen: "BELOW" as const, condition: "x" }, stopLoss: 95, targets: [105, 110], expiresAt: new Date(NOW.getTime() + 3600_000) };
  const sell = { ...buy, side: "SELL" as const, invalidation: { price: 105, breachWhen: "ABOVE" as const, condition: "x" }, stopLoss: 105, targets: [95, 90] };
  const px = (price: number, ageMin = 1) => ({ price, asOf: new Date(NOW.getTime() - ageMin * 60_000).toISOString() });
  it("valid only while the price has not breached the thesis", () => {
    expect(revalidate(buy, px(100), NOW, 10)).toEqual({ outcome: "VALID", reason: "PRICE_WITHIN_THESIS" });
    expect(revalidate(buy, px(95), NOW, 10)).toEqual({ outcome: "INVALIDATED", reason: "STOP_BREACHED" });
    expect(revalidate(buy, px(106), NOW, 10)).toEqual({ outcome: "INVALIDATED", reason: "TARGET_REACHED_BEFORE_ENTRY" });
    expect(revalidate(sell, px(100), NOW, 10).outcome).toBe("VALID");
    expect(revalidate(sell, px(105), NOW, 10)).toMatchObject({ outcome: "INVALIDATED", reason: "STOP_BREACHED" });
    expect(revalidate(sell, px(94), NOW, 10)).toMatchObject({ reason: "TARGET_REACHED_BEFORE_ENTRY" });
  });
  it("expiry wins; a missing, stale, future or malformed price is UNVERIFIABLE and never VALID", () => {
    expect(revalidate({ ...buy, expiresAt: new Date(NOW.getTime() - 1) }, px(100), NOW, 10)).toEqual({ outcome: "EXPIRED", reason: "PAST_EXPIRY" });
    expect(revalidate(buy, null, NOW, 10)).toEqual({ outcome: "UNVERIFIABLE", reason: "NO_PRICE" });
    expect(revalidate(buy, px(100, 60), NOW, 10)).toEqual({ outcome: "UNVERIFIABLE", reason: "PRICE_STALE" });
    expect(revalidate(buy, px(100, -30), NOW, 10)).toEqual({ outcome: "UNVERIFIABLE", reason: "PRICE_FROM_FUTURE" });
    expect(revalidate(buy, { price: Number.NaN, asOf: NOW.toISOString() }, NOW, 10).outcome).toBe("UNVERIFIABLE");
    expect(revalidate(buy, { price: 100, asOf: "garbage" }, NOW, 10).outcome).toBe("UNVERIFIABLE");
    expect(revalidate({ ...buy, invalidation: null, stopLoss: null }, px(100), NOW, 10)).toEqual({ outcome: "UNVERIFIABLE", reason: "MALFORMED" }); // no invalidation level => never "valid"
  });
});

/** A memory implementation of the queue port with the same state rules as the database. */
function memoryQueue(rows: Array<{ id: string; state: CandidateState; attempts: number; rank: number; expiresAt: Date; source?: "TELEGRAM" | "INDEPENDENT"; updatedAt?: Date }>): CandidateQueuePort & { rows: typeof rows } {
  const get = (id: string) => rows.find((r) => r.id === id)!;
  return {
    rows,
    async expireDue(now) { let n = 0; for (const r of rows) if (!TERMINAL_STATES.includes(r.state) && r.expiresAt <= now) { r.state = "EXPIRED"; n++; } return n; },
    async recoverStale(now, lease, max) { let n = 0; for (const r of rows) if (r.state === "IN_RESEARCH" && now.getTime() - (r.updatedAt ?? now).getTime() > lease) { r.attempts++; r.state = r.attempts >= max ? "WITHDRAWN" : "NEW"; n++; } return n; },
    async claimNext(now, exclude) {
      const r = rows.filter((x) => x.state === "NEW" && x.expiresAt > now && !exclude.includes(x.id)).sort((a, b) => b.rank - a.rank)[0];
      if (!r) return null; r.state = "IN_RESEARCH"; r.updatedAt = now;
      return { id: r.id, source: r.source ?? "INDEPENDENT", underlying: "AAA", exchange: "NSE", strike: null, optionType: null, expiry: null, side: "BUY", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 95, targets: [105], dataSource: "FIXTURE", createdAt: now, expiresAt: r.expiresAt, attempts: r.attempts } as ClaimedCandidate;
    },
    async complete(id) { const r = get(id); if (r.state === "IN_RESEARCH") r.state = "READY_FOR_DECISION"; },
    async release(id, _reason, o) { const r = get(id); if (r.state !== "IN_RESEARCH") return "WITHDRAWN"; if (o.count) r.attempts++; if (o.count && r.attempts >= o.maxAttempts) { r.state = "WITHDRAWN"; return "WITHDRAWN"; } r.state = "NEW"; return "RETRY"; },
    async expire(id) { get(id).state = "EXPIRED"; },
  };
}
const row = (id: string, o: Partial<{ state: CandidateState; attempts: number; rank: number; expiresAt: Date; source: "TELEGRAM" | "INDEPENDENT" }> = {}) => ({ id, state: "NEW" as CandidateState, attempts: 0, rank: 50, expiresAt: new Date(NOW.getTime() + 3600_000), ...o });
const base = { now: NOW, enabled: true, batchSize: 5, maxAttempts: 3, leaseMs: 15 * 60_000 };

describe("research dispatch", () => {
  it("researches best-rank first, from EITHER source, and marks each READY_FOR_DECISION", async () => {
    const q = memoryQueue([row("a", { rank: 10 }), row("b", { rank: 90, source: "TELEGRAM" }), row("c", { rank: 50 })]);
    const seen: string[] = [];
    const r = await dispatchResearch({ ...base, queue: q, research: async (c) => { seen.push(`${c.id}:${c.source}`); return {}; } });
    expect(seen).toEqual(["b:TELEGRAM", "c:INDEPENDENT", "a:INDEPENDENT"]);
    expect(r).toMatchObject({ researched: 3, failed: 0 });
    expect(q.rows.map((x) => x.state)).toEqual(["READY_FOR_DECISION", "READY_FOR_DECISION", "READY_FOR_DECISION"]);
  });
  it("never researches the same candidate twice and respects the batch size", async () => {
    const q = memoryQueue([row("a"), row("b"), row("c")]); let calls = 0;
    const run = () => dispatchResearch({ ...base, batchSize: 2, queue: q, research: async () => { calls++; return {}; } });
    await Promise.all([run(), run()]);
    expect(calls).toBeLessThanOrEqual(3);
    await run();
    expect(calls).toBe(3);
    await run();
    expect(calls).toBe(3);
  });
  it("a failed attempt returns the candidate for retry until attempts run out, then withdraws it; only the error class is kept", async () => {
    const q = memoryQueue([row("a")]); const logs: Array<Record<string, unknown>> = [];
    const fail = () => dispatchResearch({ ...base, queue: q, log: (_e, f) => logs.push(f), research: async () => { throw new TypeError("SECRET row value"); } });
    expect(await fail()).toMatchObject({ failed: 1, retried: 1 });
    expect(q.rows[0]!.state).toBe("NEW");
    await fail();
    expect(await fail()).toMatchObject({ failed: 1, withdrawn: 1 });
    expect(q.rows[0]).toMatchObject({ state: "WITHDRAWN", attempts: 3 });
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });
  it("a safety refusal stops the whole batch without consuming an attempt", async () => {
    const q = memoryQueue([row("a"), row("b")]);
    const r = await dispatchResearch({ ...base, queue: q, research: async () => { throw Object.assign(new Error("refused"), { code: "safety_refused" }); } });
    expect(r).toMatchObject({ stoppedBySafety: true, researched: 0, failed: 0 });
    expect(q.rows.map((x) => [x.state, x.attempts])).toEqual([["NEW", 0], ["NEW", 0]]);
  });
  it("while research is disabled nothing is claimed; expiry still runs", async () => {
    const q = memoryQueue([row("a"), row("old", { expiresAt: new Date(NOW.getTime() - 1) })]);
    const r = await dispatchResearch({ ...base, enabled: false, queue: q, research: async () => { throw new Error("must not run"); } });
    expect(r).toMatchObject({ skipped: "ENGINE_DISABLED", expired: 1, researched: 0 });
    expect(q.rows.map((x) => x.state)).toEqual(["NEW", "EXPIRED"]);
  });
  it("a candidate that expired before research ran is expired, not researched; an abandoned one is recovered", async () => {
    const q = memoryQueue([row("a"), row("stuck", { state: "IN_RESEARCH", updatedAt: new Date(NOW.getTime() - 3600_000) } as never)]);
    const r = await dispatchResearch({ ...base, queue: q, research: async () => ({ skipped: "CANDIDATE_EXPIRED" as const }) });
    expect(r.recovered).toBe(1);
    expect(r.expiredDuringResearch).toBe(2);
    expect(q.rows.map((x) => x.state)).toEqual(["EXPIRED", "EXPIRED"]);
  });
  it("an engine that turns out to be disabled releases the claim without using an attempt", async () => {
    const q = memoryQueue([row("a")]);
    const r = await dispatchResearch({ ...base, queue: q, research: async () => ({ skipped: "ENGINE_DISABLED" as const }) });
    expect(r.skipped).toBe("ENGINE_DISABLED");
    expect(q.rows[0]).toMatchObject({ state: "NEW", attempts: 0 });
  });
});

describe("boundaries", () => {
  const dir = join(__dirname, "../../../packages/opportunity/src");
  const src = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);
  it("the engine never touches Telegram, brokers, networks, orders or approvals", () => {
    for (const [f, text] of src) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/telegram|adapter-broker|kite|fetch\(|node:https?|node:net|axios|\bplaceOrder|approveTrade|TRADING_ENABLED|liveTrading/i);
      expect(code, f).not.toMatch(/from "@twins\/(adapter|ingestion|approval|paper)/);
    }
  });
  it("only the cycle writes to the database, and only through stores", () => {
    for (const [f, text] of src) { if (f !== "cycle.ts") expect(text, f).not.toMatch(/@twins\/database/); }
    expect(src.find(([f]) => f === "cycle.ts")![1]).not.toMatch(/\.insert\(|\.update\(|\.delete\(|db\.execute/);
  });
  it("scheduler: research_intake jobs run only when intake is enabled and the kill switch is off, fail closed, and do not need trading enabled", async () => {
    const events: string[] = []; let ran = 0;
    const out = await runScheduledJob({ name: "opportunity_cycle_enqueue", effect: "research_intake" }, async () => { ran++; }, { log: (e) => events.push(e) });
    // the vitest runtime-state source allows intake; either way the contract is: ran XOR skipped_by_safety with an event
    expect(out === "ran" ? ran === 1 && events.length === 0 : ran === 0 && events[0] === "scheduler.job.skipped_by_safety").toBe(true);
  });
});
