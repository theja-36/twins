import type { OptionsClaim } from "./options/types";
import type { ClassificationResult } from "./classification/types";

/**
 * Telegram claim -> candidate policy (Stage 03, G-19). PURE: no database, no clock, no randomness. Given a stored claim, the message facts, the revision state, the classification and the active candidates of the same channel,
 * it returns either a candidate DRAFT or a recorded reason why there is none. It decides nothing about trading: a candidate only enters the shared research queue, where research, stop-loss validation, risk, decision and approval still apply.
 * Hard rules (each has a reason code and a test):
 *  - only a parsed claim; never noise, an ambiguous or an unsupported message (the database also refuses it);
 *  - never an invented value: no entry, stop, target, expiry year, strike or option type is supplied here; a missing stop or target is listed as missing information, a missing instrument or entry condition is a refusal;
 *  - a contradictory claim (conflicting level basis, impossible level ordering, opposite view of the same underlying by the same channel) is not converted;
 *  - an edited message: only its CURRENT revision becomes a candidate, and it supersedes the candidate of the revision it replaces (version N+1);
 *  - an expired claim never enters research; an exact repeat of an active candidate is a duplicate, not a second candidate.
 */
export const TELEGRAM_CANDIDACY_POLICY_VERSION = "telegram-candidacy-v1";
export interface TelegramCandidacyConfig {
  policyVersion: string;
  /** How long after the message time a claim stays a valid opportunity. A measure of freshness, not of quality. */
  ttlMinutes: number;
  /** A message captured later than this after its timestamp is flagged DELAYED_CAPTURE (its validity still runs from the message time). */
  maxCaptureDelaySeconds: number;
  /** Opposite views of one underlying by one channel within this window contradict each other. */
  contradictionWindowMinutes: number;
  /** Forces the candidate data source (demo / tests). Null: LIVE for live capture, HISTORICAL for a history import. */
  forceDataSource: "FIXTURE" | "LIVE" | "HISTORICAL" | null;
}
export const DEFAULT_TELEGRAM_CANDIDACY: TelegramCandidacyConfig = { policyVersion: TELEGRAM_CANDIDACY_POLICY_VERSION, ttlMinutes: 90, maxCaptureDelaySeconds: 600, contradictionWindowMinutes: 30, forceDataSource: null };

export type RevisionStateInput = "current" | "superseded" | "ambiguous" | "unknown";
export interface CandidacyMessage { id: string; sourceId: string; externalMessageId: string; originMessageId: string | null; messageTimestamp: Date; receivedAt: Date; observedAt: Date | null; firstSeenEdited: boolean; captureMethod: string; editDate: Date | null }
/** An active candidate of the same channel, as far as the policy needs to know. */
export interface ActiveTelegramCandidate { id: string; claimId: string; originKey: string; underlying: string; strike: number | null; optionType: string | null; side: string; entryKind: string; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[]; view: "bullish" | "bearish" | "unresolved"; messageTimestamp: Date; candidateVersion: number }
export interface CandidacyInput { claimId: string; parserVersion: string; claim: OptionsClaim; message: CandidacyMessage; revision: RevisionStateInput; classification: ClassificationResult | null; now: Date; active: readonly ActiveTelegramCandidate[]; cfg: TelegramCandidacyConfig }

export interface TelegramCandidateDraft {
  claimId: string; underlying: string; exchange: "NSE" | "BSE"; strike: number; optionType: "CE" | "PE"; expiry: string | null; side: "BUY";
  entryKind: "above" | "below" | "at" | "range" | "market"; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[];
  setup: string | null; timeframe: string; classificationConfidence: number | null; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; expiresAt: Date;
  thesis: string; missingInformation: string[]; validationStatus: "UNVERIFIED"; candidateVersion: number;
  evidence: Array<{ kind: "telegram_claim"; claimId: string; messageId: string }>; provenance: Record<string, unknown>;
}
export type CandidacyDecision =
  | { outcome: "CREATED"; draft: TelegramCandidateDraft; supersedes: string[]; reasons: string[] }
  | { outcome: "DUPLICATE"; duplicateOf: string; reasons: string[] }
  | { outcome: "EXPIRED" | "SUPERSEDED_REVISION" | "INCOMPLETE" | "CONTRADICTORY" | "UNSUPPORTED"; reasons: string[]; detail: Record<string, unknown> };

export const originKeyOf = (m: Pick<CandidacyMessage, "sourceId" | "externalMessageId" | "originMessageId">): string => `${m.sourceId}:${m.originMessageId ?? m.externalMessageId.replace(/_edit.*$/, "")}`;
const NON_CONTRADICTION_ISSUES = new Set(["entry_missing", "stop_missing", "targets_missing"]);
const same = (a: number | null, b: number | null): boolean => (a === null && b === null) || (a !== null && b !== null && a === b);
const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const fmt = (n: number | null): string => (n === null ? "n/a" : String(n));
/** End of the stated expiry day in IST (15:30 IST market close), as an instant. Used only when the claim states a full, calendar-valid date. */
function expiryCloseUtc(y: number, m: number, d: number): Date { return new Date(Date.UTC(y, m - 1, d, 10, 0, 0)); } // 15:30 IST = 10:00 UTC
const stop = <T extends CandidacyDecision>(d: T): T => d;

export function evaluateTelegramClaim(i: CandidacyInput): CandidacyDecision {
  const { claim, message: m, cfg } = i;
  const bad = (outcome: "EXPIRED" | "SUPERSEDED_REVISION" | "INCOMPLETE" | "CONTRADICTORY" | "UNSUPPORTED", reasons: string[], detail: Record<string, unknown> = {}): CandidacyDecision => stop({ outcome, reasons, detail });

  if (i.revision === "superseded") return bad("SUPERSEDED_REVISION", ["REVISION_SUPERSEDED"], { note: "a later edit of this message replaces it" });
  if (i.revision === "ambiguous") return bad("INCOMPLETE", ["REVISION_AMBIGUOUS"], { note: "the edit order of this message cannot be established" });
  if (claim.action !== "buy" || claim.intent !== "long_entry_presumed") return bad("UNSUPPORTED", [claim.action === "sell" ? "SELL_INTENT_UNRESOLVED" : "ACTION_NOT_STATED"]);

  const incomplete: string[] = [];
  if (claim.optionTypeConflict) incomplete.push("OPTION_TYPE_CONFLICT"); else if (claim.optionType === null) incomplete.push("OPTION_TYPE_MISSING");
  if (claim.strike === null) incomplete.push("STRIKE_MISSING");
  if (claim.compactCodeUnrecognized) incomplete.push("CONTRACT_CODE_UNRECOGNIZED");
  if (claim.entry.type === "unspecified") incomplete.push("ENTRY_NOT_STATED"); else if (claim.entry.type === "near") incomplete.push("ENTRY_NEAR_UNSUPPORTED");
  if (incomplete.length) return bad("INCOMPLETE", incomplete);

  const contradictions: string[] = [];
  if (claim.levelBasisConflict) contradictions.push("LEVEL_BASIS_CONFLICT");
  for (const c of i.classification?.structureIssues ?? []) if (!NON_CONTRADICTION_ISSUES.has(c)) contradictions.push(`STRUCTURE_${c.toUpperCase()}`);
  if (contradictions.length) return bad("CONTRADICTORY", contradictions);

  // Validity: from the message time, never from the capture time; a full stated expiry date also ends it.
  let expiresAt = new Date(m.messageTimestamp.getTime() + cfg.ttlMinutes * 60_000), expiry: string | null = null;
  if (claim.expiry.status === "full") {
    const close = expiryCloseUtc(claim.expiry.year, claim.expiry.month, claim.expiry.day); expiry = `${claim.expiry.year}-${String(claim.expiry.month).padStart(2, "0")}-${String(claim.expiry.day).padStart(2, "0")}`;
    if (close.getTime() <= i.now.getTime()) return bad("EXPIRED", ["CONTRACT_EXPIRED"], { expiry });
    if (close.getTime() < expiresAt.getTime()) expiresAt = close;
  }
  if (expiresAt.getTime() <= i.now.getTime()) return bad("EXPIRED", ["CLAIM_VALIDITY_ELAPSED"], { messageTimestamp: m.messageTimestamp.toISOString(), ttlMinutes: cfg.ttlMinutes });

  const origin = originKeyOf(m), strike = claim.strike as number, optionType = claim.optionType as "CE" | "PE";
  const e = claim.entry; let entryKind: "above" | "below" | "at" | "range" | "market", entryLow: number | null, entryHigh: number | null;
  if (e.type === "range") { entryKind = "range"; entryLow = e.low; entryHigh = e.high; }
  else if (e.type === "market") { entryKind = "market"; entryLow = null; entryHigh = null; }
  else if (e.type === "at" || e.type === "above" || e.type === "below") { entryKind = e.type; entryLow = e.price; entryHigh = e.price; }
  else return bad("INCOMPLETE", ["ENTRY_NOT_STATED"]); // unreachable after the checks above; kept so no entry is ever invented
  const others = i.active.filter((a) => a.claimId !== i.claimId);
  const prior = others.filter((a) => a.originKey === origin);          // earlier revisions of THIS message
  const elsewhere = others.filter((a) => a.originKey !== origin);       // other messages of the channel
  const dup = elsewhere.find((a) => a.underlying === claim.underlying && same(a.strike, strike) && a.optionType === optionType && a.side === "BUY" && a.entryKind === entryKind && same(a.entryLow, entryLow) && same(a.entryHigh, entryHigh) && same(a.stopLoss, claim.stopLoss) && sameList(a.targets, claim.targets));
  if (dup) return { outcome: "DUPLICATE", duplicateOf: dup.id, reasons: ["REPEAT_OF_ACTIVE_CANDIDATE"] };
  const windowMs = cfg.contradictionWindowMinutes * 60_000;
  const opposed = elsewhere.find((a) => a.underlying === claim.underlying && a.view !== "unresolved" && claim.impliedUnderlyingView !== "unresolved" && a.view !== claim.impliedUnderlyingView && Math.abs(a.messageTimestamp.getTime() - m.messageTimestamp.getTime()) <= windowMs);
  if (opposed) return bad("CONTRADICTORY", ["CONTRADICTS_ACTIVE_CLAIM"], { conflictingCandidateId: opposed.id, conflictingView: opposed.view, thisView: claim.impliedUnderlyingView });

  const missing: string[] = ["contractVerification"]; // nothing here verified the contract against an exchange master: always stated
  if (claim.stopLoss === null) missing.push("stopLoss");
  if (claim.targets.length === 0) missing.push("targets");
  if (expiry === null) missing.push("expiry");
  if (claim.levelBasis === "unspecified") missing.push("levelBasis");
  const delaySeconds = Math.max(0, Math.round(((m.observedAt ?? m.receivedAt).getTime() - m.messageTimestamp.getTime()) / 1000));
  const flags: string[] = []; if (delaySeconds > cfg.maxCaptureDelaySeconds) flags.push("DELAYED_CAPTURE"); if (m.firstSeenEdited) flags.push("FIRST_SEEN_EDITED");
  const dataSource = cfg.forceDataSource ?? (m.captureMethod === "api_history" ? "HISTORICAL" : "LIVE");
  const entryText = entryKind === "range" ? `range ${fmt(entryLow)}-${fmt(entryHigh)}` : entryKind === "market" ? "market" : `${entryKind} ${fmt(entryLow)}`;
  const thesis = `The channel claims BUY ${claim.underlying} ${strike} ${optionType}; entry ${entryText}; stop-loss ${fmt(claim.stopLoss)}; targets ${claim.targets.length ? claim.targets.join(", ") : "n/a"}; levels quoted on the ${claim.levelBasis} basis. Unverified claim, not a recommendation.`;
  const classification = i.classification;
  return {
    outcome: "CREATED", reasons: flags, supersedes: prior.map((p) => p.id),
    draft: {
      claimId: i.claimId, underlying: claim.underlying, exchange: claim.underlying === "SENSEX" ? "BSE" : "NSE", strike, optionType, expiry, side: "BUY", entryKind, entryLow, entryHigh, stopLoss: claim.stopLoss, targets: [...claim.targets],
      setup: classification && classification.setup !== "UNKNOWN" ? classification.setup : null, timeframe: classification?.horizon ?? "UNKNOWN", classificationConfidence: classification?.confidence ?? null, dataSource, expiresAt, thesis, missingInformation: missing,
      validationStatus: "UNVERIFIED", candidateVersion: prior.reduce((v, p) => Math.max(v, p.candidateVersion), 0) + 1,
      evidence: [{ kind: "telegram_claim", claimId: i.claimId, messageId: m.id }],
      provenance: { source: "TELEGRAM", channelId: m.sourceId, messageId: m.id, originMessageId: m.originMessageId, revisionState: i.revision, messageTimestamp: m.messageTimestamp.toISOString(), capturedAt: (m.observedAt ?? m.receivedAt).toISOString(), captureMethod: m.captureMethod, captureDelaySeconds: delaySeconds, flags, parserVersion: i.parserVersion, classifierVersion: classification?.classifierVersion ?? null, policyVersion: cfg.policyVersion, impliedUnderlyingView: claim.impliedUnderlyingView },
    },
  };
}
export const viewOf = (claim: Pick<OptionsClaim, "impliedUnderlyingView">): ActiveTelegramCandidate["view"] => claim.impliedUnderlyingView;
