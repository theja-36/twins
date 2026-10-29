import { DEFAULT_STOP_LOSS_CONFIG } from "./config";
import type { StopLossConfig, StopLossValidation } from "./types";
import { validateStopLoss } from "./validate";

/** The part of a parsed options claim the rule needs (structural, so this package depends on nothing). */
export interface OptionsClaimLike {
  action?: unknown;
  optionType?: unknown;
  stopLoss?: unknown;
  levelBasis?: unknown;
  entry?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Applies the shared rule to a parsed options claim (an index option: instrument type "option"; levels must be on the PREMIUM). */
export function validateOptionsClaimStopLoss(claim: unknown, config: StopLossConfig = DEFAULT_STOP_LOSS_CONFIG): StopLossValidation {
  const c: OptionsClaimLike = isRecord(claim) ? claim : {};
  const entry = isRecord(c.entry) ? c.entry : {};
  const type = entry["type"];
  const single = type === "at" || type === "above" || type === "below" || type === "near";
  return validateStopLoss(
    {
      instrumentType: "option",
      side: c.action,
      optionType: c.optionType,
      stopLoss: c.stopLoss,
      levelBasis: typeof c.levelBasis === "string" ? c.levelBasis : "unspecified",
      ...(single ? { entryPrice: entry["price"] } : type === "range" ? { entryLow: entry["low"], entryHigh: entry["high"] } : {}),
    },
    config,
  );
}
