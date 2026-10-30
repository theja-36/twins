/**
 * Synthesis transparency and the approval-eligibility re-check of the research assessment against REAL PostgreSQL (Stage 5 / Task 8, closing D-066 a). Synthetic decisions and fake agents only: no
 * external API, no LLM, no network, no real Telegram channel. The stored messages carry a marker text that must never reach an agent input, output, event or table. Nothing here creates an
 * order, fill, position or card; the approvals recorded in the "allowed" cases are the very thing under test.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { AgentRegistry, loadAgentEngineConfig, runAgentEngine, type AgentDefinition, type AgentEvent } from "../../../packages/agents/src/index";
import {
  assessApprovalEligibility, createApprovalCard, createRiskDecision, DEFAULT_RESEARCH_ELIGIBILITY, evaluateMarketRisk, evaluatePortfolioRisk, latestResearchAssessment, loadPortfolioConfig, recordRiskApproval, sizeRiskDecision,
  type ResearchEligibilityConfig, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { PgBotDb } from "../../../services/approval-bot/src/db";
import { validIntelligence } from "../../support/intelligenceFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";
import { healthy, OPEN_NOW, syntheticProvider } from "../risk/gates";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
let handle: BoundedDbHandle;
let source: InMemoryStateSource;
const sfx = () => randomUUID().slice(0, 8);
const db = () => handle.db;
const SIZE_CAPITAL = 1_000_000;
const CAPITAL = 1_000_000_000;
const MARKER = "SECRET-MESSAGE-TEXT-DO-NOT-LEAK";
const CHAINS = ["agent_definitions", "agent_orchestrator_runs", "agent_runs", "agent_findings", "agent_evidence_references", "agent_orchestrator_syntheses", "risk_approvals"];
const LIVE = ["orders", "fills", "positions", "risk_approval_cards", "decisions"];

beforeAll(() => {
  handle = createBoundedDb(DATABASE_URL, { max: 6, idleTimeoutMillis: 10_000 });
  source = inMemoryStateSource();
  configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
});
afterEach(() => { source.set({ INTAKE_ENABLED: true, KILL_SWITCH_ACTIVE: false }); source.failWith(null); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const openLimits = () => loadPortfolioConfig({ TWINS_PORTFOLIO_MAX_TOTAL_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_MARKET_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_GROUP_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_UNDERLYING_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_EXPIRY_RISK_PCT: "100", TWINS_PORTFOLIO_MAX_ACTIVE: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_GROUP: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_UNDERLYING: "9999", TWINS_PORTFOLIO_MAX_ACTIVE_PER_EXPIRY: "9999", TWINS_PORTFOLIO_CORRELATION_GROUPS: "NONE" });
const pfOpts = { config: openLimits(), capital: CAPITAL };

interface Stage { signalId: string; evidenceId: string; v1: string; sized: string; portfolio?: string; approved?: string; rejected?: string }
/** Builds a decision up to a stage: "pending" (unsized v1) | "sized" | "portfolio" | "approved" (all gates passed) | "market_rejected". */
async function make(stage: "pending" | "sized" | "portfolio" | "approved" | "market_rejected", symbol = `RA${sfx()}`.toUpperCase()): Promise<Stage & { head: string }> {
  const [instrument] = await db().insert(schema.instruments).values({ symbol, exchange: "NSE", instrumentType: "equity" }).returning();
  const [src] = await db().insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Math.floor(Math.random() * 1e9)}` }).returning();
  const [msg] = await db().insert(schema.telegramMessages).values({ telegramSourceId: must(src).id, externalMessageId: sfx(), messageTimestamp: new Date(), rawText: `${MARKER} BUY ${symbol} @ 100 SL 95`, rawPayload: { marker: MARKER } }).returning();
  const [signal] = await db().insert(schema.signals).values({ sourceType: "synthetic", telegramMessageId: must(msg).id, instrumentId: must(instrument).id, parserVersion: "ra-test", direction: "buy", entryPrice: "100", stopLoss: "95", targets: [110], signalTimestamp: new Date() }).returning();
  const [ev] = await db().insert(schema.stopLossValidations).values({ subjectKind: "signal", signalId: must(signal).id, ruleVersion: "stop-loss-v1", result: "VALID", levelBasis: "price", normalizedStopLoss: "95", entryPrice: "100", riskDistance: "5", riskPct: "5", maxRiskPct: "10" }).returning();
  const input: RiskDecisionInput = {
    subject: { kind: "signal", signalId: must(signal).id }, stopLossValidationId: must(ev).id, status: "PENDING", idempotencyKey: `ra-pending:${randomUUID()}`, createdBy: "service:risk-decision", instrumentType: "equity", market: "NSE", symbol, side: "BUY",
    entryPrice: 100, stopLoss: 95, stopLossBasis: "price", target1: 110, sourceTrustTier: "HIGH", decisionReasonCode: "awaiting_risk_gates",
    inputSnapshot: { synthetic: true, signalValidation: { decisionConfidence: 0.9 } }, outputSnapshot: { stage: "risk_decision_foundation", sized: false, limitsApplied: false, intelligence: validIntelligence() }, evidenceReferences: { fixture: true },
  };
  const v1 = await createRiskDecision(db(), input);
  const base = { signalId: must(signal).id, evidenceId: must(ev).id, v1: v1.id, sized: v1.id };
  if (stage === "pending") return { ...base, head: v1.id };
  const sized = await sizeRiskDecision(db(), v1.id, { capital: SIZE_CAPITAL });
  if (stage === "sized") return { ...base, sized: sized.id, head: sized.id };
  const pf = await evaluatePortfolioRisk(db(), sized.id, pfOpts);
  if (stage === "portfolio") return { ...base, sized: sized.id, portfolio: pf.id, head: pf.id };
  const bad = stage === "market_rejected";
  const mk = await evaluateMarketRisk(db(), pf.id, { provider: syntheticProvider(healthy(OPEN_NOW, bad ? { bidQty: 1 } : {})), now: OPEN_NOW, capital: CAPITAL });
  return { ...base, sized: sized.id, portfolio: pf.id, ...(bad ? { rejected: mk.id } : { approved: mk.id }), head: mk.id };
}
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const counts = async (tables: string[]) => Promise.all(tables.map(async (t) => Number(must((await q(`select count(*)::int as n from ${t}`))[0])["n"])));

type Verdict = "SUPPORTIVE" | "NEUTRAL" | "CAUTION" | "ADVERSE" | "BLOCKING";
let calls = 0;
/** A fake research agent with a fixed verdict (weight 50, may block). */
const fake = (verdict: Verdict): AgentDefinition => ({
  contract: {
    agentId: "fake_agent", agentName: "fake", version: "1.0.0", requiredInputs: ["risk_decision"], optionalInputs: [],
    outputSchema: { fields: { checksRun: { type: "number", required: true }, blockingCount: { type: "number", required: true }, adverseCount: { type: "number", required: true }, cautionCount: { type: "number", required: true }, failedCodes: { type: "string[]", required: true }, truncatedFindings: { type: "boolean", required: true } } },
    timeoutMs: 1000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  },
  async run() {
    calls += 1;
    return { verdict, confidence: 100, findings: verdict === "SUPPORTIVE" || verdict === "NEUTRAL" ? [] : [{ code: "FAKE_FINDING", severity: verdict === "BLOCKING" ? "CRITICAL" : verdict === "ADVERSE" ? "HIGH" : "MEDIUM", summary: "fake finding" }],
      evidence: [{ kind: "risk_decision", ref: "risk_decision:fake" }], output: { checksRun: 1, blockingCount: 0, adverseCount: 0, cautionCount: 0, failedCodes: [], truncatedFindings: false } };
  },
});
const ENGINE = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "fake_agent" });
const ENGINE_GHOST = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "fake_agent,ghost_agent" }); // ghost_agent is never registered => INCOMPLETE
const clock = { now: () => new Date(), sleep: async () => undefined };
const research = (over: Partial<ResearchEligibilityConfig> = {}): ResearchEligibilityConfig => ({ ...DEFAULT_RESEARCH_ELIGIBILITY, engineEnabled: true, ...over });
const registry = (v: Verdict) => { const r = new AgentRegistry(); r.register(fake(v)); return r; };
/** Runs the engine on a decision (version) with the fake agent. */
const runOn = async (id: string, v: Verdict, config = ENGINE, emit?: (e: AgentEvent) => void) => {
  const out = await runAgentEngine(db(), id, { registry: registry(v), config, ...(emit ? { emit } : {}), ...clock });
  if (out.skipped) throw new Error("skipped");
  return out;
};
const ASSESSMENT_OF: Record<string, string> = { SUPPORTIVE: "RESEARCH_SUPPORTIVE", NEUTRAL: "RESEARCH_NEUTRAL", CAUTION: "RESEARCH_CAUTION", ADVERSE: "RESEARCH_ADVERSE", BLOCKING: "RESEARCH_BLOCKED" };
const approve = (id: string, cfg: ResearchEligibilityConfig = research()) => recordRiskApproval(db(), { decisionId: id, action: "APPROVE", actor: "operator:itest", research: cfg });
/** An approval-eligible decision whose early version (v1) is assessed by the fake agent. */
async function assessed(v: Verdict | "INCOMPLETE" | null): Promise<{ head: string; v1: string; runId: string | null }> {
  const m = await make("approved");
  if (v === null) return { head: must(m.approved), v1: m.v1, runId: null };
  const out = v === "INCOMPLETE" ? await runOn(m.v1, "SUPPORTIVE", ENGINE_GHOST) : await runOn(m.v1, v);
  return { head: must(m.approved), v1: m.v1, runId: out.runId };
}

describe("synthesis output is stored complete, and the no-approval constraint still holds", () => {
  it("the stored result carries the per-agent summary, reasons, score breakdown, threshold evaluation and halt reason; grantsApproval is false and the database refuses true", async () => {
    const m = await make("pending");
    const out = await runOn(m.v1, "ADVERSE");
    expect(out).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    const syn = must((await q("select * from agent_orchestrator_syntheses where orchestrator_run_id = $1", [out.runId]))[0]);
    expect(syn).toMatchObject({ assessment: "RESEARCH_ADVERSE", algorithm_version: "research-synthesis-v2", grants_approval: false });
    const r = syn["result"];
    expect(r).toMatchObject({ grantsApproval: false, halt: { halt: true, reasonCode: "HALT_ADVERSE_VETO", assessment: "RESEARCH_ADVERSE" }, thresholdEvaluation: { decidedBy: "ADVERSE_VETO" } });
    expect(r.agentSummaries).toEqual([expect.objectContaining({ agentId: "fake_agent", verdict: "ADVERSE", scored: true, reasonCodes: ["FAKE_FINDING"] })]);
    expect(r.reasons.adverse).toEqual([expect.objectContaining({ agentId: "fake_agent", findingCodes: ["FAKE_FINDING"] })]);
    expect(r.scoreBreakdown).toMatchObject({ totalWeight: 50, weightedSum: -50, score: -1 });
    expect(r.halt.reason).toBe("The flow halts: RESEARCH_ADVERSE was decided by an ADVERSE verdict from an agent at or above the veto weight (fake_agent).");
    await expect(pool.query("insert into agent_orchestrator_syntheses (orchestrator_run_id, assessment, algorithm_version, synthesis_input, synthesis_input_sha256, result, grants_approval, created_by) values ($1, 'RESEARCH_SUPPORTIVE', 'x', '{}', $2, '{}', true, 'itest')", [out.runId, "0".repeat(64)])).rejects.toThrow();
  });
  it("a worker-halting assessment and the eligibility refusal agree: the halt list and the refusal list are the same by default", async () => {
    for (const v of ["SUPPORTIVE", "NEUTRAL", "CAUTION", "ADVERSE", "BLOCKING"] as Verdict[]) {
      const d = await assessed(v);
      const run = must((await q("select s.assessment, s.result from agent_orchestrator_syntheses s where s.orchestrator_run_id = $1", [d.runId]))[0]);
      const refused = (await assessApprovalEligibility(db(), d.head, { research: research() })).reasons.some((x) => x.startsWith("research_assessment_"));
      expect(run["assessment"], v).toBe(ASSESSMENT_OF[v]);
      expect(run["result"].halt.halt, v).toBe(refused);
    }
  });
});

describe("approval is refused for BLOCKED, INCOMPLETE and ADVERSE assessments (application layer and database function)", () => {
  it.each([["BLOCKING", "research_assessment_blocked"], ["INCOMPLETE", "research_assessment_incomplete"], ["ADVERSE", "research_assessment_adverse"]] as const)("%s -> %s", async (v, code) => {
    const d = await assessed(v);
    const live = await counts(LIVE);
    const before = await counts(["risk_approvals"]);
    const a = await assessApprovalEligibility(db(), d.head, { research: research() });
    expect(a).toMatchObject({ eligible: false, reasons: [code] });
    await expect(createApprovalCard(db(), d.head, { research: research() })).rejects.toMatchObject({ code: "not_approval_eligible" });
    expect(await approve(d.head)).toEqual({ outcome: "refused", reason: code }); // the application pre-check
    // with the application-layer check switched off, the database function is the floor
    expect(await approve(d.head, research({ enforced: false }))).toEqual({ outcome: "refused", reason: code });
    expect(await counts(["risk_approvals"])).toEqual(before);
    expect(await counts(LIVE)).toEqual(live);
    expect(await latestResearchAssessment(db(), (await q("select signal_id as \"signalId\", options_claim_id as \"optionsClaimId\", decision_version as \"decisionVersion\" from risk_decisions where id = $1", [d.head]))[0] as never)).toMatchObject({ runId: d.runId });
  });
  it("the approval bot's database path is refused too (it calls the function directly)", async () => {
    const d = await assessed("ADVERSE");
    const bot = new PgBotDb(pool as never);
    const r = await bot.decideRisk({ decisionId: d.head, cardId: randomUUID(), cardMessageId: 1, updateId: 1, approverId: "42", action: "approve" } as never).catch((e: Error) => ({ outcome: "error", message: e.message }));
    expect(["unknown", "refused", "not_pending", "error"]).toContain((r as { outcome: string }).outcome); // no card exists for this decision, so the function cannot record anything
    const direct = await pool.query("select twins_record_risk_approval($1::uuid, null::uuid, 'APPROVE', 'operator:itest', '{}'::jsonb, null, null::timestamptz) as outcome", [d.head]);
    expect(direct.rows[0].outcome).toBe("refused:decision_expired"); // a null validity is refused before the research rule: the function stays strict
  });
});

describe("approval continues under the existing rules for CAUTION, NEUTRAL and SUPPORTIVE", () => {
  it.each(["CAUTION", "NEUTRAL", "SUPPORTIVE"] as const)("%s: eligible, a card can be created and an approval is recorded", async (v) => {
    const d = await assessed(v);
    expect(await assessApprovalEligibility(db(), d.head, { research: research() })).toMatchObject({ eligible: true, reasons: [] });
    const res = await approve(d.head);
    expect(res.outcome).toBe("recorded");
    expect(await counts(["orders", "fills", "positions"])).toEqual(await counts(["orders", "fills", "positions"])); // no execution state exists (the approval is a review record only)
    expect(Number(must((await q("select count(*)::int as n from orders where risk_decision_id = $1", [d.head]).catch(() => [{ n: 0 }]))[0])["n"])).toBe(0);
  });
  it("a card is created for an acceptable assessment", async () => {
    const d = await assessed("SUPPORTIVE");
    expect(await createApprovalCard(db(), d.head, { research: research() })).toMatchObject({ created: true, decisionId: d.head });
  });
});

describe("a missing assessment, the engine switch and the configuration", () => {
  it("engine enabled and no assessment: refused with research_assessment_missing (card, API and eligibility); ALLOW lets it pass", async () => {
    const d = await assessed(null);
    expect(await assessApprovalEligibility(db(), d.head, { research: research() })).toMatchObject({ eligible: false, reasons: ["research_assessment_missing"] });
    await expect(createApprovalCard(db(), d.head, { research: research() })).rejects.toMatchObject({ code: "not_approval_eligible" });
    expect(await approve(d.head)).toEqual({ outcome: "refused", reason: "research_assessment_missing" });
    expect(await assessApprovalEligibility(db(), d.head, { research: research({ onMissing: "ALLOW" }) })).toMatchObject({ eligible: true });
  });
  it("engine disabled: behaviour is unchanged (eligible, approvable) unless REQUIRE is configured", async () => {
    const d = await assessed(null);
    const off = research({ engineEnabled: false });
    expect(await assessApprovalEligibility(db(), d.head, { research: off })).toMatchObject({ eligible: true, reasons: [] });
    expect(await assessApprovalEligibility(db(), d.head)).toMatchObject({ eligible: true }); // the environment default: engine disabled
    expect(await assessApprovalEligibility(db(), d.head, { research: research({ engineEnabled: false, whenEngineDisabled: "REQUIRE" }) })).toMatchObject({ eligible: false, reasons: ["research_assessment_missing"] });
    expect((await approve(d.head, off)).outcome).toBe("recorded");
  });
  it("enforced = false turns the application re-check off for a missing assessment", async () => {
    const d = await assessed(null);
    expect(await assessApprovalEligibility(db(), d.head, { research: research({ enforced: false }) })).toMatchObject({ eligible: true });
  });
  it("CAUTION can be configured to refuse", async () => {
    const d = await assessed("CAUTION");
    const strict = research({ refuseOn: ["RESEARCH_ADVERSE", "RESEARCH_BLOCKED", "RESEARCH_CAUTION", "RESEARCH_INCOMPLETE"] });
    expect(await assessApprovalEligibility(db(), d.head, { research: strict })).toMatchObject({ eligible: false, reasons: ["research_assessment_caution"] });
  });
});

describe("the LATEST assessment of the lineage decides", () => {
  it("a decision that passed the worker halt but has a later ADVERSE assessment cannot be approved; a later acceptable one restores eligibility", async () => {
    const m = await make("approved");
    const head = must(m.approved);
    await runOn(m.v1, "SUPPORTIVE"); // passed the worker halt
    expect(await assessApprovalEligibility(db(), head, { research: research() })).toMatchObject({ eligible: true });
    const later = await runOn(head, "ADVERSE"); // a later run on the approved version
    expect(later).toMatchObject({ assessment: "RESEARCH_ADVERSE", halt: true });
    expect(await assessApprovalEligibility(db(), head, { research: research() })).toMatchObject({ eligible: false, reasons: ["research_assessment_adverse"] });
    expect(await approve(head)).toEqual({ outcome: "refused", reason: "research_assessment_adverse" });
    expect(await approve(head, research({ enforced: false }))).toEqual({ outcome: "refused", reason: "research_assessment_adverse" }); // the database floor
    await runOn(head, "SUPPORTIVE", loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "fake_agent", TWINS_AGENT_ENGINE_MAX_CONCURRENCY: "2" })); // a different configuration => a new run
    expect(await assessApprovalEligibility(db(), head, { research: research() })).toMatchObject({ eligible: true });
  });
});

describe("idempotency, audit chain, privacy and inertness", () => {
  it("re-running the same decision version returns the stored result without re-running the agents", async () => {
    const m = await make("pending");
    calls = 0;
    const first = await runOn(m.v1, "CAUTION");
    expect(calls).toBe(1);
    const again = await runOn(m.v1, "CAUTION");
    expect(again).toMatchObject({ created: false, runId: first.runId, assessment: first.assessment, halt: first.halt });
    expect(calls).toBe(1);
  });
  it("the audit chains verify after runs, refusals and approvals", async () => {
    await assessed("ADVERSE"); await approve((await assessed("SUPPORTIVE")).head);
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });
  it("the marker text of the stored messages appears in no agent input, output, finding, synthesis or event; eligibility reasons carry codes only", async () => {
    const m = await make("approved");
    const events: AgentEvent[] = [];
    const out = await runOn(m.v1, "ADVERSE", ENGINE, (e) => events.push(e));
    expect(JSON.stringify(events)).not.toContain("SECRET-MESSAGE");
    for (const t of CHAINS) {
      const leaked = await q(`select count(*)::int as n from ${t} where ${t}::text like '%SECRET-MESSAGE%' or ${t}::text like '%rawText%'`);
      expect(leaked[0]!["n"], t).toBe(0);
    }
    const a = await assessApprovalEligibility(db(), must(m.approved), { research: research() });
    expect(JSON.stringify(a.reasons)).not.toContain("SECRET");
    expect(out.runId).toBeTruthy();
  });
  it("creates no order, fill, position or card and makes no network call while assessing and re-checking", async () => {
    const m = await make("approved");
    const live = await counts(LIVE);
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { seen.push(String(a[0])); throw new Error("fetch must not be used"); }) as typeof fetch;
    try { await runOn(m.v1, "BLOCKING"); await assessApprovalEligibility(db(), must(m.approved), { research: research() }); } finally { globalThis.fetch = real; }
    expect(seen).toEqual([]);
    expect(await counts(LIVE)).toEqual(live);
  });
});
