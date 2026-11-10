import { describe, expect, it } from "vitest";
import {
  buildResearchPackage, candidateToAgentInputs, createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, mapOptionsFindings, mapOptionsRisk, onTickGrid, orchestrate, OPTIONS_RISK_MAPPING_VERSION, roleOfAgent, runCandidateResearch,
  SPEC_ROLES, supplementsOf, toSpecAgentReport, type AgentRunResult, type ContractFacts, type ResearchCandidate, type ResearchPackageSink, type MappingInput,
} from "../../../packages/agents/src/index";

/** SYNTHETIC candidates and contracts only: no real instrument master or market data exists in this repository. These tests pin the mapping rules, not any real contract's lot or tick size. */
const NOW = new Date("2026-11-09T04:30:00Z");
const cand = (o: Partial<ResearchCandidate> = {}): ResearchCandidate => ({ id: "aaaaaaaa-1111-4111-8111-111111111111", source: "TELEGRAM", underlying: "NIFTY", exchange: "NSE", strike: 24500, optionType: "CE", expiry: "2026-11-27", side: "BUY", entryKind: "at", entryLow: 120, entryHigh: null, stopLoss: 90, targets: [150, 180], dataSource: "FIXTURE", createdAt: new Date("2026-11-09T04:25:00Z"), ...o });
const contract = (o: Partial<ContractFacts> = {}): ContractFacts => ({ canonicalId: "ctr_test", exchange: "NSE", underlying: "NIFTY", expiryDate: "2026-11-27", strike: "24500", optionType: "CE", lotSize: 75, tickSize: "0.05", tickSizeUnit: "RUPEES", effectiveFrom: "2026-01-01", effectiveTo: null, validation: "MANUAL_VERIFIED", provenance: { source: "manual-test", retrievedAt: "2026-11-01T00:00:00Z" }, ...o });
const map = (c: Partial<ResearchCandidate> = {}, o: Partial<MappingInput> = {}) => mapOptionsRisk({ candidate: cand(c), now: NOW, ...o });
const fresh = { asOf: "2026-11-09T04:29:00Z" };

describe("what the mapping is about", () => {
  it("a candidate that is not an option is NOT_APPLICABLE and says so", () => { expect(map({ strike: null, optionType: null, expiry: null })).toMatchObject({ status: "NOT_APPLICABLE", reasons: ["NOT_AN_OPTION"] }); });
  it("carries its version, its category, its as-of (the supplied clock) and the two roles it supplements", () => {
    const m = map(); expect(m).toMatchObject({ mappingVersion: OPTIONS_RISK_MAPPING_VERSION, category: "OPTIONS_MARKET_LIQUIDITY_RISK", asOf: NOW.toISOString(), supplementsRoles: ["MARKET_CONTEXT", "LIQUIDITY"] });
  });
  it("is deterministic: the same input gives the same output", () => { expect(JSON.stringify(map({}, { contract: contract() }))).toBe(JSON.stringify(map({}, { contract: contract() }))); });
});
describe("identity of the claimed contract: each defect is named, nothing is inferred", () => {
  it("missing parts are REFUSED with their own reason", () => {
    expect(map({ expiry: null })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["EXPIRY_MISSING"]) });
    expect(map({ strike: null })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["STRIKE_MISSING"]) });
    expect(map({ optionType: null })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["OPTION_TYPE_MISSING"]) });
    expect(map({ underlying: "" })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["UNDERLYING_MISSING"]) });
    expect(map({ underlying: "UNKNOWN" })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["UNDERLYING_MISSING"]) });
    expect(map({ exchange: " " })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["EXCHANGE_MISSING"]) });
  });
  it("an impossible date or strike is refused, not repaired", () => {
    expect(map({ expiry: "2026-02-30" })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["EXPIRY_INVALID"]), elements: { expiry: "CONTRADICTORY" } });
    expect(map({ expiry: "27-11-2026" }).reasons).toContain("EXPIRY_INVALID");
    expect(map({ strike: -5 })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["STRIKE_INVALID"]) });
    expect(map({ strike: Number.NaN }).reasons).toContain("STRIKE_INVALID");
  });
  it("an expired contract is refused (the expiry day itself is still live)", () => {
    expect(map({ expiry: "2026-11-08" })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["OPTION_EXPIRED"]), elements: { expiry: "STALE" } });
    expect(map({ expiry: "2026-11-09" }).reasons).not.toContain("OPTION_EXPIRED");
  });
  it("an unsupported underlying is refused only when a supported list is given", () => {
    expect(map({ underlying: "ACME" }, { supportedUnderlyings: ["NIFTY", "BANKNIFTY"] })).toMatchObject({ status: "REFUSED", underlying: { supported: false }, reasons: expect.arrayContaining(["UNDERLYING_UNSUPPORTED"]) });
    expect(map({}, { supportedUnderlyings: ["NIFTY"] }).underlying.supported).toBe(true);
    expect(map({ underlying: "ACME" }).underlying.supported).toBeNull();
  });
});
describe("contract facts: never inferred, always from a record that matches and is in force", () => {
  it("with no contract master the mapping is UNVERIFIED and lot and tick size are absent, never defaulted", () => {
    const m = map(); expect(m).toMatchObject({ status: "MAPPED_UNVERIFIED", reasons: expect.arrayContaining(["CONTRACT_MASTER_UNAVAILABLE"]), contract: { lotSize: null, tickSize: null, canonicalId: null }, elements: { lotSize: "MISSING", tickSize: "MISSING" } });
  });
  it("a manually or exchange verified matching record in force gives MAPPED_VERIFIED with its lot and tick", () => {
    for (const v of ["MANUAL_VERIFIED", "EXCHANGE_VERIFIED"] as const) expect(map({}, { contract: contract({ validation: v }) })).toMatchObject({ status: "MAPPED_VERIFIED", contract: { lotSize: 75, tickSize: "0.05", canonicalId: "ctr_test" }, elements: { lotSize: "OK", tickSize: "OK", identity: "OK" } });
  });
  it("a provider-listed, synthetic or unverified record maps but is UNVERIFIED, with its own reason", () => {
    expect(map({}, { contract: contract({ validation: "PROVIDER_LISTED" }) })).toMatchObject({ status: "MAPPED_UNVERIFIED", reasons: expect.arrayContaining(["CONTRACT_PROVIDER_LISTED_ONLY"]), elements: { lotSize: "UNVERIFIED" } });
    expect(map({}, { contract: contract({ validation: "SYNTHETIC" }) }).reasons).toContain("CONTRACT_SYNTHETIC");
    expect(map({}, { contract: contract({ validation: "UNVERIFIED" }) }).reasons).toContain("CONTRACT_UNVERIFIED");
  });
  it("a record for a DIFFERENT contract is a contradiction: refused, and its lot and tick are not used", () => {
    for (const other of [{ strike: "24550" }, { expiryDate: "2026-12-25" }, { optionType: "PE" as const }, { underlying: "BANKNIFTY" }, { exchange: "BSE" }]) {
      expect(map({}, { contract: contract(other) }), JSON.stringify(other)).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["CONTRACT_MISMATCH"]), elements: { identity: "CONTRADICTORY" }, contract: { lotSize: null, tickSize: null } });
    }
  });
  it("a record not in force at the as-of date is refused (effective-from inclusive, effective-to exclusive)", () => {
    expect(map({}, { contract: contract({ effectiveFrom: "2026-11-10" }) })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["CONTRACT_NOT_IN_FORCE"]), elements: { identity: "STALE" } });
    expect(map({}, { contract: contract({ effectiveTo: "2026-11-09" }) }).status).toBe("REFUSED");
    expect(map({}, { contract: contract({ effectiveFrom: "2026-11-09", effectiveTo: "2026-11-10" }) }).status).toBe("MAPPED_VERIFIED");
  });
  it("an invalid lot size is refused; a missing tick size is reported and nothing is checked against a grid", () => {
    expect(map({}, { contract: contract({ lotSize: 0 }) })).toMatchObject({ status: "REFUSED", reasons: expect.arrayContaining(["CONTRACT_LOT_SIZE_INVALID"]), contract: { lotSize: null } });
    expect(map({}, { contract: contract({ lotSize: 7.5 }) }).status).toBe("REFUSED");
    expect(map({}, { contract: contract({ tickSize: null }) })).toMatchObject({ status: "MAPPED_UNVERIFIED", reasons: expect.arrayContaining(["TICK_SIZE_MISSING"]), tickAlignment: { checked: false } });
  });
});
describe("tick grid (exact decimal arithmetic)", () => {
  it("decides alignment without floating-point error", () => {
    expect(onTickGrid(100.05, "0.05")).toBe(true); expect(onTickGrid(100.07, "0.05")).toBe(false); expect(onTickGrid(0.3, "0.1")).toBe(true); expect(onTickGrid(120, "0.05")).toBe(true); expect(onTickGrid(120.1, "0.5")).toBe(false);
  });
  it("is undecided, not wrong, for a malformed price or tick", () => { expect(onTickGrid(1e-9, "0.05")).toBeNull(); expect(onTickGrid(-1, "0.05")).toBeNull(); expect(onTickGrid(100, "abc")).toBeNull(); expect(onTickGrid(100, "0")).toBeNull(); });
  it("names each misaligned level and does not correct it", () => {
    const m = map({ entryLow: 120.03, stopLoss: 90.05, targets: [150, 180.02] }, { contract: contract() });
    expect(m.tickAlignment).toEqual({ checked: true, offGrid: ["entryLow", "target2"] }); expect(m.reasons).toContain("PRICE_OFF_TICK_GRID"); expect(m.status).toBe("MAPPED_VERIFIED"); // a flag, not a refusal
  });
});
describe("market data behind the risk assessment: labelled, never filled in", () => {
  it("missing, stale and future-dated quotes carry their own reasons; fresh ones are OK", () => {
    expect(map().elements).toMatchObject({ underlyingPrice: "MISSING", optionQuote: "MISSING", greeks: "MISSING" });
    const ok = map({}, { underlyingQuote: fresh, optionQuote: { ...fresh, greeks: { delta: 0.5 } } }); expect(ok.elements).toMatchObject({ underlyingPrice: "OK", optionQuote: "OK", greeks: "OK" }); expect(ok.reasons).not.toContain("GREEKS_NOT_SUPPLIED");
    const stale = map({}, { underlyingQuote: { asOf: "2026-11-09T03:00:00Z" }, optionQuote: { asOf: "2026-11-09T03:00:00Z" } }); expect(stale.reasons).toEqual(expect.arrayContaining(["UNDERLYING_PRICE_STALE", "OPTION_QUOTE_STALE"])); expect(stale.elements.optionQuote).toBe("STALE");
    const future = map({}, { underlyingQuote: { asOf: "2026-11-09T05:30:00Z" }, optionQuote: { asOf: "2026-11-09T05:30:00Z" } }); expect(future.reasons).toEqual(expect.arrayContaining(["UNDERLYING_PRICE_FUTURE_DATED", "OPTION_QUOTE_FUTURE_DATED"])); expect(future.elements.underlyingPrice).toBe("CONTRADICTORY");
    expect(map({}, { underlyingQuote: { asOf: null } }).elements.underlyingPrice).toBe("MISSING");
  });
  it("a bar within the future tolerance is not called future-dated; the limits are configurable", () => {
    expect(map({}, { underlyingQuote: { asOf: "2026-11-09T04:31:00Z" } }).elements.underlyingPrice).toBe("OK");
    expect(map({}, { underlyingQuote: { asOf: "2026-11-09T04:20:00Z" }, maxQuoteAgeMs: 60_000 }).elements.underlyingPrice).toBe("STALE");
  });
  it("Greeks are never computed by the mapping: absent input means MISSING", () => { expect(map({}, { optionQuote: fresh }).elements.greeks).toBe("MISSING"); });
});
describe("risk context: the options-risk specialist's findings grouped by category", () => {
  const res = (o: Partial<AgentRunResult> & { codes?: Array<[string, string]> }): AgentRunResult => ({ agentId: "options-risk-v1", agentVersion: "1.0.0", status: "COMPLETED", verdict: "CAUTION", confidence: 60, findings: (o.codes ?? []).map(([code, severity]) => ({ code, severity, summary: "x" }) as never), evidence: [], inputSnapshotRef: "x", inputSnapshot: {}, outputSnapshot: {}, startedAt: NOW, completedAt: NOW, durationMs: 1, attempts: 1, errorCode: null, errorMessage: null, ...o }) as AgentRunResult;
  it("groups market, liquidity and contract risk; INFO is not a risk; unknown codes are reported, not dropped", () => {
    const c = mapOptionsFindings(res({ codes: [["IV_HIGH", "ADVERSE"], ["THETA_DECAY_HIGH", "ADVERSE"], ["PREMIUM_SPREAD_WIDE", "ADVERSE"], ["OPEN_INTEREST_LOW", "CAUTION"], ["STRIKE_NOT_IN_CHAIN", "CAUTION"], ["EXPIRY_DISTANT", "INFO"], ["SOMETHING_NEW", "CAUTION"], ["IV_HIGH", "ADVERSE"]] }));
    expect(c).toMatchObject({ marketRisk: ["IV_HIGH", "THETA_DECAY_HIGH"], liquidityRisk: ["OPEN_INTEREST_LOW", "PREMIUM_SPREAD_WIDE"], contractRisk: ["STRIKE_NOT_IN_CHAIN"], unclassified: ["SOMETHING_NEW"] });
  });
  it("a result that did not complete maps to empty lists and keeps its status: absence is never read as no risk", () => {
    for (const status of ["FAILED", "TIMEOUT", "SKIPPED", "UNAVAILABLE"] as const) expect(mapOptionsFindings(res({ status, codes: [["IV_HIGH", "ADVERSE"]] }))).toMatchObject({ status, marketRisk: [], liquidityRisk: [], contractRisk: [] });
  });
});
describe("the specification mapping stays intact", () => {
  it("options-risk supplements Market Context and Liquidity, is still an EXTRA, and no other agent supplements anything", () => {
    expect(supplementsOf("options-risk-v1")).toEqual(["MARKET_CONTEXT", "LIQUIDITY"]); expect(roleOfAgent("options-risk-v1")).toBe("EXTRA"); expect(supplementsOf("liquidity-v1")).toEqual([]);
    expect(SPEC_ROLES).toHaveLength(12);
  });
  it("its spec report names the roles it supplements; other reports do not", () => {
    const base = { agentVersion: "1.0.0", status: "COMPLETED", verdict: "NEUTRAL", confidence: 50, findings: [], evidence: [], inputSnapshotRef: "x", inputSnapshot: {}, outputSnapshot: {}, startedAt: NOW, completedAt: NOW, durationMs: 1, attempts: 1, errorCode: null, errorMessage: null } as const;
    expect(toSpecAgentReport({ ...base, agentId: "options-risk-v1" } as AgentRunResult).supplementsRoles).toEqual(["MARKET_CONTEXT", "LIQUIDITY"]);
    expect("supplementsRoles" in toSpecAgentReport({ ...base, agentId: "liquidity-v1" } as AgentRunResult)).toBe(false);
  });
  it("the thirteenth agent (market-context) is still registered and runs BEFORE the challenger; the challenger no longer depends on it as a hard dependency", () => {
    const reg = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), plan = reg.resolve(loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" }));
    expect(reg.has("market-context-v1")).toBe(true);
    const level = (id: string) => plan.levels.findIndex((l) => l.includes(id));
    expect(level("market-context-v1")).toBeGreaterThanOrEqual(0); expect(level("market-context-v1")).toBeLessThan(level("independent-challenger-v1"));
  });
});
describe("in the research package", () => {
  const cfg = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" });
  const build = async (c: ResearchCandidate, extras?: Parameters<typeof buildResearchPackage>[3]) => {
    const out = await orchestrate(createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).resolve(cfg), cfg, candidateToAgentInputs(c) as never, { riskDecisionId: c.id, decisionVersion: 1 }, { now: () => NOW, sleep: async () => undefined });
    return buildResearchPackage(c, 1, out, extras);
  };
  it("the section is present only for an option, carries the mapping and the options-risk context, and never grants approval", async () => {
    const pkg = await build(cand(), { optionsRiskMapping: map() });
    expect(pkg.optionsRisk?.mapping).toMatchObject({ status: "MAPPED_UNVERIFIED" }); expect(pkg.optionsRisk?.context).toMatchObject({ agentId: "options-risk-v1" }); expect(pkg.grantsApproval).toBe(false);
  });
  it("an equity candidate, and a package built without the mapping, have no section and the same shape as before", async () => {
    const eq = cand({ strike: null, optionType: null, expiry: null }), a = await build(eq, { optionsRiskMapping: mapOptionsRisk({ candidate: eq, now: NOW }) }), b = await build(eq);
    expect("optionsRisk" in a).toBe(false); expect(a.packageSha256).toBe(b.packageSha256);
    expect("optionsRisk" in (await build(cand()))).toBe(false);
  });
  it("the mapping is part of the hash, so a later change to it is detectable", async () => {
    const withMap = await build(cand(), { optionsRiskMapping: map() }), other = await build(cand(), { optionsRiskMapping: map({}, { contract: contract() }) });
    expect(withMap.packageSha256).not.toBe(other.packageSha256);
  });
  it("runCandidateResearch attaches the mapping for an option (contract master unavailable) and none for an equity", async () => {
    const saved: unknown[] = []; const sink: ResearchPackageSink = { async save(id, build) { const row = build(1); saved.push(row.agentResults); return { id: "pkg-1", version: 1 }; } };
    const run = (c: ResearchCandidate, contract?: ContractFacts | null) => runCandidateResearch(c, { registry: createProductionRegistry({ rules: DEFAULT_AGENT_RULES }), config: cfg, sink, deps: { now: () => NOW, sleep: async () => undefined }, refuse: async () => undefined, ...(contract !== undefined ? { contract } : {}) });
    const r1 = await run(cand()); expect("research" in r1 && r1.research.optionsRisk?.mapping.reasons).toContain("CONTRACT_MASTER_UNAVAILABLE");
    const r2 = await run(cand(), contract()); expect("research" in r2 && r2.research.optionsRisk?.mapping).toMatchObject({ status: "MAPPED_VERIFIED", contract: { lotSize: 75 } });
    const r3 = await run(cand({ strike: null, optionType: null, expiry: null })); expect("research" in r3 && "optionsRisk" in r3.research).toBe(false);
  });
});
