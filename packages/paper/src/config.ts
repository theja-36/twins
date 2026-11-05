import { evaluateLiveGuard } from "@twins/config";
/**
 * PAPER trading configuration (Stage 6/7 build, paper only). Everything is OFF by default.
 *
 *   TWINS_PAPER_TRADING_ENABLED   true | false (default false). Only then does the worker run the paper cycle.
 *   TWINS_PAPER_SLIPPAGE_BPS      adverse slippage on simulated market-style fills (default 5, 0..200)
 *   TWINS_PAPER_ENTRY_EXPIRY_MIN  a pending entry that has not filled is cancelled after this many minutes (default 30, 1..1440)
 *   TWINS_PAPER_TRAIL             none | percent:<0.05..50> | points:<positive number>  (default percent:0.5)
 *   TWINS_PAPER_TRAIL_AFTER       number of targets that must be hit before the trailing stop starts (default 1, 0..3)
 *   TWINS_PAPER_BREAKEVEN         true | false: move the stop to the entry price once target 1 is hit (default true)
 *   TWINS_PAPER_EXIT_FRACTIONS    comma list of the share of the ORIGINAL quantity closed at target 1, 2, 3 (default 0.5,0.25,0.25; must sum to 1)
 *   TWINS_PAPER_SQUAREOFF_IST     HH:MM (IST) after which open paper trades are squared off and pending entries cancelled; empty = never (default 15:20)
 *   TWINS_PAPER_MAX_PRICE_AGE_SEC a price older than this is ignored (the trade is not stepped) (default 120, 5..3600)
 * A malformed value THROWS (fail closed). `assertPaperOnly` refuses to run when the shared live-trading guard fails or TRADING_MODE is not `paper`.
 */
export type TrailRule = { kind: "none" } | { kind: "percent"; value: number } | { kind: "points"; value: number };
export interface PaperConfig {
  enabled: boolean;
  slippageBps: number;
  entryExpiryMinutes: number;
  trail: TrailRule;
  trailAfterTargets: number;
  breakevenAfterTarget1: boolean;
  exitFractions: [number, number, number];
  maxPriceAgeSeconds: number;
  /** Minutes after midnight IST, or null for no automatic square-off. */
  squareOffIstMinutes: number | null;
}
export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  enabled: false, slippageBps: 5, entryExpiryMinutes: 30, trail: { kind: "percent", value: 0.5 }, trailAfterTargets: 1, breakevenAfterTarget1: true, exitFractions: [0.5, 0.25, 0.25], maxPriceAgeSeconds: 120, squareOffIstMinutes: 15 * 60 + 20,
};

const bad = (name: string): never => { throw new Error(`invalid paper trading setting: ${name}`); };
const num = (raw: string | undefined, name: string, def: number, min: number, max: number): number => {
  if (raw === undefined || raw === "") return def;
  if (!/^\d+(\.\d+)?$/.test(raw)) return bad(name);
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : bad(name);
};

export function loadPaperConfig(env: Record<string, string | undefined> = process.env): PaperConfig {
  const flag = (name: string, def: boolean): boolean => { const v = env[name]; if (v === undefined || v === "") return def; return v === "true" ? true : v === "false" ? false : bad(name); };
  let trail: TrailRule = DEFAULT_PAPER_CONFIG.trail;
  const t = env["TWINS_PAPER_TRAIL"];
  if (t !== undefined && t !== "") {
    if (t === "none") trail = { kind: "none" };
    else {
      const m = /^(percent|points):(\d+(?:\.\d+)?)$/.exec(t);
      if (!m) bad("TWINS_PAPER_TRAIL");
      const v = Number(m![2]);
      if (m![1] === "percent") trail = v >= 0.05 && v <= 50 ? { kind: "percent", value: v } : bad("TWINS_PAPER_TRAIL");
      else trail = v > 0 && v <= 1_000_000 ? { kind: "points", value: v } : bad("TWINS_PAPER_TRAIL");
    }
  }
  let exitFractions = DEFAULT_PAPER_CONFIG.exitFractions;
  const f = env["TWINS_PAPER_EXIT_FRACTIONS"];
  if (f !== undefined && f !== "") {
    const parts = f.split(",").map((x) => x.trim());
    if (parts.length !== 3 || parts.some((x) => !/^(0|1|0?\.\d+|1\.0+)$/.test(x))) bad("TWINS_PAPER_EXIT_FRACTIONS");
    const n = parts.map(Number) as [number, number, number];
    if (Math.abs(n[0] + n[1] + n[2] - 1) > 1e-9 || n.some((x) => x < 0 || x > 1)) bad("TWINS_PAPER_EXIT_FRACTIONS");
    exitFractions = n;
  }
  let squareOffIstMinutes: number | null = DEFAULT_PAPER_CONFIG.squareOffIstMinutes;
  const so = env["TWINS_PAPER_SQUAREOFF_IST"];
  if (so !== undefined) {
    if (so === "") squareOffIstMinutes = null;
    else { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(so); squareOffIstMinutes = m ? Number(m[1]) * 60 + Number(m[2]) : bad("TWINS_PAPER_SQUAREOFF_IST"); }
  }
  return {
    enabled: flag("TWINS_PAPER_TRADING_ENABLED", false),
    slippageBps: num(env["TWINS_PAPER_SLIPPAGE_BPS"], "TWINS_PAPER_SLIPPAGE_BPS", DEFAULT_PAPER_CONFIG.slippageBps, 0, 200),
    entryExpiryMinutes: num(env["TWINS_PAPER_ENTRY_EXPIRY_MIN"], "TWINS_PAPER_ENTRY_EXPIRY_MIN", DEFAULT_PAPER_CONFIG.entryExpiryMinutes, 1, 1440),
    trail,
    trailAfterTargets: Math.trunc(num(env["TWINS_PAPER_TRAIL_AFTER"], "TWINS_PAPER_TRAIL_AFTER", DEFAULT_PAPER_CONFIG.trailAfterTargets, 0, 3)),
    breakevenAfterTarget1: flag("TWINS_PAPER_BREAKEVEN", true),
    exitFractions,
    maxPriceAgeSeconds: num(env["TWINS_PAPER_MAX_PRICE_AGE_SEC"], "TWINS_PAPER_MAX_PRICE_AGE_SEC", DEFAULT_PAPER_CONFIG.maxPriceAgeSeconds, 5, 3600),
    squareOffIstMinutes,
  };
}

/** Paper execution is only ever allowed in paper mode with live trading off. Throws otherwise. */
export function assertPaperOnly(env: Record<string, string | undefined> = process.env): void {
  if (!evaluateLiveGuard(env).ok) throw new Error("paper trading refuses to run: the live-trading guard did not pass");
  const mode = env["TRADING_MODE"];
  if (mode !== undefined && mode !== "" && mode !== "paper") throw new Error("paper trading runs only with TRADING_MODE=paper");
}
