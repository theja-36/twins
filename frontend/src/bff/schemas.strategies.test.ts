import { describe, expect, it } from "vitest";
import { ComparablesRelay, DecisionDetailRelay, DecisionListRelay } from "./schemas.decisions";
import { PlaybookDetailRelay, PlaybookSummary, PlaybookVersion, PlaybooksRelay } from "./schemas.strategies";
import { relaySchemaFor } from "./schemas";

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = "2031-01-06T04:30:00.000Z";
const prov = { candidateId: ID(1), candidateSource: "INDEPENDENT", dataSource: "FIXTURE", researchPackageId: null, researchPackageSha256: null, confidenceAssessmentId: null, riskAssessmentId: null, simulationId: null };
const expl = { headline: "h", supporting: [], missing: [], contradictory: [], riskRestrictions: [], sizeRestriction: null, expiry: "e", reassess: [], invalidatedBy: [], reasons: [], restrictions: [], whatWouldChange: [], provenance: prov };
const dec = { id: ID(500), accountId: ID(2), candidateId: ID(1), outcome: "QUALIFIED", workflowState: "PENDING", explanation: expl, stopLossValidation: { ruleVersion: "v1", result: "VALID", reasonCode: null, detail: null, leaked: 1 }, permittedSize: { lots: 2, quantity: 100, maxLossAtStop: "1250.50", riskPerLot: "625.25", grossExposure: "10050.00", sizeMultiplier: 1, binding: "LOSS_CAP" }, evidenceRefs: [], versions: {}, validFrom: T, validUntil: T, supersedesId: null, createdAt: T, invalidated: null, simulationId: null, riskAssessmentId: null };
const clone = <X,>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

describe("decision relay schemas", () => {
  it("the list keeps identity, both vocabularies and the headline only; the explanation body, size and stop-loss never reach the list", () => {
    const r = DecisionListRelay.parse({ decisions: [dec] }).decisions[0]!; expect(Object.keys(r).sort()).toEqual(["accountId", "candidateId", "createdAt", "explanation", "id", "invalidated", "outcome", "supersedesId", "validFrom", "validUntil", "workflowState"]);
    expect(Object.keys(r.explanation)).toEqual(["headline"]);
  });
  it("the detail strips undeclared fields and keeps money as exact decimal STRINGS", () => {
    const d = DecisionDetailRelay.parse({ decision: dec, events: [], approval: null, watching: false, extra: 1 }); expect(d).not.toHaveProperty("extra");
    expect(d.decision.stopLossValidation).not.toHaveProperty("leaked"); expect(d.decision.permittedSize!.maxLossAtStop).toBe("1250.50"); expect(typeof d.decision.permittedSize!.grossExposure).toBe("string");
  });
  it("a null permitted size and a null stop-loss validation stay null (never zero)", () => { const d = DecisionDetailRelay.parse({ decision: { ...dec, permittedSize: null, stopLossValidation: null }, events: [], approval: null, watching: false }); expect(d.decision.permittedSize).toBeNull(); expect(d.decision.stopLossValidation).toBeNull(); });
  it("a contract break refuses the whole response: a numeric money value, an unknown workflow state, a missing explanation", () => {
    const bad = [{ ...dec, permittedSize: { ...dec.permittedSize, maxLossAtStop: 1250.5 } }, { ...dec, workflowState: "APPROVE_NOW" }, (() => { const x = clone(dec) as Record<string, unknown>; delete x["explanation"]; return x; })()];
    for (const b of bad) expect(DecisionDetailRelay.safeParse({ decision: b, events: [], approval: null, watching: false }).success).toBe(false);
  });
  it("comparables: AVAILABLE, NOT_AVAILABLE with a known reason (no patterns), and nothing else", () => {
    expect(ComparablesRelay.safeParse({ decisionId: ID(500), comparables: { state: "AVAILABLE", version: "v", verdict: "x", patterns: [], summary: "s", note: "n" } }).success).toBe(true);
    expect(ComparablesRelay.safeParse({ decisionId: ID(500), comparables: { state: "NOT_AVAILABLE", version: "v", reason: "NO_RESEARCH_PACKAGE", detail: "d", patterns: [] } }).success).toBe(true);
    expect(ComparablesRelay.safeParse({ decisionId: ID(500), comparables: { state: "NOT_AVAILABLE", version: "v", reason: "MADE_UP", detail: "d", patterns: [] } }).success).toBe(false);
    expect(ComparablesRelay.safeParse({ decisionId: ID(500), comparables: { state: "NOT_AVAILABLE", version: "v", reason: "NO_PATTERN_REPORT", detail: "d", patterns: ["fabricated"] } }).success).toBe(false);
  });
});

describe("playbook relay schemas", () => {
  const sum = { id: ID(700), sourceKind: "INDEPENDENT", telegramSourceId: null, name: "P", createdAt: T, versions: 1, activeVersion: null, latestVersion: 1 };
  it("the list is EMPTY or OK and declares only counts and dates", () => { expect(PlaybooksRelay.parse({ state: "EMPTY", playbooks: [] }).playbooks).toEqual([]); expect(Object.keys(PlaybooksRelay.parse({ state: "OK", playbooks: [{ ...sum, extra: 1 }] }).playbooks[0]!).sort()).toEqual(Object.keys(sum).sort()); });
  it("a version's unverified content and performance NEVER reach the browser; its lifecycle state must be a known one", () => {
    const v = { version: 1, state: "ACTIVE", sampleSize: 40, confidence: 0.6, limitations: "", createdAt: T, updatedAt: T, influencesLive: true, activatedAt: T, events: [], content: { secret: 1 }, performance: { winRate: 1 } };
    const d = PlaybookDetailRelay.parse({ playbook: sum, versions: [v], drift: [], note: "n" }); expect(d.versions[0]).not.toHaveProperty("content"); expect(d.versions[0]).not.toHaveProperty("performance");
    expect(PlaybookDetailRelay.safeParse({ playbook: sum, versions: [{ ...v, state: "LIVE_NOW" }], drift: [], note: "n" }).success).toBe(false);
  });
  it("the relay uses these schemas for the five routes (and not the pass-through object)", () => {
    for (const id of ["decisions.list", "decisions.get", "decisions.comparables", "intelligence.playbooks", "intelligence.playbook"]) expect(relaySchemaFor(id).safeParse({ unrelated: true }).success, id).toBe(false);
  });
});

describe("the playbook schemas declare exactly the keys the backend parity test proves (tests/unit/api-contracts/playbookParity.test.ts)", () => {
  it("summary, version (without content and performance), list and detail", () => {
    expect(Object.keys(PlaybookSummary.shape).sort()).toEqual(["activeVersion", "createdAt", "id", "latestVersion", "name", "sourceKind", "telegramSourceId", "versions"]);
    expect(Object.keys(PlaybookVersion.shape).sort()).toEqual(["activatedAt", "confidence", "createdAt", "events", "influencesLive", "limitations", "sampleSize", "state", "updatedAt", "version"]);
    expect(Object.keys(PlaybooksRelay.shape).sort()).toEqual(["playbooks", "state"]); expect(Object.keys(PlaybookDetailRelay.shape).sort()).toEqual(["drift", "note", "playbook", "versions"]);
  });
});
