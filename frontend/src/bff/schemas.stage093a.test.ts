import { describe, expect, it } from "vitest";
import { CANDIDATE_VIEW_KEYS, CHANNEL_HEALTH_KEYS, SCAN_VIEW_KEYS } from "@twins/api-contracts";
import { ApprovalsResponse, CandidateDetailResponse, CandidateView, CandidatesResponse, ChannelsResponse, PositionsResponse, RELAY_RESPONSE_SCHEMAS, ResearchPackageResponse, ScansResponse, hasVerifiedSchema } from "./schemas";

const T = "2031-01-06T04:30:00.000Z", ID = "00000000-0000-4000-8000-000000000001";
const cand = { id: ID, source: "INDEPENDENT", state: "READY_FOR_DECISION", stateReason: null, supersededBy: null, underlying: "AAA", exchange: "NSE", setup: "BREAKOUT_LONG", side: "BUY", entryKind: "above", entryLow: 100, entryHigh: 101.5, stopLoss: 95, targets: [110, 120], strike: null, optionType: null, expiry: null, rankScore: 7.5, dataSource: "FIXTURE", createdAt: T, expiresAt: T, lastValidatedAt: null, researchAttempts: 1 };

describe("Stage 09.3A relay schemas", () => {
  it("the candidate schema declares exactly the contract's key set (so the parity test against the real route covers it)", () => {
    expect(Object.keys(CandidateView.shape).sort()).toEqual([...CANDIDATE_VIEW_KEYS].sort());
    expect(CandidateView.safeParse(cand).success).toBe(true);
  });
  it("the scan and channel-health schemas cover their contract keys (scan parameters are intentionally stripped)", () => {
    const scan = ScansResponse.shape.scans.element.shape, ch = ChannelsResponse.shape.channels.element.shape.health.shape;
    expect(Object.keys(ch).sort()).toEqual([...CHANNEL_HEALTH_KEYS].sort());
    expect(Object.keys(scan).sort()).toEqual(SCAN_VIEW_KEYS.filter((k) => k !== "parameters").sort());
  });
  it("undeclared fields are stripped: nothing extra reaches the browser", () => {
    const out = CandidatesResponse.parse({ state: "OK", note: "n", candidates: [{ ...cand, orderId: "x", quantity: 5, secret: "s" }] });
    expect(JSON.stringify(out)).not.toMatch(/orderId|quantity|secret/);
    expect(JSON.stringify(PositionsResponse.parse({ positions: [{ id: ID, accountId: ID, instrument: "A", exchange: "NSE", side: "BUY", quantity: "1", avgEntryPrice: "1", stopLoss: "1", realizedPnl: "0", status: "OPEN", openedAt: T, userId: "u", rules: { a: 1 } }] }))).not.toMatch(/userId|rules/);
    expect(JSON.stringify(ResearchPackageResponse.parse({ packageId: ID, candidateId: ID, version: 1, assessment: "X", haltReason: null, status: "READY", researchAttempts: 1, createdAt: T, package: { reports: ["agent text"] } }))).not.toMatch(/agent text/);
  });
  it("a wrong type is refused rather than coerced (a number price must stay a number)", () => {
    expect(CandidateView.safeParse({ ...cand, entryLow: "100" }).success).toBe(false); expect(CandidateView.safeParse({ ...cand, source: "BROKER" }).success).toBe(false);
    expect(CandidateView.safeParse({ ...cand, side: "HOLD" }).success).toBe(false); expect(CandidateView.safeParse({ ...cand, stopLoss: undefined }).success).toBe(false);
  });
  it("detail evidence is passed as data, capped, and the research envelope is required", () => {
    expect(CandidateDetailResponse.safeParse({ candidate: cand, lifecycle: [], evidence: [{ kind: "setup" }], research: { status: null, packageId: null, packageVersion: null, assessment: null } }).success).toBe(true);
    expect(CandidateDetailResponse.safeParse({ candidate: cand, lifecycle: [], evidence: [] }).success).toBe(false);
  });
  it("approvals keep the server's verdict fields and drop the rest", () => {
    const d = { id: ID, accountId: ID, candidateId: ID, outcome: "O", workflowState: "PENDING", validFrom: T, validUntil: T, createdAt: T, invalidated: null, permittedSize: { lots: 1 }, explanation: { x: 1 } };
    const out = ApprovalsResponse.parse({ pending: [{ ...d, expired: false, action: { available: true } }], history: [d] });
    expect(out.pending[0]?.action.available).toBe(true); expect(JSON.stringify(out)).not.toMatch(/permittedSize|explanation/);
    expect(ApprovalsResponse.safeParse({ pending: [d], history: [] }).success).toBe(false); // a pending item without the server's expired/action is refused, never guessed
  });
  it("every screen route has a verified schema (no pass-through)", () => {
    for (const id of ["opportunities.candidates", "opportunities.candidate", "opportunities.scans", "research.package", "intelligence.channels", "decisions.list", "approvals.list", "positions.list"]) { expect(hasVerifiedSchema(id), id).toBe(true); expect(RELAY_RESPONSE_SCHEMAS[id]).toBeDefined(); }
  });
});
