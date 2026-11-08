import { describe, expect, it } from "vitest";
import { DEFAULT_TELEGRAM_CANDIDACY, analyzeTelegramText, classifySignal, evaluateTelegramClaim, type CandidacyDecision } from "@twins/signals";

/**
 * Adversarial messages through the REAL parser, the REAL classifier and the candidacy policy (no hand-built claims): what a hostile or sloppy channel can send, and what each message may become.
 * This proves code-level behaviour on synthetic text. It says NOTHING about accuracy on real channel messages (M02-15 stays open).
 */
const T = new Date("2031-01-06T04:30:00Z"), NOW = new Date("2031-01-06T05:00:00Z");
type Out = { kind: string; decision?: CandidacyDecision };
function run(text: string, o: { now?: Date; capturedAfterSec?: number } = {}): Out {
  const a = analyzeTelegramText(text);
  if (a.kind !== "options_claim") return { kind: a.kind };
  const cl = classifySignal({ claim: a.claim, messageText: text, messageTimestamp: T });
  return { kind: "claim", decision: evaluateTelegramClaim({ claimId: "c", parserVersion: "p", claim: a.claim, message: { id: "m", sourceId: "s", externalMessageId: "1", originMessageId: "1", messageTimestamp: T, receivedAt: new Date(T.getTime() + (o.capturedAfterSec ?? 3) * 1000), observedAt: null, firstSeenEdited: false, captureMethod: "bot_webhook", editDate: null }, revision: "current", classification: cl, now: o.now ?? NOW, active: [], cfg: DEFAULT_TELEGRAM_CANDIDACY }) };
}
const verdict = (text: string, o?: Parameters<typeof run>[1]): string => { const r = run(text, o); return r.decision ? `${r.decision.outcome}${"reasons" in r.decision && r.decision.reasons.length ? `:${r.decision.reasons.join("+")}` : ""}` : `NO_CLAIM:${r.kind}`; };

describe("what each hostile or sloppy message may become", () => {
  it("a complete claim is a candidate; its basis being unstated is MISSING INFORMATION, not a contradiction", () => {
    const r = run("BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 140 165"); expect(r.decision?.outcome).toBe("CREATED");
    if (r.decision?.outcome === "CREATED") expect(r.decision.draft.missingInformation).toEqual(expect.arrayContaining(["contractVerification", "levelBasis", "expiry"]));
  });
  it("absence of entry, strike, targets or option type is incomplete, never invented, never a contradiction", () => {
    expect(verdict("BUY NIFTY 24500 CE SL 96 TGT 140")).toBe("INCOMPLETE:ENTRY_NOT_STATED");
    expect(verdict("BUY NIFTY CE ABOVE 118 SL 96")).toBe("INCOMPLETE:STRIKE_MISSING");
    expect(verdict("BUY NIFTY 24500 CE PE ABOVE 118")).toBe("INCOMPLETE:OPTION_TYPE_CONFLICT");
    expect(verdict("BUY NIFTY 24500 CE NEAR 118 SL 96")).toBe("INCOMPLETE:ENTRY_NEAR_UNSUPPORTED");
  });
  it("a stop-loss or targets with no targets are CREATED with the gap listed; nothing is defaulted", () => {
    const r = run("BUY NIFTY 24500 CE ABOVE 118"); expect(r.decision?.outcome).toBe("CREATED");
    if (r.decision?.outcome === "CREATED") { expect(r.decision.draft.stopLoss).toBeNull(); expect(r.decision.draft.targets).toEqual([]); expect(r.decision.draft.missingInformation).toEqual(expect.arrayContaining(["stopLoss", "targets"])); }
  });
  it("genuine self-contradictions are refused", () => {
    expect(verdict("BUY NIFTY 24500 CE ABOVE 118 SL 130 TGT 140")).toBe("CONTRADICTORY:STRUCTURE_STOP_NOT_BEYOND_ENTRY");
    expect(verdict("BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 165 140")).toBe("CONTRADICTORY:STRUCTURE_TARGETS_NOT_ORDERED");
    expect(verdict("BUY BANKNIFTY 52000 PE BELOW 210 SL 240 TGT 180")).toBe("CONTRADICTORY:STRUCTURE_STOP_NOT_BEYOND_ENTRY+STRUCTURE_TARGETS_NOT_BEYOND_ENTRY");
    expect(verdict("BUY NIFTY 24500 CE ABOVE 118 PREMIUM SL 24400 UNDERLYING")).toMatch(/^CONTRADICTORY:LEVEL_BASIS_CONFLICT/);
  });
  it("a SELL, an unsupported instrument, noise and a multi-directive message never become candidates", () => {
    expect(verdict("SELL NIFTY 24500 CE ABOVE 118")).toBe("UNSUPPORTED:SELL_INTENT_UNRESOLVED");
    expect(verdict("BUY RELIANCE 2500 CE ABOVE 50")).toBe("NO_CLAIM:options_unsupported");
    expect(verdict("hello how are you")).toBe("NO_CLAIM:none");
    expect(verdict("BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 140 BUY NIFTY 24400 PE")).toBe("NO_CLAIM:ambiguous");
  });
  it("a two-digit-year expiry is NOT turned into a date; a fully stated one is kept", () => {
    const a = run("BUY NIFTY 24500 CE 29-OCT-26 ABOVE 118 SL 96 TGT 140"), b = run("BUY NIFTY 24500 CE 06-JAN-2031 ABOVE 118 SL 96 TGT 140 160");
    expect(a.decision?.outcome === "CREATED" && a.decision.draft.expiry === null && a.decision.draft.missingInformation.includes("expiry")).toBe(true);
    expect(b.decision?.outcome === "CREATED" && b.decision.draft.expiry === "2031-01-06").toBe(true);
  });
  it("a delayed capture is flagged but never extends validity; an old message expires", () => {
    const d = run("BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 140", { capturedAfterSec: 1200 }).decision; expect(d?.outcome === "CREATED" && d.reasons.includes("DELAYED_CAPTURE")).toBe(true);
    expect(verdict("BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 140", { now: new Date(T.getTime() + 3 * 3600_000) })).toBe("EXPIRED:CLAIM_VALIDITY_ELAPSED");
  });
  it("odd formatting, lowercase and padding do not change the decision; garbage is not a claim", () => {
    expect(verdict("  buy   nifty 24500 ce   above 118  sl 96  tgt 140  ")).toBe(verdict("BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 140"));
    for (const junk of ["", "   ", "BUY", "NIFTY", "TGT 140 SL 96", "💥💥💥", "BUY NIFTY CE", "x".repeat(5000)]) expect(verdict(junk), JSON.stringify(junk.slice(0, 20))).not.toMatch(/^CREATED/); // never a candidate; some fragments are an incomplete claim, the rest are not claims at all
  });
});

describe("hard rules no score can override", () => {
  it("a contradictory claim stays refused whatever the classifier's confidence", () => {
    const a = analyzeTelegramText("BUY NIFTY 24500 CE ABOVE 118 SL 130 TGT 140"); if (a.kind !== "options_claim") throw new Error("setup");
    const cl = { ...classifySignal({ claim: a.claim, messageText: null, messageTimestamp: T }), confidence: 0.99 };
    const d = evaluateTelegramClaim({ claimId: "c", parserVersion: "p", claim: a.claim, message: { id: "m", sourceId: "s", externalMessageId: "1", originMessageId: "1", messageTimestamp: T, receivedAt: T, observedAt: null, firstSeenEdited: false, captureMethod: "bot_webhook", editDate: null }, revision: "current", classification: cl, now: NOW, active: [], cfg: DEFAULT_TELEGRAM_CANDIDACY });
    expect(d.outcome).toBe("CONTRADICTORY");
  });
  it("every candidate is UNVERIFIED and lists contract verification as missing: no Telegram claim arrives pre-qualified", () => {
    for (const m of ["BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 140 165", "BUY NIFTY 24500 CE ABOVE 118", "BUY NIFTY 24500 CE 06-JAN-2031 ABOVE 118 SL 96 TGT 140 160"]) {
      const d = run(m).decision; expect(d?.outcome).toBe("CREATED");
      if (d?.outcome === "CREATED") { expect(d.draft.validationStatus).toBe("UNVERIFIED"); expect(d.draft.missingInformation).toContain("contractVerification"); expect(Object.keys(d.draft)).not.toEqual(expect.arrayContaining(["permittedSize", "approval", "outcome", "decision", "lots", "quantity"])); }
    }
  });
});
