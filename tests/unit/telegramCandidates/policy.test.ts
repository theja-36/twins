import { describe, expect, it } from "vitest";
import { assessChannelHealth, DEFAULT_TELEGRAM_CANDIDACY, evaluateTelegramClaim, originKeyOf, type ActiveTelegramCandidate, type CandidacyInput } from "@twins/signals";
import type { OptionsClaim } from "../../../packages/signals/src/options/types";
import type { ClassificationResult } from "../../../packages/signals/src/classification/types";

const NOW = new Date("2031-01-06T05:00:00Z"), MSG_AT = new Date("2031-01-06T04:30:00Z");
const claim = (o: Partial<OptionsClaim> = {}): OptionsClaim => ({ action: "buy", intent: "long_entry_presumed", underlying: "NIFTY", underlyingAliasUsed: false, strike: 24500, optionType: "CE", compactCodeUnrecognized: false, optionTypeConflict: false, expiry: { status: "missing" }, entry: { type: "above", price: 118 }, stopLoss: 96, targets: [140, 165], levelBasis: "premium", levelBasisConflict: false, impliedUnderlyingView: "bullish", ...o });
const msg = (o: Record<string, unknown> = {}) => ({ id: "m1", sourceId: "s1", externalMessageId: "100", originMessageId: "100", messageTimestamp: MSG_AT, receivedAt: new Date(MSG_AT.getTime() + 5000), observedAt: null, firstSeenEdited: false, captureMethod: "bot_webhook", editDate: null, ...o });
const cls = (o: Partial<ClassificationResult> = {}): ClassificationResult => ({ classifierVersion: "signal-classifier-v1", signalType: "OPTIONS_BUY", horizon: "INTRADAY", setup: "BREAKOUT", riskProfile: "UNKNOWN", entryCondition: { kind: "above", low: 118, high: 118, conditional: true }, exitPattern: { stopPresent: true, targetCount: 2, targetsOrdered: true, rewardToRisk: [1, 2] }, structureValid: true, structureIssues: [], confidence: 0.8, evidenceCodes: [], context: {} as never, ...o });
const input = (o: Partial<CandidacyInput> = {}): CandidacyInput => ({ claimId: "c1", parserVersion: "telegram-regex-v3", claim: claim(), message: msg(), revision: "current", classification: cls(), now: NOW, active: [], cfg: DEFAULT_TELEGRAM_CANDIDACY, ...o });
const active = (o: Partial<ActiveTelegramCandidate> = {}): ActiveTelegramCandidate => ({ id: "k0", claimId: "c0", originKey: "s1:99", underlying: "NIFTY", strike: 24500, optionType: "CE", side: "BUY", entryKind: "above", entryLow: 118, entryHigh: 118, stopLoss: 96, targets: [140, 165], view: "bullish", messageTimestamp: new Date(MSG_AT.getTime() - 60_000), candidateVersion: 1, ...o });

describe("a complete claim becomes a candidate draft", () => {
  it("carries every stated value, nothing invented, and its provenance", () => {
    const d = evaluateTelegramClaim(input());
    expect(d.outcome).toBe("CREATED"); if (d.outcome !== "CREATED") return;
    expect(d.draft).toMatchObject({ claimId: "c1", underlying: "NIFTY", exchange: "NSE", strike: 24500, optionType: "CE", side: "BUY", entryKind: "above", entryLow: 118, entryHigh: 118, stopLoss: 96, targets: [140, 165], setup: "BREAKOUT", timeframe: "INTRADAY", validationStatus: "UNVERIFIED", candidateVersion: 1, expiry: null, dataSource: "LIVE" });
    expect(d.draft.provenance).toMatchObject({ source: "TELEGRAM", channelId: "s1", messageId: "m1", originMessageId: "100", revisionState: "current", parserVersion: "telegram-regex-v3", classifierVersion: "signal-classifier-v1", policyVersion: "telegram-candidacy-v1", claimId: "c1" });
    expect(d.draft.evidence).toEqual([{ kind: "telegram_claim", claimId: "c1", messageId: "m1" }]);
    expect(d.draft.thesis).toMatch(/Unverified claim, not a recommendation/);
  });
  it("is deterministic: the same input gives the same decision", () => { expect(JSON.stringify(evaluateTelegramClaim(input()))).toBe(JSON.stringify(evaluateTelegramClaim(input()))); });
  it("a missing stop-loss, target, expiry and level basis are listed as missing, never filled in", () => {
    const d = evaluateTelegramClaim(input({ claim: claim({ stopLoss: null, targets: [], levelBasis: "unspecified" }) }));
    expect(d.outcome).toBe("CREATED"); if (d.outcome !== "CREATED") return;
    expect(d.draft.stopLoss).toBeNull(); expect(d.draft.targets).toEqual([]);
    expect(d.draft.missingInformation).toEqual(expect.arrayContaining(["contractVerification", "stopLoss", "targets", "expiry", "levelBasis"]));
  });
  it("a fully stated expiry date is kept; it ends validity at the contract's last close when that comes first", () => {
    const e = { status: "full" as const, day: 6, month: 1, year: 2031, raw: "06 JAN 2031" };
    const a = evaluateTelegramClaim(input({ claim: claim({ expiry: e }) }));
    expect(a.outcome === "CREATED" && a.draft.expiry === "2031-01-06" && a.draft.expiresAt.toISOString() === "2031-01-06T06:00:00.000Z" && !a.draft.missingInformation.includes("expiry")).toBe(true); // the 90-minute window ends first
    const late = new Date("2031-01-06T09:30:00Z"), b = evaluateTelegramClaim(input({ claim: claim({ expiry: e }), message: msg({ messageTimestamp: late, receivedAt: late }), now: new Date("2031-01-06T09:40:00Z") }));
    expect(b.outcome === "CREATED" && b.draft.expiresAt.toISOString() === "2031-01-06T10:00:00.000Z").toBe(true); // 15:30 IST close on the expiry day ends it first
  });
  it("a day-month expiry without a year is NOT turned into a date", () => {
    const d = evaluateTelegramClaim(input({ claim: claim({ expiry: { status: "day_month", day: 12, month: 11, raw: "12 NOV" } }) }));
    expect(d.outcome === "CREATED" && d.draft.expiry === null && d.draft.missingInformation.includes("expiry")).toBe(true);
  });
  it("maps an entry range and a market entry exactly; SENSEX is a BSE instrument", () => {
    const r = evaluateTelegramClaim(input({ claim: claim({ entry: { type: "range", low: 110, high: 120 } }) })); expect(r.outcome === "CREATED" && r.draft.entryKind === "range" && r.draft.entryLow === 110 && r.draft.entryHigh === 120).toBe(true);
    const m = evaluateTelegramClaim(input({ claim: claim({ entry: { type: "market" }, underlying: "SENSEX" }) })); expect(m.outcome === "CREATED" && m.draft.entryKind === "market" && m.draft.entryLow === null && m.draft.exchange === "BSE").toBe(true);
  });
  it("without a classification the setup is null and the timeframe UNKNOWN (nothing guessed)", () => {
    const d = evaluateTelegramClaim(input({ classification: null })); expect(d.outcome === "CREATED" && d.draft.setup === null && d.draft.timeframe === "UNKNOWN" && d.draft.classificationConfidence === null).toBe(true);
  });
  it("a history import is HISTORICAL; a forced source overrides (demo)", () => {
    expect((evaluateTelegramClaim(input({ message: msg({ captureMethod: "api_history" }) })) as { draft: { dataSource: string } }).draft.dataSource).toBe("HISTORICAL");
    expect((evaluateTelegramClaim(input({ cfg: { ...DEFAULT_TELEGRAM_CANDIDACY, forceDataSource: "FIXTURE" } })) as { draft: { dataSource: string } }).draft.dataSource).toBe("FIXTURE");
  });
  it("flags a delayed capture and a first-seen edit, without refusing", () => {
    const d = evaluateTelegramClaim(input({ message: msg({ receivedAt: new Date(MSG_AT.getTime() + 900_000), firstSeenEdited: true }) }));
    expect(d.outcome).toBe("CREATED"); if (d.outcome !== "CREATED") return; expect(d.reasons).toEqual(["DELAYED_CAPTURE", "FIRST_SEEN_EDITED"]); expect(d.draft.provenance["captureDelaySeconds"]).toBe(900);
  });
  it("carries no raw message text: only parsed values and codes", () => { expect(JSON.stringify(evaluateTelegramClaim(input()))).not.toMatch(/raw|SECRET/i); });
});

describe("refusals, each with a reason code (never a guess)", () => {
  const why = (i: Partial<CandidacyInput>) => { const d = evaluateTelegramClaim(input(i)); return d.outcome === "CREATED" || d.outcome === "DUPLICATE" ? [d.outcome] : [d.outcome, ...d.reasons]; };
  it("a SELL or an unstated action is unsupported", () => { expect(why({ claim: claim({ action: "sell", intent: "unresolved" }) })).toEqual(["UNSUPPORTED", "SELL_INTENT_UNRESOLVED"]); expect(why({ claim: claim({ action: null, intent: "unresolved" }) })).toEqual(["UNSUPPORTED", "ACTION_NOT_STATED"]); });
  it("an unidentified instrument is incomplete", () => {
    expect(why({ claim: claim({ strike: null }) })).toEqual(["INCOMPLETE", "STRIKE_MISSING"]);
    expect(why({ claim: claim({ optionType: null }) })).toEqual(["INCOMPLETE", "OPTION_TYPE_MISSING"]);
    expect(why({ claim: claim({ optionType: null, optionTypeConflict: true }) })).toEqual(["INCOMPLETE", "OPTION_TYPE_CONFLICT"]);
    expect(why({ claim: claim({ strike: null, compactCodeUnrecognized: true }) })).toEqual(["INCOMPLETE", "STRIKE_MISSING", "CONTRACT_CODE_UNRECOGNIZED"]);
  });
  it("an unstated or approximate entry is incomplete: 'market' is never assumed", () => { expect(why({ claim: claim({ entry: { type: "unspecified" } }) })).toEqual(["INCOMPLETE", "ENTRY_NOT_STATED"]); expect(why({ claim: claim({ entry: { type: "near", price: 118 } }) })).toEqual(["INCOMPLETE", "ENTRY_NEAR_UNSUPPORTED"]); });
  it("contradictory levels are refused", () => {
    expect(why({ claim: claim({ levelBasisConflict: true }) })).toEqual(["CONTRADICTORY", "LEVEL_BASIS_CONFLICT"]);
    expect(why({ classification: cls({ structureValid: false, structureIssues: ["stop_not_beyond_entry", "targets_not_ordered"] }) })).toEqual(["CONTRADICTORY", "STRUCTURE_STOP_NOT_BEYOND_ENTRY", "STRUCTURE_TARGETS_NOT_ORDERED"]);
    expect(why({ classification: cls({ structureIssues: ["stop_missing", "targets_missing", "entry_missing", "level_basis_unclear", "option_contract_incomplete"] }) })[0]).toBe("CREATED"); // absence is missing information, not a contradiction
    expect(why({ classification: cls({ structureIssues: ["range_inverted", "targets_not_beyond_entry"] }) })).toEqual(["CONTRADICTORY", "STRUCTURE_RANGE_INVERTED", "STRUCTURE_TARGETS_NOT_BEYOND_ENTRY"]);
  });
  it("an old claim does not enter research: validity runs from the MESSAGE time", () => {
    expect(why({ now: new Date(MSG_AT.getTime() + 91 * 60_000) })).toEqual(["EXPIRED", "CLAIM_VALIDITY_ELAPSED"]);
    expect(why({ now: new Date(MSG_AT.getTime() + 89 * 60_000) })[0]).toBe("CREATED");
    expect(why({ claim: claim({ expiry: { status: "full", day: 5, month: 1, year: 2031, raw: "05 JAN 2031" } }) })).toEqual(["EXPIRED", "CONTRACT_EXPIRED"]);
  });
  it("a late capture does not extend validity", () => { expect(why({ message: msg({ receivedAt: new Date(MSG_AT.getTime() + 80 * 60_000) }), now: new Date(MSG_AT.getTime() + 95 * 60_000) })[0]).toBe("EXPIRED"); });
});

describe("edited messages, repeats and contradictions", () => {
  it("only the CURRENT revision becomes a candidate; a superseded or ambiguous revision never does", () => {
    const sup = evaluateTelegramClaim(input({ revision: "superseded" })); expect(sup).toMatchObject({ outcome: "SUPERSEDED_REVISION", reasons: ["REVISION_SUPERSEDED"] });
    expect(evaluateTelegramClaim(input({ revision: "ambiguous" }))).toMatchObject({ outcome: "INCOMPLETE", reasons: ["REVISION_AMBIGUOUS"] });
  });
  it("an edit supersedes the candidate of the revision it replaces and becomes version N+1", () => {
    const earlier = active({ id: "k-old", originKey: originKeyOf({ sourceId: "s1", externalMessageId: "100", originMessageId: "100" }), candidateVersion: 2, stopLoss: 90 });
    const d = evaluateTelegramClaim(input({ message: msg({ externalMessageId: "100_edit_9", originMessageId: "100" }), active: [earlier] }));
    expect(d.outcome).toBe("CREATED"); if (d.outcome !== "CREATED") return; expect(d.supersedes).toEqual(["k-old"]); expect(d.draft.candidateVersion).toBe(3);
  });
  it("an exact repeat of an active candidate from another message is a DUPLICATE, not a second candidate", () => { expect(evaluateTelegramClaim(input({ active: [active()] }))).toEqual({ outcome: "DUPLICATE", duplicateOf: "k0", reasons: ["REPEAT_OF_ACTIVE_CANDIDATE"] }); });
  it("a changed level from another message is not a duplicate", () => { expect(evaluateTelegramClaim(input({ active: [active({ stopLoss: 90 })] })).outcome).toBe("CREATED"); });
  it("the opposite view of the same underlying by the same channel within the window is held as CONTRADICTORY", () => {
    const d = evaluateTelegramClaim(input({ claim: claim({ optionType: "PE", impliedUnderlyingView: "bearish" }), active: [active()] }));
    expect(d).toMatchObject({ outcome: "CONTRADICTORY", reasons: ["CONTRADICTS_ACTIVE_CLAIM"], detail: { conflictingCandidateId: "k0" } });
  });
  it("the opposite view outside the window, on another underlying, or when unresolved is not a contradiction", () => {
    const pe = claim({ optionType: "PE", impliedUnderlyingView: "bearish" });
    expect(evaluateTelegramClaim(input({ claim: pe, active: [active({ messageTimestamp: new Date(MSG_AT.getTime() - 31 * 60_000) })] })).outcome).toBe("CREATED");
    expect(evaluateTelegramClaim(input({ claim: claim({ underlying: "BANKNIFTY", optionType: "PE", impliedUnderlyingView: "bearish" }), active: [active()] })).outcome).toBe("CREATED");
    expect(evaluateTelegramClaim(input({ claim: claim({ optionType: "PE", impliedUnderlyingView: "unresolved" }), active: [active()] })).outcome).toBe("CREATED");
  });
  it("the same claim is never its own duplicate or contradiction", () => { expect(evaluateTelegramClaim(input({ active: [active({ claimId: "c1" })] })).outcome).toBe("CREATED"); });
});

describe("channel health, timeliness and the reliability boundary", () => {
  const H = (o: Partial<Parameters<typeof assessChannelHealth>[0]> = {}) => assessChannelHealth({ lastMessageAt: new Date(NOW.getTime() - 60_000), messages24h: 10, delayedShare24h: 0, medianCaptureDelaySeconds24h: 3, now: NOW, ...o });
  it("grades silence: active, quiet, stale, silent, no data", () => {
    expect(H().status).toBe("ACTIVE"); expect(H({ lastMessageAt: new Date(NOW.getTime() - 3 * 3600_000) }).status).toBe("QUIET");
    expect(H({ lastMessageAt: new Date(NOW.getTime() - 30 * 3600_000) }).status).toBe("STALE"); expect(H({ lastMessageAt: new Date(NOW.getTime() - 9 * 86_400_000) }).status).toBe("SILENT");
    expect(H({ lastMessageAt: null, messages24h: 0, delayedShare24h: null, medianCaptureDelaySeconds24h: null })).toMatchObject({ status: "NO_DATA", capture: "NO_DATA", lastMessageAgeSeconds: null });
  });
  it("flags delayed capture by share or median", () => { expect(H({ delayedShare24h: 0.5 }).capture).toBe("DELAYED"); expect(H({ medianCaptureDelaySeconds24h: 900 }).capture).toBe("DELAYED"); expect(H().capture).toBe("TIMELY"); });
  it("never claims a reliability it cannot know", () => { expect(H().reliability).toBe("NOT_AVAILABLE"); });
});
