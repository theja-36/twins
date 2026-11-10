/**
 * REAL process crash/recovery test for candidate research (G-43, G-44): abrupt SIGKILL of a dedicated child process that is researching a candidate.
 *
 * GATED like the worker crash test: runs only with TWINS_CRASH_TEST=1 (plus the guarded twins_ci environment). It terminates ONLY the child pid this test spawned (verified against the pid the child reported over IPC or
 * wrote to its marker file) and never touches PostgreSQL or any other process.
 *
 *   A. killed INSIDE the package transaction (before commit): PostgreSQL rolls it back, so there is no package and no agent run; recovery researches the candidate once.
 *   B. killed AFTER the commit and BEFORE the queue item completed: the package and its 13 agent runs are stored, the candidate is still IN_RESEARCH; lease recovery re-queues it and the retry finds the stored package.
 * Either way: exactly one package (version 1) and one set of agent runs, and the candidate ends READY_FOR_DECISION.
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, runCandidateResearch } from "../../../packages/agents/src/index";
import { beginScan, createCandidateQueue, createDb, getCandidate, insertScanCandidates, storeResearchPackage, type CandidateInsert } from "../../../packages/database/src/index";
import { dispatchResearch } from "../../../packages/opportunity/src/index";
import { DATABASE_URL, waitFor } from "./harness";

const enabled = process.env.TWINS_CRASH_TEST === "1" && process.env.TWINS_CI === "1";
const CHILD = new URL("./crash/researchChild.ts", import.meta.url).pathname;
const db = createDb(DATABASE_URL), clients: pg.Client[] = [], procs: ChildProcess[] = [];
async function owner(): Promise<pg.Client> { const c = new pg.Client({ connectionString: DATABASE_URL }); await c.connect(); clients.push(c); return c; }
afterAll(async () => { for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
const sym = (): string => `K${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const draft = (underlying: string): CandidateInsert => ({ dedupeKey: randomUUID(), underlying, exchange: "NSE", side: "BUY", setup: "BREAKOUT", entryKind: "at", entryLow: 100, entryHigh: 100, stopLoss: 95, targets: [105, 110, 115], invalidation: { price: 95, breachWhen: "BELOW", condition: "x" }, rankScore: 60, evidence: [{ kind: "setup" }], dataSource: "FIXTURE", correlationId: randomUUID(), createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000) });
async function candidate(): Promise<{ id: string; u: string }> {
  const u = sym(), scan = (await beginScan(db, { scanKind: "TEST", slotKey: randomUUID(), parameters: {}, detectorVersion: "t", dataSource: "FIXTURE", now: new Date(), leaseMs: 60_000 })).scanId;
  return { id: (await insertScanCandidates(db, scan, [draft(u)])).created[0] as string, u };
}
const counts = async (id: string) => {
  const a = await owner();
  return { packages: (await a.query("select count(*)::int as n from research_packages where candidate_id = $1", [id])).rows[0].n as number, agentRuns: (await a.query("select count(*)::int as n from research_agent_runs where research_package_id in (select id from research_packages where candidate_id = $1)", [id])).rows[0].n as number };
};
const recoverAndFinish = async (id: string, u: string) => {
  const queue = createCandidateQueue(db, { underlyings: [u] });
  expect(await queue.recoverStale(new Date(Date.now() + 10 * 60_000), 60_000, 3)).toBe(1); // the dead worker's lease lapsed
  expect((await getCandidate(db, id))?.state).toBe("NEW");
  const registry = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
  const r = await dispatchResearch({ queue, now: new Date(), enabled: true, batchSize: 3, maxAttempts: 3, leaseMs: 60_000, research: (c) => runCandidateResearch(c, { registry, config, deps: { now: () => new Date(), sleep: async () => undefined }, refuse: async () => undefined, sink: { save: (cid, build) => storeResearchPackage(db, (v) => build(v) as never, cid) } }) });
  expect(r).toMatchObject({ researched: 1, failed: 0 });
};
function spawn(mode: string, u: string, marker: string): ChildProcess {
  const proc = fork(CHILD, [`--mode=${mode}`, `--underlying=${u}`, `--marker=${marker}`], { execArgv: ["--import", "tsx"], silent: true, env: { ...process.env, NODE_ENV: "test", LIVE_TRADING: "false", TWINS_CI: "1" } });
  procs.push(proc); return proc;
}
const ipc = (p: ChildProcess, type: string) => { const seen: Array<Record<string, unknown>> = []; p.on("message", (m) => seen.push(m as Record<string, unknown>)); return (ms = 30_000) => waitFor(async () => seen.find((m) => m["type"] === type), ms, `child IPC '${type}'`); };
const killed = (p: ChildProcess) => new Promise<void>((resolve) => { if (p.signalCode) resolve(); else p.once("exit", () => resolve()); });

describe.skipIf(!enabled)("candidate research crash and recovery (real SIGKILL, guarded twins_ci)", () => {
  it("A. SIGKILL inside the package transaction (before commit): nothing is stored; recovery researches the candidate exactly once", async () => {
    const { id, u } = await candidate(), marker = join(mkdtempSync(join(tmpdir(), "twins-research-")), "in-transaction");
    const child = spawn("before-commit", u, marker); const reported = ipc(child, "ready"); await reported();
    await waitFor(async () => (existsSync(marker) ? true : undefined), 60_000, "child inside the transaction");
    expect(Number(readFileSync(marker, "utf8"))).toBe(child.pid); // the pid that wrote the marker is the child this test spawned
    expect((await getCandidate(db, id))?.state).toBe("IN_RESEARCH");
    child.kill("SIGKILL"); await killed(child);
    expect(await counts(id)).toEqual({ packages: 0, agentRuns: 0 }); // the open transaction died with the process
    await recoverAndFinish(id, u);
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 });
    expect((await getCandidate(db, id))?.state).toBe("READY_FOR_DECISION");
    expect((await (await owner()).query("select version from research_packages where candidate_id = $1", [id])).rows).toEqual([{ version: 1 }]);
  }, 120_000);
  it("B. SIGKILL after the commit, before the queue item completed: the package and its agent runs survive; the retry stores nothing new", async () => {
    const { id, u } = await candidate(), marker = join(mkdtempSync(join(tmpdir(), "twins-research-")), "unused");
    const child = spawn("after-commit", u, marker); const ready = ipc(child, "ready"), saved = ipc(child, "checkpoint"); await ready();
    const cp = (await saved(60_000)) as { pid: number; packageId: string }; expect(cp.pid).toBe(child.pid);
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 }); expect((await getCandidate(db, id))?.state).toBe("IN_RESEARCH");
    child.kill("SIGKILL"); await killed(child);
    await recoverAndFinish(id, u);
    expect(await counts(id)).toEqual({ packages: 1, agentRuns: 13 }); // still one: the retry found the stored package
    expect((await getCandidate(db, id))?.state).toBe("READY_FOR_DECISION");
    expect((await (await owner()).query("select id from research_packages where candidate_id = $1", [id])).rows).toEqual([{ id: cp.packageId }]);
  }, 120_000);
});
