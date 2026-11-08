import { entryReference, reconstructContext } from "./context";
import { HORIZON_CUES, SETUP_CUES, UPDATE_CUE } from "./cues";
import { CLASSIFIER_VERSION, type ClassificationInput, type ClassificationResult, type ExitPattern, type Horizon, type RiskProfile, type Setup, type SignalType, type StructureIssue } from "./types";

/**
 * Risk-profile bands on stop distance (percent of the entry reference). A DESCRIPTIVE label of how wide the stated stop is, versioned with the classifier; it is not advice and is never used
 * to approve, size or qualify anything. Unknown stays UNKNOWN: a missing stop is not "aggressive", it is unknown (and the mandatory-stop rule blocks it elsewhere).
 */
export const RISK_BAND_PCT = { conservativeMax: 15, moderateMax: 30 } as const;

function cues<T extends { code: string; re: RegExp }>(list: readonly T[], text: string | null): T[] { return text === null ? [] : list.filter((c) => c.re.test(text)); }

export function classifySignal(input: ClassificationInput): ClassificationResult {
  const { claim, messageText, messageTimestamp } = input;
  const context = reconstructContext(claim, messageTimestamp);
  const codes: string[] = [];

  // signal type: from the parsed action; a message with no action but update wording is an UPDATE; otherwise unknown
  let signalType: SignalType = "UNKNOWN";
  if (claim.action === "buy") signalType = "OPTIONS_BUY"; else if (claim.action === "sell") signalType = "OPTIONS_SELL";
  else if (messageText !== null && UPDATE_CUE.test(messageText)) { signalType = "UPDATE"; codes.push("cue.type.update"); }
  if (claim.action !== null) codes.push(`parsed.action.${claim.action}`);

  // horizon and setup: only from explicit words; a conflict is reported, never resolved by guessing
  const h = cues(HORIZON_CUES, messageText); for (const c of h) codes.push(c.code);
  const horizons = [...new Set(h.map((c) => c.horizon))];
  const horizon: Horizon = horizons.length === 1 ? (horizons[0] as Horizon) : "UNKNOWN";
  if (horizons.length > 1) codes.push("conflict.horizon");
  const s = cues(SETUP_CUES, messageText); for (const c of s) codes.push(c.code);
  const setups = [...new Set(s.map((c) => c.setup))];
  // "SCALP" as a setup and "SCALPING" as a horizon are the same word; a lone scalp cue yields SCALP / SCALPING together
  const setup: Setup = setups.length === 0 ? "UNKNOWN" : setups.length === 1 ? (setups[0] as Setup) : "OTHER";
  if (setups.length > 1) codes.push("conflict.setup");

  // structure validation
  const issues: StructureIssue["code"][] = [];
  const ref = entryReference(claim); const long = claim.action !== "sell";
  if (claim.entry.type === "unspecified") issues.push("entry_missing");
  if (claim.stopLoss === null) issues.push("stop_missing");
  if (claim.targets.length === 0) issues.push("targets_missing");
  if (claim.entry.type === "range" && claim.entry.low > claim.entry.high) issues.push("range_inverted");
  if (ref !== null && claim.stopLoss !== null && (long ? claim.stopLoss >= ref : claim.stopLoss <= ref)) issues.push("stop_not_beyond_entry");
  if (ref !== null && claim.targets.some((t) => (long ? t <= ref : t >= ref))) issues.push("targets_not_beyond_entry");
  const ordered = claim.targets.every((t, i) => i === 0 || (long ? t > (claim.targets[i - 1] as number) : t < (claim.targets[i - 1] as number)));
  if (!ordered) issues.push("targets_not_ordered");
  if (claim.levelBasis === "unspecified" || claim.levelBasisConflict) issues.push("level_basis_unclear");
  if (claim.strike === null || claim.optionType === null) issues.push("option_contract_incomplete");
  for (const i of issues) codes.push(`structure.${i}`);

  // risk profile (descriptive): only when a stop distance is known and the basis is a premium reading
  let riskProfile: RiskProfile = "UNKNOWN";
  const pct = context.stopDistancePct;
  if (pct !== null && claim.levelBasis !== "underlying") riskProfile = pct <= RISK_BAND_PCT.conservativeMax ? "CONSERVATIVE" : pct <= RISK_BAND_PCT.moderateMax ? "MODERATE" : "AGGRESSIVE";
  if (riskProfile !== "UNKNOWN") codes.push(`risk.band.${riskProfile.toLowerCase()}`);

  const exitPattern: ExitPattern = { stopPresent: claim.stopLoss !== null, targetCount: claim.targets.length, targetsOrdered: ordered, rewardToRisk: context.rewardToRisk };
  // completeness of what was determined (five dimensions); NOT a probability
  const determined = [signalType !== "UNKNOWN", horizon !== "UNKNOWN", setup !== "UNKNOWN", claim.entry.type !== "unspecified", claim.stopLoss !== null].filter(Boolean).length;
  const structureValid = !issues.some((i) => i !== "level_basis_unclear" && i !== "option_contract_incomplete");
  return { classifierVersion: CLASSIFIER_VERSION, signalType, horizon, setup, riskProfile, entryCondition: context.entry, exitPattern, structureValid, structureIssues: issues, confidence: Math.round((determined / 5) * 100) / 100, evidenceCodes: codes, context };
}
