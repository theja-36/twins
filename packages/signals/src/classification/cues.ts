import type { Horizon, Setup } from "./types";

/**
 * Fixed whole-word cues. Plain pattern matching, never a model: a cue is evidence that a message USES a word, not that the trade is of that kind.
 * Words that also describe an entry condition (ABOVE, BELOW) or are too common are deliberately not cues.
 */
export const HORIZON_CUES: ReadonlyArray<{ horizon: Exclude<Horizon, "UNKNOWN">; code: string; re: RegExp }> = [
  { horizon: "INTRADAY", code: "cue.horizon.intraday", re: /\bINTRA\s?-?DAY\b/i },
  { horizon: "POSITIONAL", code: "cue.horizon.positional", re: /\b(POSITIONAL|SWING|BTST|STBT)\b/i },
  { horizon: "SCALPING", code: "cue.horizon.scalping", re: /\bSCALP(?:ING)?\b/i },
];
export const SETUP_CUES: ReadonlyArray<{ setup: Exclude<Setup, "OTHER" | "UNKNOWN">; code: string; re: RegExp }> = [
  { setup: "BREAKOUT", code: "cue.setup.breakout", re: /\bBREAK\s?-?OUT\b/i },
  { setup: "REVERSAL", code: "cue.setup.reversal", re: /\b(REVERSAL|TREND\s+REVERSAL)\b/i },
  { setup: "MOMENTUM", code: "cue.setup.momentum", re: /\bMOMENTUM\b/i },
  { setup: "GAP", code: "cue.setup.gap", re: /\bGAP\s?-?(UP|DOWN)\b/i },
  { setup: "SCALP", code: "cue.setup.scalp", re: /\bSCALP(?:ING)?\b/i },
];
/** Words of a trade UPDATE (an exit or a result about an earlier call) when the message gives no BUY/SELL action. */
export const UPDATE_CUE = /\b(BOOK(?:ED)?|EXIT|SL\s+HIT|TARGET\s+(?:HIT|DONE)|TRAIL(?:ING)?)\b/i;
