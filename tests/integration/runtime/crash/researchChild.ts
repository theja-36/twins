/**
 * Dedicated child process for the research crash/recovery test (G-43). Claims ONE candidate (by its unique underlying), runs the REAL candidate research with the REAL database store, and stops at a checkpoint so the
 * parent can SIGKILL this exact pid:
 *   --mode=before-commit  inside the package transaction (lock held, nothing committed): writes the marker file synchronously, then blocks forever;
 *   --mode=after-commit   after the package and its agent runs are COMMITTED and before the queue item is completed: tells the parent over IPC, then waits forever.
 * Guarded like the worker child: refuses anything but the loopback twins_ci database. Synthetic data only.
 */
import { writeFileSync } from "node:fs";
import { createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, runCandidateResearch } from "../../../../packages/agents/src/index";
import { createCandidateQueue, createDb, storeResearchPackage } from "../../../../packages/database/src/index";

const arg = (name: string): string => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); if (!hit) throw new Error(`missing --${name}=...`); return hit.slice(name.length + 3); };
function assertSafeTarget(): void {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://missing"), loop = new Set(["127.0.0.1", "localhost"]);
  if (process.env.TWINS_CI !== "1" || process.env.LIVE_TRADING !== "false") throw new Error("unsafe environment (need TWINS_CI=1, LIVE_TRADING=false)");
  if (!loop.has(db.hostname) || db.pathname !== "/twins_ci" || decodeURIComponent(db.username) !== "twins_ci") throw new Error("refusing: DATABASE_URL is not the twins_ci test target");
}
async function main(): Promise<void> {
  assertSafeTarget();
  const mode = arg("mode"), underlying = arg("underlying"), marker = arg("marker");
  const db = createDb(process.env.DATABASE_URL as string);
  const claimed = await createCandidateQueue(db, { underlyings: [underlying] }).claimNext(new Date(), []);
  if (!claimed) throw new Error("no candidate to claim");
  process.send?.({ type: "ready", pid: process.pid, candidateId: claimed.id });
  await runCandidateResearch(claimed, {
    registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config: loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" }), deps: { now: () => new Date(), sleep: async () => undefined }, refuse: async () => undefined,
    sink: {
      async save(candidateId, build) {
        const saved = await storeResearchPackage(db, (version) => {
          const row = build(version);
          if (mode === "before-commit") { writeFileSync(marker, String(process.pid)); for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } // inside the open transaction: never returns
          return row as never;
        }, candidateId);
        if (mode === "after-commit") { process.send?.({ type: "checkpoint", pid: process.pid, packageId: saved.id }); await new Promise(() => undefined); } // committed; the queue item is never completed
        return saved;
      },
    },
  });
}
main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
