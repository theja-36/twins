import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry, createProductionRegistry, DEFAULT_AGENT_RULES, fileInstrumentReference, instrumentVerificationAgent, INSTRUMENT_VERIFICATION_AGENT_ID, loadAgentRulesConfig, memoryInstrumentReference, parseInstrumentReference,
  resolveInstrumentReference, type AgentContractError, type AgentEvent, type AgentRulesConfig, type InstrumentRecord, type InstrumentReference,
} from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, optionInputs, type InputOverrides } from "../../support/agentFixtures";

const rec = (o: Partial<InstrumentRecord> & Pick<InstrumentRecord, "underlying" | "instrumentType">): InstrumentRecord => ({ market: "NSE", expiry: null, strike: null, optionType: null, lotSize: null, multiplier: null, active: true, ...o });
/** SYNTHETIC instrument reference: no live API. */
const REF = (asOf: string | null = "2025-01-01T00:00:00.000Z", extra: InstrumentRecord[] = []): InstrumentReference => memoryInstrumentReference({
  name: "synthetic", asOf, markets: ["NSE"],
  instruments: [
    rec({ underlying: "ACME", instrumentType: "equity" }),
    rec({ underlying: "NIFTY", instrumentType: "future", expiry: "2025-01-30", multiplier: 25, lotSize: 25 }),
    rec({ underlying: "NIFTY", instrumentType: "option", expiry: "2025-01-30", strike: 24500, optionType: "CE", lotSize: 75 }),
    rec({ underlying: "NIFTY", instrumentType: "option", expiry: "2025-01-30", strike: 24500, optionType: "PE", lotSize: 75 }),
    rec({ underlying: "NIFTY", instrumentType: "option", expiry: "2025-01-30", strike: 24600, optionType: "CE", lotSize: null }), // listed, but no lot size
    rec({ underlying: "NIFTY", instrumentType: "option", expiry: "2025-01-30", strike: 24700, optionType: "CE", lotSize: 75, active: false }),
    rec({ underlying: "NIFTY", instrumentType: "option", expiry: "2025-01-02", strike: 24500, optionType: "CE", lotSize: 75 }), // already expired relative to NOW
    rec({ underlying: "NIFTY", instrumentType: "option", expiry: "2025-12-25", strike: 24500, optionType: "CE", lotSize: 75 }), // beyond the 90-day horizon
    rec({ underlying: "BANKNIFTY", instrumentType: "future", expiry: "2025-01-30", multiplier: null, lotSize: null }), // no multiplier / lot size
    rec({ underlying: "FINNIFTY", instrumentType: "future", expiry: "2025-01-30", multiplier: null, lotSize: 40 }),
    ...extra,
  ],
});
const rules = (i: Partial<AgentRulesConfig["instrument"]> = {}): AgentRulesConfig => ({ ...DEFAULT_AGENT_RULES, instrument: { ...DEFAULT_AGENT_RULES.instrument, ...i } });
const run = async (inp: Record<string, unknown>, ref: InstrumentReference | null = REF(), r: AgentRulesConfig = rules(), events: AgentEvent[] = []) => (await evalAgents([instrumentVerificationAgent(r, ref)], inp, {}, events)).byId(INSTRUMENT_VERIFICATION_AGENT_ID);
const fut = (symbol = "NIFTY", over: InputOverrides["rd"] = {}): Record<string, unknown> => inputs({ rd: { instrumentType: "future", symbol, expiry: "2025-01-30", strike: null, optionType: null, entryPrice: 24000, stopLoss: 23900, targets: [24200], ...over } });
const opt = (rd: InputOverrides["rd"] = {}): Record<string, unknown> => optionInputs({ rd });

describe("Instrument Verification Agent: verdicts", () => {
  it("a valid option contract is SUPPORTIVE with the reference recorded as evidence", async () => {
    const r = await run(opt());
    expect(r).toMatchObject({ agentId: "instrument-verification-v1", status: "COMPLETED", verdict: "SUPPORTIVE", confidence: 90, findings: [] });
    expect(r.outputSnapshot).toMatchObject({ contractFound: true, referenceName: "synthetic", daysToExpiry: 24, blockingCount: 0 });
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "instrument_reference"]));
  });
  it("a valid futures contract is SUPPORTIVE (multiplier present; a lot size alone is noted, not penalized)", async () => {
    expect((await run(fut())).verdict).toBe("SUPPORTIVE");
    const r = await run(fut("FINNIFTY"));
    expect(r.verdict).toBe("SUPPORTIVE");
    expect(codesOf(r)).toContain("MULTIPLIER_FROM_LOT_SIZE");
  });
  it("a valid equity symbol is SUPPORTIVE and needs no lot size (the sizing engine defaults equities to 1)", async () => { expect((await run(inputs())).verdict).toBe("SUPPORTIVE"); });

  it.each<[string, Record<string, unknown>, string, string]>([
    ["an unknown market", inputs({ rd: { market: "XYZ" } }), "BLOCKING", "MARKET_UNSUPPORTED"],
    ["a missing market", inputs({ rd: { market: null } }), "BLOCKING", "MARKET_MISSING"],
    ["an unknown underlying", inputs({ rd: { symbol: "NOSUCH" } }), "BLOCKING", "UNDERLYING_UNKNOWN"],
    ["a missing underlying", inputs({ rd: { symbol: "UNKNOWN" } }), "BLOCKING", "UNDERLYING_MISSING"],
    ["a malformed equity symbol", inputs({ rd: { symbol: "AC ME!" } }), "BLOCKING", "EQUITY_SYMBOL_INVALID"],
    ["an unsupported instrument type", inputs({ rd: { instrumentType: "bond" } }), "BLOCKING", "INSTRUMENT_TYPE_UNSUPPORTED"],
    ["a missing instrument type", inputs({ rd: { instrumentType: null } }), "BLOCKING", "INSTRUMENT_TYPE_MISSING"],
    ["an expired contract", opt({ expiry: "2025-01-02" }), "BLOCKING", "EXPIRY_IN_PAST"],
    ["an invalid expiry format", opt({ expiry: "30-01-2025" }), "BLOCKING", "EXPIRY_INVALID"],
    ["an impossible expiry date", opt({ expiry: "2025-02-30" }), "BLOCKING", "EXPIRY_INVALID"],
    ["a missing expiry", opt({ expiry: null }), "BLOCKING", "EXPIRY_MISSING"],
    ["an invalid strike", opt({ strike: -5 }), "BLOCKING", "STRIKE_INVALID"],
    ["a missing strike", opt({ strike: null }), "BLOCKING", "STRIKE_INVALID"],
    ["an invalid option type", opt({ optionType: "XX" }), "BLOCKING", "OPTION_TYPE_INVALID"],
    ["a strike that is not listed", opt({ strike: 99999 }), "BLOCKING", "STRIKE_NOT_LISTED"],
    ["an expiry that is not listed", opt({ expiry: "2025-02-27" }), "BLOCKING", "EXPIRY_NOT_LISTED"],
    ["a futures expiry that is not listed", fut("NIFTY", { expiry: "2025-02-27" }), "BLOCKING", "EXPIRY_NOT_LISTED"],
    ["an equity that is not listed (the underlying exists only as a derivative)", inputs({ rd: { symbol: "NIFTY" } }), "BLOCKING", "INSTRUMENT_NOT_FOUND"],
    ["an inactive contract", opt({ strike: 24700 }), "BLOCKING", "CONTRACT_INACTIVE"],
    ["an option with no lot size (default policy BLOCKING)", opt({ strike: 24600 }), "BLOCKING", "MISSING_LOT_SIZE"],
    ["a future with no multiplier or lot size (default policy BLOCKING)", fut("BANKNIFTY"), "BLOCKING", "MISSING_MULTIPLIER"],
    ["an expiry beyond the horizon (default ADVERSE)", opt({ expiry: "2025-12-25" }), "ADVERSE", "EXPIRY_BEYOND_HORIZON"],
    ["a strike on an equity", inputs({ rd: { strike: 100 } }), "ADVERSE", "OPTION_FIELDS_ON_NON_OPTION"],
  ])("%s -> %s (%s)", async (_n, inp, verdict, code) => {
    const r = await run(inp);
    expect(r.status).toBe("COMPLETED");
    expect(r.verdict).toBe(verdict);
    if (code) expect(codesOf(r)).toContain(code);
  });
  it("an unknown market stops further lookups: nothing is guessed about its instruments", async () => {
    const r = await run(opt({ market: "XYZ" }));
    expect(r.verdict).toBe("BLOCKING");
    expect(r.outputSnapshot["contractFound"]).toBe(false);
    expect(codesOf(r)).not.toContain("STRIKE_NOT_LISTED");
  });
  it("the contract's own expiry day is CAUTION (today) in the market's local time, not UTC", async () => {
    const r = await evalAgents([instrumentVerificationAgent(rules(), REF())], opt({ expiry: "2025-01-30" }), {}, [], new Date("2025-01-29T20:00:00Z")); // 01:30 IST on 30 January
    expect(r.byId(INSTRUMENT_VERIFICATION_AGENT_ID)).toMatchObject({ verdict: "CAUTION" });
    expect(codesOf(r.byId(INSTRUMENT_VERIFICATION_AGENT_ID))).toContain("EXPIRY_TODAY");
  });
});

describe("Instrument Verification Agent: policy, reference and failures", () => {
  it("lot-size and horizon severities are configurable; the horizon itself is configurable", async () => {
    expect((await run(opt({ strike: 24600 }), REF(), rules({ missingLotSize: "ADVERSE" }))).verdict).toBe("ADVERSE");
    expect((await run(opt({ expiry: "2025-12-25" }), REF(), rules({ beyondHorizon: "BLOCKING" }))).verdict).toBe("BLOCKING");
    expect((await run(opt({ expiry: "2025-12-25" }), REF(), rules({ maxExpiryHorizonDays: 400 }))).verdict).toBe("SUPPORTIVE");
    expect(codesOf(await run(opt(), REF(), rules({ maxExpiryHorizonDays: 10 })))).toContain("EXPIRY_BEYOND_HORIZON");
  });
  it("a stale or undated reference snapshot is a CAUTION", async () => {
    expect(codesOf(await run(opt(), REF("2024-10-01T00:00:00.000Z")))).toContain("REFERENCE_STALE");
    expect(codesOf(await run(opt(), REF(null)))).toContain("REFERENCE_AS_OF_UNKNOWN");
    expect((await run(opt(), REF("2024-10-01T00:00:00.000Z"))).verdict).toBe("CAUTION");
  });
  it("no reference configured => UNAVAILABLE (never a pass)", async () => {
    expect(await run(opt(), null)).toMatchObject({ status: "UNAVAILABLE", verdict: "UNAVAILABLE", confidence: null, errorCode: "INSTRUMENT_REFERENCE_NOT_CONFIGURED" });
  });
  it("a failing reference is retried per the retry policy and then FAILED with a fixed code; the provider's message is never stored", async () => {
    let calls = 0;
    const broken: InstrumentReference = { ...REF(), supportsMarket: async () => { calls += 1; throw new Error(`connection to ${"123456789"}:${"D".repeat(35)} refused`); } };
    const r = await run(opt(), broken);
    expect(calls).toBe(2);
    expect(r).toMatchObject({ status: "FAILED", verdict: "UNAVAILABLE", errorCode: "INSTRUMENT_REFERENCE_ERROR", attempts: 2, confidence: null });
    expect(JSON.stringify(r)).not.toMatch(/123456789|connection/);
  });
  it("a reference that recovers on the second attempt completes", async () => {
    let calls = 0;
    const base = REF();
    const flaky: InstrumentReference = { ...base, supportsMarket: async (m) => { calls += 1; if (calls === 1) throw new Error("blip"); return base.supportsMarket(m); } };
    expect(await run(opt(), flaky)).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE", attempts: 2 });
  });
  it("historical instrument reference is supporting evidence only (INFO, never a verdict change)", async () => {
    const seen = instrumentVerificationAgent(rules(), REF(), { contractSeen: async () => true });
    const unseen = instrumentVerificationAgent(rules(), REF(), { contractSeen: async () => false });
    const a = (await evalAgents([seen], opt())).byId(INSTRUMENT_VERIFICATION_AGENT_ID), b = (await evalAgents([unseen], opt())).byId(INSTRUMENT_VERIFICATION_AGENT_ID);
    expect([a.verdict, b.verdict]).toEqual(["SUPPORTIVE", "SUPPORTIVE"]);
    expect(codesOf(a)).toContain("CONTRACT_SEEN_IN_HISTORY");
    expect(codesOf(b)).toContain("CONTRACT_NOT_SEEN_IN_HISTORY");
  });
  it("sees only the risk-decision context (and optional features): no message text, no source intelligence", async () => {
    const r = await run(opt());
    expect(Object.keys(r.inputSnapshot).sort()).toEqual(["risk_decision", "signal_context", "signal_features"]);
  });
  it("a missing risk-decision input skips the agent", async () => {
    expect(await run({ ...opt(), risk_decision: null })).toMatchObject({ status: "SKIPPED", errorCode: "MISSING_REQUIRED_INPUT" });
  });
});

describe("instrument reference files (twins-instrument-reference-v1)", () => {
  const file = (body: unknown, name = "instruments.json"): string => { const d = mkdtempSync(join(tmpdir(), "twins-ref-")); const p = join(d, name); writeFileSync(p, JSON.stringify(body)); return p; };
  const good = { format: "twins-instrument-reference-v1", source: "synthetic-export", as_of: "2025-01-01T00:00:00Z", markets: ["NSE"], instruments: [
    { market: "NSE", underlying: "ACME", instrument_type: "equity" }, { market: "NSE", underlying: "NIFTY", instrument_type: "option", expiry: "2025-01-30", strike: 24500, option_type: "CE", lot_size: 75 }] };
  it("loads a valid file and answers lookups; `none` means no reference", async () => {
    const ref = fileInstrumentReference(file(good));
    expect(ref.asOf).toBe("2025-01-01T00:00:00.000Z");
    expect(await ref.supportsMarket("nse")).toBe(true);
    expect((await ref.lookup({ market: "NSE", underlying: "NIFTY", instrumentType: "option", expiry: "2025-01-30", strike: 24500, optionType: "CE" }))?.lotSize).toBe(75);
    expect(await ref.lookup({ market: "NSE", underlying: "NIFTY", instrumentType: "option", expiry: "2025-01-30", strike: 24500, optionType: "PE" })).toBeNull();
    expect(resolveInstrumentReference("none")).toBeNull();
    expect(resolveInstrumentReference(`file:${file(good)}`)?.name).toBe("file:synthetic-export");
    expect(() => resolveInstrumentReference("https://example.invalid/feed")).toThrow();
  });
  it.each<[string, (b: Record<string, unknown>) => void]>([
    ["an unknown format", (b) => { b["format"] = "x"; }], ["a missing as_of", (b) => { delete b["as_of"]; }], ["no markets", (b) => { b["markets"] = []; }],
    ["an unsupported instrument type", (b) => { (b["instruments"] as Array<Record<string, unknown>>)[0]!["instrument_type"] = "swap"; }],
    ["a derivative without an expiry", (b) => { delete (b["instruments"] as Array<Record<string, unknown>>)[1]!["expiry"]; }],
    ["an impossible expiry", (b) => { (b["instruments"] as Array<Record<string, unknown>>)[1]!["expiry"] = "2025-13-45"; }],
    ["a non-positive lot size", (b) => { (b["instruments"] as Array<Record<string, unknown>>)[1]!["lot_size"] = 0; }],
    ["an option without a strike", (b) => { delete (b["instruments"] as Array<Record<string, unknown>>)[1]!["strike"]; }],
    ["a strike on an equity", (b) => { (b["instruments"] as Array<Record<string, unknown>>)[0]!["strike"] = 5; }],
    ["a duplicate contract", (b) => { (b["instruments"] as unknown[]).push({ ...((b["instruments"] as Array<Record<string, unknown>>)[0] as object) }); }],
  ])("rejects %s (nothing is repaired)", (_n, mutate) => {
    const b = structuredClone(good) as Record<string, unknown>;
    mutate(b);
    expect(() => parseInstrumentReference(b)).toThrowError(expect.objectContaining({ code: "INVALID_INSTRUMENT_REFERENCE" }) as AgentContractError);
  });
  it("refuses non-JSON, malformed, missing, symlinked and credential-named files", () => {
    const d = mkdtempSync(join(tmpdir(), "twins-ref-"));
    writeFileSync(join(d, "bad.json"), "{nope");
    writeFileSync(join(d, "x.csv"), "a,b");
    writeFileSync(join(d, "id_rsa.json"), JSON.stringify(good));
    const ok = file(good);
    symlinkSync(ok, join(d, "link.json"));
    for (const p of [join(d, "bad.json"), join(d, "x.csv"), join(d, "id_rsa.json"), join(d, "link.json"), join(d, "missing.json")]) expect(() => fileInstrumentReference(p), p).toThrowError(expect.objectContaining({ code: "INVALID_INSTRUMENT_REFERENCE" }) as AgentContractError);
  });
});

describe("rule configuration (conservative defaults, strict overrides)", () => {
  it("defaults", () => {
    expect(loadAgentRulesConfig({})).toEqual(DEFAULT_AGENT_RULES);
    expect(DEFAULT_AGENT_RULES.signal).toMatchObject({ staleCautionMinutes: 10, staleAdverseMinutes: 30, staleBlockMinutes: 120, targetOrdering: "strict", ambiguousRevision: "BLOCKING" });
    expect(DEFAULT_AGENT_RULES.instrument).toMatchObject({ maxExpiryHorizonDays: 90, missingLotSize: "BLOCKING", referenceSource: "none" });
  });
  it("parses every override", () => {
    const c = loadAgentRulesConfig({
      TWINS_AGENT_SIGNAL_STALE_CAUTION_MINUTES: "2", TWINS_AGENT_SIGNAL_STALE_ADVERSE_MINUTES: "4", TWINS_AGENT_SIGNAL_STALE_BLOCK_MINUTES: "8", TWINS_AGENT_TARGET_ORDERING: "non_strict", TWINS_AGENT_TARGET_ORDER_VIOLATION: "BLOCKING",
      TWINS_AGENT_REVISION_AMBIGUOUS: "ADVERSE", TWINS_AGENT_INSTRUMENT_REFERENCE: "file:/data/ref.json", TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS: "45", TWINS_AGENT_EXPIRY_BEYOND_HORIZON: "BLOCKING", TWINS_AGENT_MISSING_LOT_SIZE: "ADVERSE", TWINS_AGENT_REFERENCE_MAX_AGE_DAYS: "7",
    });
    expect(c.signal).toMatchObject({ staleCautionMinutes: 2, staleAdverseMinutes: 4, staleBlockMinutes: 8, targetOrdering: "non_strict", targetOrderViolation: "BLOCKING", ambiguousRevision: "ADVERSE" });
    expect(c.instrument).toMatchObject({ maxExpiryHorizonDays: 45, beyondHorizon: "BLOCKING", missingLotSize: "ADVERSE", referenceMaxAgeDays: 7, referenceSource: "file:/data/ref.json" });
  });
  it.each<[string, Record<string, string>]>([
    ["non-increasing staleness", { TWINS_AGENT_SIGNAL_STALE_CAUTION_MINUTES: "50", TWINS_AGENT_SIGNAL_STALE_ADVERSE_MINUTES: "30" }], ["a non-numeric threshold", { TWINS_AGENT_SIGNAL_STALE_BLOCK_MINUTES: "soon" }],
    ["an unknown ordering policy", { TWINS_AGENT_TARGET_ORDERING: "loose" }], ["a bad severity", { TWINS_AGENT_MISSING_LOT_SIZE: "WARN" }], ["a zero horizon", { TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS: "0" }],
    ["a horizon above two years", { TWINS_AGENT_MAX_EXPIRY_HORIZON_DAYS: "999" }], ["a bad reference source", { TWINS_AGENT_INSTRUMENT_REFERENCE: "http://feed" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadAgentRulesConfig(env)).toThrow(); });
});

describe("worker wiring: the production agents exist only when the engine is explicitly enabled", () => {
  it("the worker registers them only if enabled, loads the rules and the reference only then, and otherwise uses the empty registry", () => {
    const w = readFileSync(join(__dirname, "../../../services/worker/src/index.ts"), "utf8");
    expect(w).toMatch(/const agentRules = agentEngineConfig\.enabled \? loadAgentRulesConfig\(\) : null;/);
    expect(w).toMatch(/const agentReference = agentRules \? resolveInstrumentReference\(/);
    expect(w).toMatch(/if \(!agentRules\) return createDefaultRegistry\(\);/);
    expect(createDefaultRegistry().snapshot()).toEqual([]);
  });
  it("neither agent source reads message text, imports network / broker / LLM code, or writes anything", () => {
    for (const f of ["signalIntegrity.ts", "instrumentVerification.ts", "common.ts", "rules.ts"]) {
      const t = readFileSync(join(__dirname, "../../../packages/agents/src/agents", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(t, f).not.toMatch(/rawText|raw_text|telegramMessages|\bfetch\(|node:https?|node:net\b|zerodha|kite|anthropic|openai|Date\.now|new Date\(\)|\.insert\(|\.update\(|\.delete\(/i);
    }
  });
});

describe("registration", () => {
  it("the production agents register with valid, unique contracts; all can block, none is advisory, weights are the engine's to override", () => {
    const r = createProductionRegistry({ rules: DEFAULT_AGENT_RULES, instrumentReference: REF() });
    expect(r.snapshot().map((c) => [c.agentId, c.version, c.canBlock, c.advisoryOnly, c.weight])).toEqual([["index-constituent-impact-v1", "1.0.0", true, false, 50], ["instrument-verification-v1", "1.0.0", true, false, 60], ["liquidity-v1", "1.0.0", true, false, 50], ["macro-global-v1", "1.0.0", true, false, 50], ["market-calendar-v1", "1.0.0", true, false, 50], ["news-sentiment-v1", "1.0.0", true, false, 50], ["options-risk-v1", "1.0.0", true, false, 50], ["price-action-v1", "1.0.0", true, false, 50], ["signal-integrity-v1", "1.0.0", true, false, 60], ["technical-structure-v1", "1.0.0", true, false, 50]]);
    expect(r.resolve({ disabledAgents: [], requiredAgents: [] }).levels).toEqual([["index-constituent-impact-v1", "instrument-verification-v1", "liquidity-v1", "macro-global-v1", "market-calendar-v1", "news-sentiment-v1", "options-risk-v1", "price-action-v1", "signal-integrity-v1", "technical-structure-v1"]]); // independent: one parallel level
    expect(r.resolve({ disabledAgents: ["instrument-verification-v1"], requiredAgents: ["instrument-verification-v1"] }).missingRequired).toEqual([{ agentId: "instrument-verification-v1", reason: "DISABLED" }]);
  });
});
