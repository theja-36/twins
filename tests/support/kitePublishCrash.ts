/** Child process: publishes a Kite snapshot generation from FIXTURE data and kills itself (SIGKILL) at the Nth file rename. Used to prove readers refuse a crashed, mixed generation. */
import { renameSync } from "node:fs";
import { loadSnapshotConfig } from "../../packages/agents/src/snapshots";
import { buildSnapshotDocuments, mapCandles, publishGeneration } from "../../packages/kite/src/index";
import { catalog, rest, WIRING } from "../unit/kite/helpers";

const [dir, killAt, genId] = process.argv.slice(2) as [string, string, string];
const cat = catalog();
const NOW = new Date("2026-11-02T10:16:30.000Z");
const nifty = cat.require({ underlying: "NIFTY", kind: "index" });
const m = mapCandles({ instrument: nifty, interval: "day", candles: [["2026-10-30T00:00:00+0530", 24150, 24300, 24100, 24250, 0], ["2026-11-02T00:00:00+0530", 24250, 24400, 24200, 24350, 0]], fetchedAt: "2026-11-02T10:16:00.000Z", withOi: false });
if (!m.ok) throw new Error("fixture");
const cfg = loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: dir, TWINS_AGENT_SNAPSHOT_REQUIRED: "instrument-reference,quotes,option-quotes,option-chain,last-price,ohlc" });
const src = await rest({ now: NOW.getTime(), edit: (d) => { d["NSE:NIFTY 50"].last_price = 24999; d["NFO:NIFTY26NOVFUT"].last_price = 24999; } }); // different bytes from the first generation
const result = buildSnapshotDocuments({ catalog: cat, source: src, generationId: genId, now: NOW, referenceAsOf: "2026-11-02T10:00:00.000Z", quoteInstruments: cat.instruments, chains: [{ underlying: "NIFTY", expiry: "2026-11-26" }], candleKeys: ["NSE:NIFTY"], candles: new Map([["NSE:NIFTY", m.value]]), strikesEachSide: WIRING.chainStrikesEachSide, underlyingToleranceMs: WIRING.underlyingWindowMs });
let n = 0;
const r = publishGeneration(cfg, result, { now: NOW, io: { rename: (from, to) => { n += 1; if (n === Number(killAt)) process.kill(process.pid, "SIGKILL"); renameSync(from, to); } } });
process.stdout.write(`${JSON.stringify({ published: r.published })}\n`);
