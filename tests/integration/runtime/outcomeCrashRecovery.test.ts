/**
 * REAL process crash/recovery test for outcome collection (Stage 08 A1, G-49): abrupt SIGKILL of a dedicated child worker at four precise points, then restarted workers, concurrent workers and repetition. In every case the position that
 * was (or is being) closed ends with EXACTLY ONE trade outcome, EXACTLY ONE FINAL attribution, one CLOSED event and no changed or duplicated fill.
 *
 * GATED like the other crash tests: runs only with TWINS_CRASH_TEST=1 (plus the guarded twins_ci environment). It terminates ONLY the child pid this test spawned (the pid the child reported over IPC, checked against the Node
 * ChildProcess handle) and never touches PostgreSQL, Redis or any other process.
 *   1. SIGKILL inside the close transaction, after the outcome insert, before COMMIT   -> the database rolls the whole close back (position OPEN, no outcome);
 *   2. SIGKILL immediately after the close + outcome transaction COMMITTED             -> position CLOSED with its outcome, not yet attributed;
 *   3. SIGKILL during attribution, before its COMMIT                                   -> no attribution; the dead run's lease lapses;
 *   4. SIGKILL immediately after the attribution COMMITTED                             -> one FINAL attribution already;
 *   then: restart and recovery, several recovery workers at once, a repaired orphan, and repeated processing.
 */
import { fork, type ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { makeOutcomeHarness } from "../../support/outcomeHarness";
import { DATABASE_URL, waitFor } from "./harness";

const enabled = process.env.TWINS_CRASH_TEST === "1" && process.env.TWINS_CI === "1";
const CHILD = new URL("./crash/outcomeChild.ts", import.meta.url).pathname;
const h = makeOutcomeHarness(DATABASE_URL), procs: ChildProcess[] = [];
afterAll(async () => { for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); await h.close(); }); // only children this test spawned

interface Child { proc: ChildProcess; ipc: Array<Record<string, unknown>>; exited: Promise<void> }
function spawn(mode: string, a: { userId: string; u: string }): Child {
  const proc = fork(CHILD, [`--mode=${mode}`, `--user=${a.userId}`, `--underlying=${a.u}`], { execArgv: ["--import", "tsx"], silent: true, env: { ...process.env, NODE_ENV: "test", LIVE_TRADING: "false", TWINS_CI: "1" } });
  procs.push(proc);
  const child: Child = { proc, ipc: [], exited: new Promise<void>((r) => { if (proc.exitCode !== null || proc.signalCode) r(); else proc.once("exit", () => r()); }) };
  proc.on("message", (m) => child.ipc.push(m as Record<string, unknown>));
  let err = ""; proc.stderr?.on("data", (d: Buffer) => { err += d.toString("utf8"); });
  proc.on("exit", (code, signal) => { if (code !== 0 && signal === null && err) process.stderr.write(`[outcome child ${mode}] exit ${code}: ${err}\n`); });
  return child;
}
const ipc = (c: Child, type: string, ms = 60_000) => waitFor(async () => c.ipc.find((m) => m["type"] === type), ms, `child IPC '${type}'`);
const crash = async (mode: string, a: { userId: string; u: string }): Promise<void> => {
  const c = spawn(mode, a); await ipc(c, "ready");
  const cp = (await ipc(c, "checkpoint")) as { pid: number }; expect(cp.pid).toBe(c.proc.pid); // the process that reported the checkpoint is the child this test spawned
};
const killLast = async (): Promise<void> => { const c = procs[procs.length - 1] as ChildProcess; c.kill("SIGKILL"); await new Promise<void>((r) => { if (c.signalCode) r(); else c.once("exit", () => r()); }); expect(c.signalCode).toBe("SIGKILL"); };
const run = async (mode: string, a: { userId: string; u: string }) => { const c = spawn(mode, a); const d = (await ipc(c, "done")) as { report: Record<string, unknown> }; await c.exited; expect(c.proc.exitCode).toBe(0); return d.report; };
const jobRuns = async (): Promise<Array<{ status: string }>> => (await (await h.owner()).query("select status from learning_job_runs order by started_at")).rows;

describe.skipIf(!enabled)("outcome collection: crash and recovery (real SIGKILL, guarded twins_ci)", () => {
  it("1. SIGKILL inside the close transaction, after the outcome insert and before COMMIT: the database rolls the whole close back; recovery closes it once with one outcome, then one FINAL", async () => {
    const a = await h.unsyncedClose(), id = { userId: a.userId, u: a.u };
    await crash("close-before-commit", id); await killLast();
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "OPEN", outcomes: 0, closedEvents: 0, final: 0, fills: 2 }); // nothing of the close survived; the exit fill is committed
    const r = await run("exec-recover", id); expect(r["healed"]).toBe(1);
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 1, closedEvents: 1, final: 0, fills: 2 });
    await run("learn-recover", id);
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 1, closedEvents: 1, final: 1, attributions: 1, fills: 2 });
  }, 180_000);

  it("2. SIGKILL immediately after the close + outcome transaction COMMITTED: the position is CLOSED with its outcome; a restarted learning worker attributes it once; nothing is left for the execution worker", async () => {
    const a = await h.unsyncedClose(), id = { userId: a.userId, u: a.u };
    await crash("close-after-commit", id); await killLast();
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 1, closedEvents: 1, final: 0, fills: 2 });
    expect((await run("exec-recover", id))["healed"]).toBe(0); // the close was complete: nothing to repair
    await run("learn-recover", id);
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ outcomes: 1, closedEvents: 1, final: 1, attributions: 1 });
  }, 180_000);

  it("3. SIGKILL during attribution, before its COMMIT: no attribution exists, the dead run's lease lapses and is marked ABANDONED; the restarted worker attributes once", async () => {
    const a = await h.unsyncedClose(), id = { userId: a.userId, u: a.u };
    await run("exec-recover", id); // closed normally, atomically with its outcome
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 1, final: 0 });
    await crash("attribute-before-commit", id); await killLast();
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ outcomes: 1, final: 0, attributions: 0 }); // rolled back
    expect((await jobRuns()).filter((j) => j.status === "RUNNING").length).toBeGreaterThanOrEqual(1); // the dead worker still holds its lease
    expect((await run("learn-recover", id))["abandonedRuns"]).toBeGreaterThanOrEqual(1);
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ outcomes: 1, final: 1, attributions: 1 });
  }, 180_000);

  it("4. SIGKILL immediately after the attribution COMMITTED: the FINAL attribution exists once; a restarted worker and repeated cycles add nothing", async () => {
    const a = await h.unsyncedClose(), id = { userId: a.userId, u: a.u };
    await run("exec-recover", id);
    await crash("attribute-after-commit", id); await killLast();
    const after = await h.counts(a.decisionId, a.pos.id);
    expect(after).toMatchObject({ outcomes: 1, final: 1, attributions: 1 });
    await run("learn-recover", id); await run("learn-recover", id); await run("exec-recover", id);
    expect(await h.counts(a.decisionId, a.pos.id)).toEqual(after);
  }, 180_000);

  it("5. several recovery workers at the same moment after a crash: exactly one outcome, one CLOSED event and one FINAL attribution", async () => {
    const a = await h.unsyncedClose(), id = { userId: a.userId, u: a.u };
    await crash("close-before-commit", id); await killLast();
    const wave = [spawn("exec-recover", id), spawn("exec-recover", id), spawn("exec-recover", id)];
    await Promise.all(wave.map((c) => ipc(c, "done"))); await Promise.all(wave.map((c) => c.exited));
    for (const c of wave) expect(c.proc.exitCode).toBe(0);
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 1, closedEvents: 1, final: 0, fills: 2 });
    const learners = [spawn("learn-recover", id), spawn("learn-recover", id), spawn("learn-recover", id)];
    await Promise.all(learners.map((c) => ipc(c, "done"))); await Promise.all(learners.map((c) => c.exited));
    await run("learn-recover", id); // whichever workers were refused as ALREADY_RUNNING, a following cycle completes the work
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 1, closedEvents: 1, final: 1, attributions: 1, fills: 2 });
  }, 240_000);

  it("6. a position left CLOSED without an outcome by an older run is repaired by concurrent workers: one outcome, one FINAL", async () => {
    const a = await h.closedWithoutOutcome(), id = { userId: a.userId, u: a.u };
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ status: "CLOSED", outcomes: 0, final: 0 });
    const wave = [spawn("exec-recover", id), spawn("exec-recover", id), spawn("exec-recover", id)];
    await Promise.all(wave.map((c) => ipc(c, "done"))); await Promise.all(wave.map((c) => c.exited));
    expect(await h.counts(a.decisionId, a.pos.id)).toMatchObject({ outcomes: 1, final: 0 });
    await run("learn-recover", id);
    const done = await h.counts(a.decisionId, a.pos.id);
    expect(done).toMatchObject({ outcomes: 1, final: 1, attributions: 1 });
    await run("exec-recover", id); await run("learn-recover", id);
    expect(await h.counts(a.decisionId, a.pos.id)).toEqual(done);
  }, 240_000);
});
