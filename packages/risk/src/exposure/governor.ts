/**
 * Portfolio exposure governor (P1 #10), advisory. PURE: aggregates open positions into gross / net exposure and per-symbol, per-sector and per-direction concentration, compares them with limits, and
 * says how much MORE notional could be added to a candidate trade before a limit is hit (`headroom`, never negative, never above what was asked). It can only shrink or refuse an addition; it never
 * recommends a larger one, never closes anything and approves nothing. It complements the existing portfolio-limit gate by providing the aggregate view and the headroom number.
 */
export const EXPOSURE_GOVERNOR_VERSION = "exposure-governor-v1";
export interface Position { symbol: string; sector: string | null; side: "BUY" | "SELL"; /** Absolute market value of the position. */ notional: number }
export interface ExposureLimits { capital: number; maxGrossPct: number; maxNetPct: number; maxSymbolPct: number; maxSectorPct: number; maxSameDirectionPct: number }
export const DEFAULT_EXPOSURE_LIMITS = (capital: number): ExposureLimits => ({ capital, maxGrossPct: 200, maxNetPct: 100, maxSymbolPct: 25, maxSectorPct: 40, maxSameDirectionPct: 150 });
export interface Candidate { symbol: string; sector: string | null; side: "BUY" | "SELL"; notional: number }
export interface Breach { limit: string; valuePct: number; limitPct: number }
export interface ExposureReport {
  version: typeof EXPOSURE_GOVERNOR_VERSION; grossPct: number; netPct: number; longPct: number; shortPct: number;
  bySymbolPct: Record<string, number>; bySectorPct: Record<string, number>; unclassifiedPct: number;
  breaches: Breach[]; /** Largest additional notional for the candidate that breaches no limit; 0 when already breached. Never above the candidate's notional. */ headroom: number | null;
  /** Candidate would be accepted as asked / only reduced / refused. */ candidateOutcome: "NO_CANDIDATE" | "FITS" | "REDUCE" | "REFUSE";
  grantsApproval: false; forcesExit: false;
}
export class ExposureInputError extends Error { constructor(m: string) { super(m); this.name = "ExposureInputError"; } }
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const bad = (x: number): boolean => !Number.isFinite(x) || x < 0;

export function assessExposure(positions: readonly Position[], limits: ExposureLimits, candidate: Candidate | null = null): ExposureReport {
  if (!(Number.isFinite(limits.capital) && limits.capital > 0)) throw new ExposureInputError("capital must be positive");
  for (const k of ["maxGrossPct", "maxNetPct", "maxSymbolPct", "maxSectorPct", "maxSameDirectionPct"] as const) if (!(Number.isFinite(limits[k]) && limits[k] > 0)) throw new ExposureInputError(`${k} must be positive`);
  for (const p of positions) if (bad(p.notional) || (p.side !== "BUY" && p.side !== "SELL")) throw new ExposureInputError("positions need a non-negative finite notional and a side");
  if (candidate && (bad(candidate.notional) || (candidate.side !== "BUY" && candidate.side !== "SELL"))) throw new ExposureInputError("candidate needs a non-negative finite notional and a side");
  const cap = limits.capital, pct = (x: number): number => r4((x / cap) * 100);
  const sum = (f: (p: Position) => boolean): number => positions.filter(f).reduce((a, p) => a + p.notional, 0);
  const long = sum((p) => p.side === "BUY"), short = sum((p) => p.side === "SELL");
  const bySym = new Map<string, number>(), bySec = new Map<string, number>();
  let unclassified = 0;
  for (const p of positions) { bySym.set(p.symbol, (bySym.get(p.symbol) ?? 0) + p.notional); if (p.sector === null) unclassified += p.notional; else bySec.set(p.sector, (bySec.get(p.sector) ?? 0) + p.notional); }
  const breaches: Breach[] = [];
  const check = (limit: string, value: number, lim: number): void => { if (value > lim) breaches.push({ limit, valuePct: r4(value), limitPct: lim }); };
  check("GROSS", pct(long + short), limits.maxGrossPct); check("NET", pct(Math.abs(long - short)), limits.maxNetPct);
  check("LONG", pct(long), limits.maxSameDirectionPct); check("SHORT", pct(short), limits.maxSameDirectionPct);
  for (const [s, v] of [...bySym].sort()) check(`SYMBOL:${s}`, pct(v), limits.maxSymbolPct);
  for (const [s, v] of [...bySec].sort()) check(`SECTOR:${s}`, pct(v), limits.maxSectorPct);

  let headroom: number | null = null, outcome: ExposureReport["candidateOutcome"] = "NO_CANDIDATE";
  if (candidate) {
    const room = (limitPct: number, current: number): number => Math.max(0, (limitPct / 100) * cap - current);
    const sameSide = candidate.side === "BUY" ? long : short, netNow = long - short, netSign = candidate.side === "BUY" ? 1 : -1;
    const caps = [
      room(limits.maxGrossPct, long + short), room(limits.maxSameDirectionPct, sameSide),
      room(limits.maxSymbolPct, bySym.get(candidate.symbol) ?? 0),
      // net limit: adding in the direction of the existing net uses room; adding against it frees room (still bounded by the other limits)
      netNow * netSign >= 0 ? room(limits.maxNetPct, Math.abs(netNow)) : (limits.maxNetPct / 100) * cap + Math.abs(netNow),
      ...(candidate.sector !== null ? [room(limits.maxSectorPct, bySec.get(candidate.sector) ?? 0)] : []),
    ];
    headroom = Math.floor(Math.min(candidate.notional, ...caps));
    outcome = headroom >= candidate.notional ? "FITS" : headroom > 0 ? "REDUCE" : "REFUSE";
  }
  return {
    version: EXPOSURE_GOVERNOR_VERSION, grossPct: pct(long + short), netPct: pct(long - short), longPct: pct(long), shortPct: pct(short),
    bySymbolPct: Object.fromEntries([...bySym].sort().map(([k, v]) => [k, pct(v)])), bySectorPct: Object.fromEntries([...bySec].sort().map(([k, v]) => [k, pct(v)])), unclassifiedPct: pct(unclassified),
    breaches, headroom, candidateOutcome: outcome, grantsApproval: false, forcesExit: false,
  };
}
