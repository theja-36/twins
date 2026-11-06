/**
 * Shadow tally for reduce-only sizing (P0 #3). READS worker log lines (JSON per line, e.g. `docker logs twins-staging-worker-1 | shadow-diff`) and prints how often the reduce-only shadow WOULD have
 * reduced the size, by how much and why. It reads only the shadow's own events, writes nothing and contacts nothing. A reduce-only shadow can only lower exposure, so the numbers are "risk that would
 * have been avoided", not profit.
 *
 *   shadow-diff [--file <path>] [--json]      (reads stdin when no file is given)
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SHADOW_EVENT = "risk_sizing.shadow.reduce_only";
const VIOLATION = "risk_sizing.shadow.violation";
const FAILED = "risk_sizing.shadow.failed";

export interface ShadowTally {
  decisions: number; reduced: number; reducedShare: number | null; meanMultiplier: number | null; minMultiplier: number | null;
  totalV1Quantity: number; totalShadowQuantity: number;
  /** Sum over decisions of (v1 - shadow) x per-unit risk, only where the per-unit risk was logged. */
  riskAvoidedAmount: number; decisionsWithUnitRisk: number;
  byFactor: Record<string, number>; unknownInputs: Record<string, number>;
  violations: number; failures: number; duplicatesIgnored: number; notReduceOnly: number;
}
interface Line { event?: unknown; riskDecisionId?: unknown; decisionVersion?: unknown; v1Quantity?: unknown; shadowQuantity?: unknown; multiplier?: unknown; reduced?: unknown; factors?: unknown; unknownInputs?: unknown; unitRisk?: unknown }
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;

export function tallyShadow(text: string): ShadowTally {
  const t: ShadowTally = { decisions: 0, reduced: 0, reducedShare: null, meanMultiplier: null, minMultiplier: null, totalV1Quantity: 0, totalShadowQuantity: 0, riskAvoidedAmount: 0, decisionsWithUnitRisk: 0, byFactor: {}, unknownInputs: {}, violations: 0, failures: 0, duplicatesIgnored: 0, notReduceOnly: 0 };
  const seen = new Set<string>();
  let msum = 0;
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s.startsWith("{")) continue;
    let o: Line;
    try { o = JSON.parse(s) as Line; } catch { continue; }
    if (o.event === VIOLATION) { t.violations++; continue; }
    if (o.event === FAILED) { t.failures++; continue; }
    if (o.event !== SHADOW_EVENT) continue;
    if (typeof o.riskDecisionId !== "string" || !isNum(o.v1Quantity) || !isNum(o.shadowQuantity) || !isNum(o.multiplier)) continue;
    const key = `${o.riskDecisionId}:${String(o.decisionVersion)}`;
    if (seen.has(key)) { t.duplicatesIgnored++; continue; }
    seen.add(key);
    if (o.shadowQuantity > o.v1Quantity) { t.notReduceOnly++; continue; } // must never happen; counted, not tallied
    t.decisions++;
    if (o.shadowQuantity < o.v1Quantity) t.reduced++;
    msum += o.multiplier;
    t.minMultiplier = t.minMultiplier === null ? o.multiplier : Math.min(t.minMultiplier, o.multiplier);
    t.totalV1Quantity += o.v1Quantity; t.totalShadowQuantity += o.shadowQuantity;
    if (isNum(o.unitRisk)) { t.riskAvoidedAmount += (o.v1Quantity - o.shadowQuantity) * o.unitRisk; t.decisionsWithUnitRisk++; }
    if (Array.isArray(o.factors)) for (const f of o.factors as Array<{ name?: unknown }>) if (typeof f?.name === "string") t.byFactor[f.name] = (t.byFactor[f.name] ?? 0) + 1;
    if (Array.isArray(o.unknownInputs)) for (const u of o.unknownInputs) if (typeof u === "string") t.unknownInputs[u] = (t.unknownInputs[u] ?? 0) + 1;
  }
  t.reducedShare = t.decisions ? round(t.reduced / t.decisions) : null;
  t.meanMultiplier = t.decisions ? round(msum / t.decisions) : null;
  t.riskAvoidedAmount = round(t.riskAvoidedAmount, 2);
  return t;
}

export function renderTally(t: ShadowTally): string[] {
  const pct = (v: number | null): string => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
  return [
    `reduce-only shadow: ${t.decisions} sized decision(s); would have reduced ${t.reduced} (${pct(t.reducedShare)}); mean multiplier ${t.meanMultiplier ?? "-"}, min ${t.minMultiplier ?? "-"}`,
    `quantity: v1 ${t.totalV1Quantity} -> shadow ${t.totalShadowQuantity}; planned loss avoided ${t.riskAvoidedAmount} (over ${t.decisionsWithUnitRisk} decision(s) with a known per-unit risk)`,
    `factors: ${JSON.stringify(t.byFactor)}`,
    `unknown inputs: ${JSON.stringify(t.unknownInputs)}`,
    `violations ${t.violations}, failures ${t.failures}, duplicates ignored ${t.duplicatesIgnored}, not-reduce-only ${t.notReduceOnly}`,
    "Reduce-only can only lower exposure: these numbers are risk avoided, not profit. Nothing reads this for any decision.",
  ];
}

export function runCli(argv: string[], io: { stdin: () => string; out: (l: string) => void; err: (l: string) => void }): number {
  let file: string | undefined, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--file" && argv[i + 1]) file = argv[++i];
    else { io.err("usage: shadow-diff [--file <path>] [--json]"); return 2; }
  }
  let text: string;
  try { text = file ? readFileSync(file, "utf8") : io.stdin(); } catch { io.err("failed: input_unreadable"); return 1; }
  const t = tallyShadow(text);
  if (json) io.out(JSON.stringify(t, null, 2)); else for (const l of renderTally(t)) io.out(l);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(runCli(process.argv.slice(2), { stdin: () => readFileSync(0, "utf8"), out: (l) => console.log(l), err: (l) => console.error(l) }));
