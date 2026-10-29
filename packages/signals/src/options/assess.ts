import { unavailablePremiumProvider, type OptionsPremiumProvider, type PremiumLookup } from "./premium";
import { unconfiguredContractMaster, type ContractVerification, type OptionsContractMaster } from "./master";
import { validateOptionsClaimStopLoss, type StopLossConfig, type StopLossValidation } from "@twins/stop-loss";
import type { OptionsClaim } from "./types";

export interface AssessmentReason {
  code: string;
  description: string;
  /** "reject" = the claim is provably malformed; "insufficient" = it cannot be verified or completed. */
  severity: "reject" | "insufficient";
}

/**
 * Result of assessing an options claim in this phase. APPROVE is structurally impossible: it needs a verified
 * contract AND option premium data, and no premium data source exists. `INSUFFICIENT_EVIDENCE` is the existing
 * equivalent of WAIT/UNVERIFIED; `REJECT` is only for provably inconsistent claims. No probability is produced.
 */
export interface OptionsAssessment {
  outcome: "INSUFFICIENT_EVIDENCE" | "REJECT";
  approvalPossible: false;
  reasons: AssessmentReason[];
  verification: ContractVerification;
  /** Premium-data lookup; only attempted when the contract was FOUND (verified). */
  premium: PremiumLookup;
  levelChecks: "applied" | "skipped";
  /** The mandatory stop-loss validation (shared rule, @twins/stop-loss). Only a VALID result lets a human APPROVE the claim in the review bot. */
  stopLoss: StopLossValidation;
}

const r = (code: string, description: string, severity: AssessmentReason["severity"] = "insufficient"): AssessmentReason => ({ code, description, severity });

/**
 * Level ordering is checked ONLY when its meaning is known: a stated level basis, a presumed long entry (BUY), and a
 * known direction of the quoted levels. Premium basis + BUY: levels rise (SL < entry < targets) for CE and PE alike
 * (a long premium position profits when the premium rises). Underlying basis: the direction follows the implied
 * underlying view (BUY CE bullish: rising; BUY PE bearish: falling) - the premium rule is NOT applied to underlying
 * levels. ABOVE/BELOW/NEAR/RANGE are entry CONDITIONS, never assumed fills.
 */
function checkLevels(c: OptionsClaim): { reasons: AssessmentReason[]; applied: boolean } {
  if (c.levelBasis === "unspecified" || c.intent !== "long_entry_presumed") return { reasons: [], applied: false };
  let rising: boolean;
  if (c.levelBasis === "premium") rising = true;
  else if (c.impliedUnderlyingView === "bullish") rising = true;
  else if (c.impliedUnderlyingView === "bearish") rising = false;
  else return { reasons: [r("levels.direction_unresolved", "underlying-level ordering cannot be checked without a CE/PE type")], applied: false };

  const reasons: AssessmentReason[] = [];
  const low = c.entry.type === "range" ? c.entry.low : "price" in c.entry ? c.entry.price : null;
  const high = c.entry.type === "range" ? c.entry.high : "price" in c.entry ? c.entry.price : null;
  const sign = rising ? 1 : -1;
  if (c.stopLoss !== null) {
    const stopOk = rising ? (low === null ? true : c.stopLoss < low) : high === null ? true : c.stopLoss > high;
    if (!stopOk) reasons.push(r("levels.stop_wrong_side", "the stop-loss is not on the losing side of the entry condition for this basis and direction", "reject"));
  }
  const ref = rising ? high : low;
  let previous = ref;
  for (const t of c.targets) {
    if (previous !== null && (t - previous) * sign <= 0) {
      reasons.push(r("levels.targets_inconsistent", "targets are not strictly progressing away from the entry condition in the profit direction", "reject"));
      break;
    }
    previous = t;
  }
  if (c.stopLoss !== null && c.targets.length > 0 && ref === null) {
    const first = c.targets[0];
    if (first !== undefined && (first - c.stopLoss) * sign <= 0) reasons.push(r("levels.stop_wrong_side", "the first target is not on the profit side of the stop-loss", "reject"));
  }
  return { reasons, applied: true };
}

export async function assessOptionsClaim(
  claim: OptionsClaim,
  master: OptionsContractMaster = unconfiguredContractMaster,
  premiumProvider: OptionsPremiumProvider = unavailablePremiumProvider,
  stopLossConfig?: StopLossConfig,
): Promise<OptionsAssessment> {
  const reasons: AssessmentReason[] = [];

  if (claim.action === null) reasons.push(r("action.missing", "no BUY/SELL action was stated"));
  if (claim.action === "sell") {
    reasons.push(r("action.sell_intent_unresolved", "SELL could be an exit of a long position or a fresh short; without position context the intent is unresolved"));
    reasons.push(r("entry.short_option_unsupported", "fresh short-option entry is not supported"));
  }
  if (claim.strike === null) reasons.push(r(claim.compactCodeUnrecognized ? "contract.compact_code_unrecognized" : "contract.strike_missing", claim.compactCodeUnrecognized ? "a compact contract code was present but cannot be decoded; nothing was guessed" : "no strike was stated"));
  if (claim.optionType === null) reasons.push(r(claim.optionTypeConflict ? "contract.option_type_conflict" : "contract.option_type_missing", claim.optionTypeConflict ? "both CE and PE were stated" : "no CE/PE was stated"));

  switch (claim.expiry.status) {
    case "missing": reasons.push(r("expiry.missing", "no expiry was stated")); break;
    case "period_word": reasons.push(r("expiry.period_word", `"${claim.expiry.word}" does not identify an expiry date; none was resolved`)); break;
    case "year_two_digit": reasons.push(r("expiry.year_two_digit_unresolved", `two-digit year "${claim.expiry.twoDigitYear}" left unresolved: no century policy exists, none was inferred`)); break;
    case "day_month": reasons.push(r("expiry.year_missing", "day and month were stated without a year; the year is not inferred")); break;
    case "year_dependent": reasons.push(r("expiry.year_dependent", "29 February without a year: whether the date exists depends on the year, left unresolved")); break;
    case "invalid": reasons.push(r("expiry.invalid_date", `impossible date: ${claim.expiry.reason}`, "reject")); break;
    case "full": break;
  }

  if (claim.levelBasis === "unspecified") {
    reasons.push(r(claim.levelBasisConflict ? "level_basis.conflict" : "level_basis.unspecified", claim.levelBasisConflict ? "both a premium and an underlying marker were stated" : "the message does not say whether the levels are option-premium or underlying levels; the values are preserved, not interpreted"));
  }
  if (claim.entry.type === "unspecified") reasons.push(r("levels.entry_missing", "no entry condition was stated"));
  if (claim.stopLoss === null) reasons.push(r("levels.stop_missing", "no stop-loss was stated"));
  if (claim.targets.length === 0) reasons.push(r("levels.targets_missing", "no target was stated"));

  const levels = checkLevels(claim);
  reasons.push(...levels.reasons);

  // Mandatory stop-loss (Stage 1 / Task 4): the shared rule. A missing or ambiguous stop-loss flags the claim (INSUFFICIENT_EVIDENCE, never approvable);
  // an invalid one (zero, negative, non-numeric, equal to the entry, wrong side, too far) rejects it. A VALID result adds no reason.
  const stopLoss = validateOptionsClaimStopLoss(claim, stopLossConfig);
  if (stopLoss.result !== "VALID" && stopLoss.reasonCode) {
    reasons.push(r(`stop_loss.${stopLoss.reasonCode.toLowerCase()}`, `mandatory stop-loss check failed: ${stopLoss.reasonCode}${stopLoss.detail ? ` (${stopLoss.detail})` : ""}`, stopLoss.result === "INVALID" ? "reject" : "insufficient"));
  }

  let verification: ContractVerification;
  if (claim.strike !== null && claim.optionType !== null && claim.expiry.status === "full") {
    verification = await master.lookup({ underlying: claim.underlying, strike: claim.strike, optionType: claim.optionType, expiry: claim.expiry });
  } else {
    verification = { status: "not_attempted", reason: "the claim does not yet name a complete contract (strike, CE/PE and a full expiry date)" };
  }
  switch (verification.status) {
    case "unconfigured": reasons.push(r("contract.master_unconfigured", "no verified instrument master is configured; the contract cannot be verified")); break;
    case "not_attempted": reasons.push(r("contract.unverified", verification.reason)); break;
    case "reference_empty": reasons.push(r("contract.manual_reference_empty", "MANUAL_REFERENCE_EMPTY: the manual verified reference has no entries yet; nothing was looked up and nothing fell back to sample data")); break;
    case "not_found": reasons.push(r("contract.not_found", "the master has no exact match for this contract (no nearest-expiry or fuzzy matching is done)")); break;
    case "ambiguous": reasons.push(r("contract.ambiguous", `the verified master returned ${verification.candidates} candidates`)); break;
    case "verified":
      if (verification.testFixture) reasons.push(r("contract.verified_by_test_fixture", "verified against an OFFLINE TEST FIXTURE master only; not an exchange verification"));
      else if (verification.reference?.kind === "manual_verified") {
        reasons.push(r("contract.found_in_manual_reference", `found in the manual verified reference (${verification.reference.version}); this is not live entitlement and does not prove current tradability`));
      } else if (verification.reference?.kind === "provider_snapshot") {
        reasons.push(r("contract.found_in_provider_snapshot", `PROVIDER-LISTED ONLY: found in an imported provider instrument snapshot (${verification.reference.version}, retrieved ${verification.reference.snapshot?.retrievedAt ?? "unknown"}); this is not exchange-independent verification, not live entitlement and not proof the contract is currently tradable`));
      } else if (verification.reference) {
        reasons.push(r("contract.found_in_local_reference", `found in a local reference (${verification.reference.version}${verification.reference.synthetic ? ", SYNTHETIC" : ""}); this is not live entitlement and not a guarantee the contract is currently tradable`));
      } else reasons.push(r("contract.verified", "verified against the configured master"));
      break;
  }

  if (master === unconfiguredContractMaster && verification.status !== "unconfigured") {
    reasons.push(r("contract.master_unconfigured", "no verified instrument master is configured; even a complete contract could not be verified"));
  }
  // Premium data is looked up ONLY for a FOUND contract, by the exact identity the reference matched.
  let premium: PremiumLookup;
  if (verification.status === "verified" && claim.strike !== null && claim.optionType !== null) {
    premium = await premiumProvider.lookup({ underlying: claim.underlying, strike: claim.strike, optionType: claim.optionType, expiryDate: verification.contract.expiryDate });
  } else {
    premium = { status: "not_attempted", reason: "the contract is not FOUND, so no premium data is looked up" };
  }
  // "option_premium_data.unavailable" ALWAYS stays: it means no VERIFIED LIVE premium data exists, and this system has no
  // such source. Sample data being present is reported separately and never removes it.
  reasons.push(r("option_premium_data.unavailable", "no verified live option premium data is available; the claim cannot be corroborated"));
  if (premium.status === "sample_quote") reasons.push(r("option_premium_data.sample_quote_present", `a ${premium.source.synthetic ? "SYNTHETIC " : ""}sample quote (${premium.source.version}) exists; it is not live market data and does not corroborate the claim`));
  else if (premium.status === "not_found") reasons.push(r("option_premium_data.sample_quote_not_found", "the premium data set has no exact match for this contract (no nearest-strike, nearest-expiry or interpolation)"));

  return {
    outcome: reasons.some((x) => x.severity === "reject") ? "REJECT" : "INSUFFICIENT_EVIDENCE",
    approvalPossible: false,
    reasons,
    verification,
    premium,
    levelChecks: levels.applied ? "applied" : "skipped",
    stopLoss,
  };
}
