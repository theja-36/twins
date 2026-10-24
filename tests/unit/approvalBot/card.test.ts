import { describe, expect, it } from "vitest";
import { renderClaimCard, renderExpired, renderOutcome, renderTestCard, ageText, clean, ttlText, type ClaimRow } from "../../../services/approval-bot/src/card";
import { claimJson, REASONS } from "../../support/approvalBotFakes";

const NOW = new Date("2026-10-26T04:00:00Z");
const ID = "7f3a1111-2222-4333-8444-555566667777";
const ctx = { label: "signal channel", now: NOW, ttlSeconds: 14400, cardId: ID };
const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  claimId: "c1", createdAt: NOW, parserVersion: "telegram-regex-v2", claim: claimJson(), reasons: REASONS, assessmentOutcome: "INSUFFICIENT_EVIDENCE",
  externalMessageId: "28956", messageTimestamp: new Date("2026-10-23T12:57:39Z"), ...over,
});

describe("claim card", () => {
  it("shows the parsed fields, the assessment and the reasons, and states that nothing is traded", () => {
    const { text } = renderClaimCard(row(), ctx);
    expect(text).toContain("TWINS claim 7F3A  |  UNVERIFIED  |  records your decision only - places NO order");
    expect(text).toContain("Source: signal channel - message 28956 - posted Fri 23 Oct 12:57Z (2 d 15 h ago)");
    expect(text).toContain("BUY (presumed long entry) NIFTY 24500 CE  |  expiry 29 OCT 2026");
    expect(text).toContain("Entry: above 120 | Stop: 90 | Targets: 150 | Levels refer to: premium");
    expect(text).toContain("Implied underlying view (informational only): bullish");
    expect(text).toContain("Assessment: INSUFFICIENT_EVIDENCE");
    expect(text).toContain(" - contract.master_unconfigured (insufficient): no verified instrument master is configured; the contract cannot be verified");
    expect(text).toContain("Parser: telegram-regex-v2 | card expires in 4 h");
    expect(text).toContain("Approve = your decision is recorded. Nothing is traded.");
  });
  it("is deterministic and its sha256 follows the text", () => {
    const a = renderClaimCard(row(), ctx);
    const b = renderClaimCard(row(), ctx);
    expect(a).toEqual(b);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(renderClaimCard(row({ parserVersion: "other-v3" }), ctx).sha256).not.toBe(a.sha256);
  });
  it("never uses the 'raw' fragments of the message or any other free text from the claim", () => {
    const claim = claimJson({
      expiry: { day: 29, month: 10, year: 2026, status: "full", raw: "RAWFRAGMENT-29-OCT-2026" },
      freeText: "PLEASE-BUY-NOW", note: "SECRET-CHANNEL-TEXT", underlying: "NIFTY",
    });
    const text = renderClaimCard(row({ claim }), ctx).text;
    for (const poison of ["RAWFRAGMENT", "PLEASE-BUY-NOW", "SECRET-CHANNEL-TEXT"]) expect(text).not.toContain(poison);
    // a non-allowlisted underlying or a hostile word cannot get through either
    expect(renderClaimCard(row({ claim: claimJson({ underlying: "<b>EVIL</b>" }) }), ctx).text).not.toContain("EVIL");
    expect(renderClaimCard(row({ claim: claimJson({ expiry: { status: "period_word", word: "<script>x" } }) }), ctx).text).toContain("a period word (unrecognised)");
    expect(renderClaimCard(row({ claim: claimJson({ expiry: { status: "period_word", word: "WEEKLY" } }) }), ctx).text).toContain("WEEKLY (period word, no date)");
  });
  it("renders the expiry statuses honestly (never inventing a year or century)", () => {
    const e = (expiry: unknown) => renderClaimCard(row({ claim: claimJson({ expiry }) }), ctx).text;
    expect(e({ status: "missing" })).toContain("expiry not stated");
    expect(e({ status: "day_month", day: 29, month: 10 })).toContain("expiry 29 OCT (year not stated)");
    expect(e({ status: "year_dependent", day: 29, month: 2 })).toContain("29 FEB (year not stated)");
    expect(e({ status: "year_two_digit", day: 29, month: 10, twoDigitYear: 26 })).toContain("29 OCT 26 (two-digit year, century unresolved)");
    expect(e({ status: "invalid", reason: "x", raw: "RAW" })).toContain("invalid or unreadable");
    expect(e({ status: "full", day: 40, month: 13, year: 2026 })).toContain("unreadable date");
    expect(e(null)).toContain("expiry not stated");
  });
  it("renders other claim shapes: sell, unresolved intent, range/market entries, conflict notes, no levels", () => {
    const c = (over: Record<string, unknown>) => renderClaimCard(row({ claim: claimJson(over) }), ctx).text;
    expect(c({ action: "sell", intent: "unresolved" })).toContain("SELL (unresolved: exit or fresh short?) NIFTY");
    expect(c({ intent: "unresolved" })).toContain("BUY (direction unresolved)");
    expect(c({ action: null })).toContain("No BUY/SELL stated NIFTY");
    expect(c({ entry: { type: "range", low: 120, high: 130 } })).toContain("Entry: 120-130");
    expect(c({ entry: { type: "market" } })).toContain("Entry: at market");
    expect(c({ entry: { type: "unspecified" }, stopLoss: null, targets: [], levelBasis: "unspecified" })).toContain("Entry: not stated | Stop: not stated | Targets: not stated | Levels refer to: not stated");
    expect(c({ targets: [150.456, 170, "x", null, 190, 200, 210, 220] })).toContain("Targets: 150.46, 170, 190, 200, 210 |");
    expect(c({ levelBasisConflict: true, optionTypeConflict: true, compactCodeUnrecognized: true })).toContain("Note: premium and underlying levels both present; both CE and PE mentioned; contract code not decoded");
    expect(c({ strike: null, optionType: null })).toContain("NIFTY  |  expiry");
    expect(c({ impliedUnderlyingView: "unresolved" })).not.toContain("Implied underlying view");
  });
  it("survives garbage claim data without throwing and without inventing fields", () => {
    for (const claim of [null, undefined, 5, "x", [], { underlying: 5, strike: "24500", targets: "no", entry: 7, expiry: [] }]) {
      const text = renderClaimCard(row({ claim, reasons: "nope" as unknown }), ctx).text;
      expect(text).toContain("UNVERIFIED");
      expect(text).toContain("unrecognised underlying");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
    }
  });
  it("sanitises reasons (control characters, markup is plain text, bad codes dropped) and caps the card length", () => {
    const text = renderClaimCard(row({ reasons: [{ code: "ok.code", severity: "warn", description: "line1\nline2\u0000  <b>bold</b> *star*" }, { code: "BAD CODE!", severity: "warn", description: "x" }, { code: "x", severity: "weird", description: "d" }, 5, null] }), ctx).text;
    expect(text).toContain(" - ok.code (warn): line1 line2 <b>bold</b> *star*"); // plain text: no parse mode, so markup characters are inert
    expect(text).toContain(" - x (info): d");
    expect(text).not.toContain("BAD CODE");
    const many = Array.from({ length: 80 }, (_, i) => ({ code: `reason.n${i}`, severity: "info", description: "d".repeat(110) }));
    const big = renderClaimCard(row({ reasons: many }), ctx).text;
    expect(big.length).toBeLessThanOrEqual(3500);
    expect(big).toContain("(+75 more reason codes)");
    expect(big).toContain("Approve = your decision is recorded");
  });
  it("shows revisions and sanitises ids, versions and outcomes", () => {
    expect(renderClaimCard(row({ externalMessageId: "28956_edit_1792760259_abcdef123456" }), ctx).text).toContain("message 28956 (edited revision)");
    expect(renderClaimCard(row({ externalMessageId: "evil\nid" }), ctx).text).toContain("message ?");
    expect(renderClaimCard(row({ parserVersion: "bad version\n" }), ctx).text).toContain("Parser: unknown");
    expect(renderClaimCard(row({ assessmentOutcome: "<x>" }), ctx).text).toContain("Assessment: not assessed");
    expect(renderClaimCard(row({ assessmentOutcome: null }), ctx).text).toContain("Assessment: not assessed");
  });
  it("helpers", () => {
    expect(ageText(new Date(NOW.getTime() - 5 * 60000), NOW)).toBe("5 min");
    expect(ageText(new Date(NOW.getTime() - 125 * 60000), NOW)).toBe("2 h 5 min");
    expect(ageText(new Date(NOW.getTime() - 50 * 3600000), NOW)).toBe("2 d 2 h");
    expect(ageText(new Date(NOW.getTime() + 60000), NOW)).toBe("0 min");
    expect(ttlText(14400)).toBe("4 h");
    expect(ttlText(5400)).toBe("90 min");
    expect(clean("a\u0000b\n c", 10)).toBe("a b c");
    expect(clean(5, 10)).toBe("");
  });
  it("test card, outcome and expiry texts are clearly labelled", () => {
    const t = renderTestCard(ctx);
    expect(t.text).toContain("HANDSHAKE TEST CARD 7F3A");
    expect(t.text).toContain("not a claim, involves no channel message and no order");
    expect(renderOutcome("CARD", "approve", NOW, false)).toBe("CARD\n\n>> APPROVED (recorded only - no order) at 04:00:00Z");
    expect(renderOutcome("CARD", "reject", NOW, true)).toBe("CARD\n\n>> TEST REJECTED (recorded) at 04:00:00Z");
    expect(renderExpired(ID)).toBe("TWINS card 7F3A expired - no decision was recorded.");
  });
});
