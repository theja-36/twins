/** Paper execution and trade-management settings. Both DISABLED by default; strict parsing (a malformed value throws at start-up). Live modes have no setting at all: they cannot be enabled from here. */
export interface ExecutionConfig { enabled: boolean; managementEnabled: boolean; maxPriceAgeSeconds: number; fillFraction: number; slippageBps: { entry: number; exit: number }; orderTtlMinutes: number; ladder: string[]; trailAfterR: string | null; sessionCloseExitMinutes: number | null }
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = { enabled: false, managementEnabled: false, maxPriceAgeSeconds: 60, fillFraction: 1, slippageBps: { entry: 5, exit: 5 }, orderTtlMinutes: 30, ladder: ["0.5"], trailAfterR: "1", sessionCloseExitMinutes: 15 * 60 + 15 };
export function loadExecutionConfig(env: Record<string, string | undefined> = process.env): ExecutionConfig {
  const d = DEFAULT_EXECUTION_CONFIG;
  const bool = (n: string): boolean => { const v = env[n]; if (v === undefined || v === "") return false; if (v === "true") return true; if (v === "false") return false; throw new Error(`${n} must be exactly "true" or "false"`); };
  const num = (n: string, def: number, lo: number, hi: number, int: boolean): number => { const v = env[n]; if (v === undefined || v === "") return def; const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi || (int && !Number.isInteger(x))) throw new Error(`${n} must be ${int ? "an integer" : "a number"} between ${lo} and ${hi}`); return x; };
  const frac = num("TWINS_PAPER_FILL_FRACTION", d.fillFraction, 0.01, 1, false);
  const ladderRaw = env["TWINS_EXIT_LADDER"]; const ladder = ladderRaw ? ladderRaw.split(",").map((x) => x.trim()) : d.ladder;
  for (const l of ladder) { const v = Number(l); if (!(v > 0 && v < 1)) throw new Error("TWINS_EXIT_LADDER entries must be fractions between 0 and 1 (exclusive)"); }
  if (ladder.reduce((a, b) => a + Number(b), 0) >= 1) throw new Error("TWINS_EXIT_LADDER fractions must add to less than 1 (the last target exits the rest)");
  return { enabled: bool("TWINS_EXECUTION_ENABLED"), managementEnabled: bool("TWINS_TRADE_MANAGEMENT_ENABLED"), maxPriceAgeSeconds: num("TWINS_EXEC_MAX_PRICE_AGE_SECONDS", d.maxPriceAgeSeconds, 1, 3600, true), fillFraction: frac,
    slippageBps: { entry: num("TWINS_PAPER_SLIPPAGE_ENTRY_BPS", d.slippageBps.entry, 0, 500, true), exit: num("TWINS_PAPER_SLIPPAGE_EXIT_BPS", d.slippageBps.exit, 0, 500, true) }, orderTtlMinutes: num("TWINS_PAPER_ORDER_TTL_MINUTES", d.orderTtlMinutes, 1, 1440, true), ladder,
    trailAfterR: env["TWINS_TRAIL_AFTER_R"] === "none" ? null : String(num("TWINS_TRAIL_AFTER_R", Number(d.trailAfterR), 0.1, 20, false)), sessionCloseExitMinutes: env["TWINS_SESSION_CLOSE_EXIT_MINUTES"] === "none" ? null : num("TWINS_SESSION_CLOSE_EXIT_MINUTES", d.sessionCloseExitMinutes as number, 540, 930, true) };
}
