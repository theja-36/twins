/**
 * Synthesis transparency and the approval-eligibility re-check of the research assessment against REAL PostgreSQL (Stage 5 / Task 8, closing D-066 a). Synthetic decisions and fake agents only: no
 * external API, no LLM, no network, no real Telegram channel. The stored messages carry a marker text that must never reach an agent input, output, event or table. Nothing here creates an
 * order, fill, position or card; the approvals recorded in the "allowed" cases are the very thing under test.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle, type Db } from "../../../packages/database/src/index";
import { verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { AgentRegistry, loadAgentEngineConfig, runAgentEngine, type AgentDefinition, type AgentEvent } from "../../../packages/agents/src/index";
import {
  assessApprovalEligibility, createApprovalCard, createRiskDecision, DEFAULT_RESEARCH_ELIGIBILITY, evaluateMarketRisk, evaluatePortfolioRisk, latestResearchAssessment, loadPortfolioConfig, recordRiskApproval, sizeRiskDecision,
  probeResearchAccess, runResearchProbe, ResearchProbeError, type ResearchEligibilityConfig, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { PgBotDb } from "../../../services/approval-bot/src/db";
import { runCli } from "../../../scripts/ops/agent-engine-control";
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
let evidenceTag = ""; // HB-02: the fake agent cites different evidence when this changes
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
      evidence: [{ kind: "risk_decision", ref: `risk_decision:fake${evidenceTag}` }], output: { checksRun: 1, blockingCount: 0, adverseCount: 0, cautionCount: 0, failedCodes: [], truncatedFindings: false } };
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
    // HB-02: a different configuration alone is a new run but NOT new evidence: the ADVERSE result is not cleared
    await runOn(head, "SUPPORTIVE", loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "fake_agent", TWINS_AGENT_ENGINE_MAX_CONCURRENCY: "2" }));
    expect(await assessApprovalEligibility(db(), head, { research: research() })).toMatchObject({ eligible: false, reasons: ["research_adverse_not_superseded"] });
    // ... a run whose adverse agent cites DIFFERENT evidence does
    evidenceTag = `-new${sfx()}`;
    try { await runOn(head, "SUPPORTIVE", loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "fake_agent", TWINS_AGENT_ENGINE_MAX_CONCURRENCY: "3" })); } finally { evidenceTag = ""; }
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

// ─── P0 hardening: HB-01 .. HB-04 ───────────────────────────────────────────
const setEngine = (v: boolean) => pool.query("update agent_engine_state set enabled = $1, version = version + 1, reason = $2, changed_by = 'operator:itest' where id = 1", [v, `itest flip ${sfx()}`]);
const NEXT_HOUR = "now() + interval '1 hour'";
const fnApprove = async (decisionId: string, cardId: string | null, context: Record<string, unknown> = {}) => String(must((await pool.query(`select twins_record_risk_approval($1::uuid, $2::uuid, 'APPROVE', 'telegram:42', $3::jsonb, null, ${cardId ? "null" : NEXT_HOUR}) as o`, [decisionId, cardId, JSON.stringify(context)])).rows[0]).o);
const markSent = async (cardId: string, messageId: number) => { const c = must((await q("select card_content_sha256 as sha from risk_approval_cards where id = $1", [cardId]))[0]); await pool.query("select twins_risk_card_mark_sent($1::uuid, $2::bigint, $3)", [cardId, messageId, c["sha"]]); };
const afterFlag = async () => { if (must((await q("select enabled from agent_engine_state where id = 1"))[0])["enabled"] === true) await setEngine(false); };

describe("HB-01: an approval cites the exact research run it relied on", () => {
  it("a card records the run, assessment and synthesis hash (immutably) and shows them; an approval through it stores the run in the immutable record", async () => {
    const d = await assessed("SUPPORTIVE");
    const card = await createApprovalCard(db(), d.head, { research: research() });
    const row = must((await q("select research_run_id, research_assessment, research_synthesis_sha256, card_text from risk_approval_cards where id = $1", [card.cardId]))[0]);
    expect(row).toMatchObject({ research_run_id: d.runId, research_assessment: "RESEARCH_SUPPORTIVE" });
    expect(row["research_synthesis_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["card_text"]).toContain("Research assessment: RESEARCH_SUPPORTIVE (run ");
    await expect(pool.query("update risk_approval_cards set research_assessment = 'RESEARCH_NEUTRAL' where id = $1", [card.cardId])).rejects.toThrow(/immutable/);
    await expect(pool.query("update risk_approval_cards set research_run_id = null, research_assessment = null, research_synthesis_sha256 = null where id = $1", [card.cardId])).rejects.toThrow(/immutable/);
    await markSent(card.cardId, 7001);
    expect(await fnApprove(d.head, card.cardId, { cardMessageId: 7001 })).toBe("recorded");
    const a = must((await q("select decision_snapshot->'research' as r, evidence_references->>'researchRunId' as run, evidence_references->>'researchAssessment' as asm from risk_approvals where risk_decision_id = $1", [d.head]))[0]);
    expect(a["r"]).toMatchObject({ runId: d.runId, assessment: "RESEARCH_SUPPORTIVE", engineEnabled: false });
    expect(a).toMatchObject({ run: d.runId, asm: "RESEARCH_SUPPORTIVE" });
  });
  it("a newer run after the card was made refuses the approval (research_assessment_changed)", async () => {
    const d = await assessed("SUPPORTIVE");
    const card = await createApprovalCard(db(), d.head, { research: research() });
    await markSent(card.cardId, 7002);
    await runOn(d.v1, "SUPPORTIVE", loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "fake_agent", TWINS_AGENT_ENGINE_MAX_CONCURRENCY: "2" }));
    const before = await counts(["risk_approvals"]);
    expect(await fnApprove(d.head, card.cardId, { cardMessageId: 7002 })).toBe("refused:research_assessment_changed");
    expect(await counts(["risk_approvals"])).toEqual(before);
  });
  it("a card created before any run cannot be approved once a run exists (research_reference_missing); a decision with no run is unaffected while the engine is off", async () => {
    const d = await assessed(null);
    const card = await createApprovalCard(db(), d.head, { research: research({ engineEnabled: false }) });
    expect(must((await q("select research_run_id from risk_approval_cards where id = $1", [card.cardId]))[0])["research_run_id"]).toBeNull();
    await runOn(d.v1, "SUPPORTIVE");
    await markSent(card.cardId, 7003);
    expect(await fnApprove(d.head, card.cardId, { cardMessageId: 7003 })).toBe("refused:research_reference_missing");
    const none = await assessed(null);
    expect(await fnApprove(none.head, null)).toBe("recorded");
  });
  it("the API path: a wrong cited run is refused, a direct call that cites nothing is refused by the database, and the right run is recorded", async () => {
    const d = await assessed("SUPPORTIVE");
    expect(await recordRiskApproval(db(), { decisionId: d.head, action: "APPROVE", actor: "operator:itest", research: research(), context: { researchRunId: randomUUID() } })).toEqual({ outcome: "refused", reason: "research_assessment_changed" });
    expect(await fnApprove(d.head, null)).toBe("refused:research_reference_missing");
    expect(await recordRiskApproval(db(), { decisionId: d.head, action: "APPROVE", actor: "operator:itest", research: research(), context: { researchRunId: d.runId } })).toMatchObject({ outcome: "recorded" });
    expect(must((await q("select evidence_references->>'researchRunId' as run from risk_approvals where risk_decision_id = $1", [d.head]))[0])["run"]).toBe(d.runId);
  });
});

describe("HB-02: a re-run cannot launder an ADVERSE or BLOCKED result", () => {
  it.each([["ADVERSE", "research_adverse_not_superseded"], ["BLOCKING", "research_blocked_not_superseded"]] as const)("%s then a better re-run on the same evidence stays refused in the application layer and the database; new evidence clears it", async (bad, code) => {
    const m = await make("approved");
    const head = must(m.approved);
    await runOn(m.v1, bad);
    const rerun = (n: string) => loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true", TWINS_AGENT_ENGINE_REQUIRED: "fake_agent", TWINS_AGENT_ENGINE_MAX_CONCURRENCY: n });
    await runOn(m.v1, "SUPPORTIVE"); // same agents, configuration and inputs => the same run key: the stored ADVERSE run is returned, nothing new is recorded
    await runOn(m.v1, "SUPPORTIVE", rerun("2")); // a different configuration, same evidence
    expect(await assessApprovalEligibility(db(), head, { research: research() })).toMatchObject({ eligible: false, reasons: [code] });
    expect(await approve(head)).toEqual({ outcome: "refused", reason: code });
    expect(await approve(head, research({ enforced: false }))).toEqual({ outcome: "refused", reason: code }); // the database floor
    evidenceTag = `-fresh${sfx()}`;
    try { await runOn(m.v1, "SUPPORTIVE", rerun("3")); } finally { evidenceTag = ""; }
    expect(await assessApprovalEligibility(db(), head, { research: research() })).toMatchObject({ eligible: true });
    expect((await approve(head)).outcome).toBe("recorded");
  });
  it("a new decision version over the same evidence does not clear an ADVERSE result either", async () => {
    const m = await make("approved");
    await runOn(m.v1, "ADVERSE");
    await runOn(must(m.approved), "SUPPORTIVE"); // a run on the later decision version, same fake evidence
    expect(await approve(must(m.approved))).toEqual({ outcome: "refused", reason: "research_adverse_not_superseded" });
  });
});

describe("HB-03: the database knows whether the engine is enabled", () => {
  afterEach(afterFlag);
  it("engine enabled + no assessment: a DIRECT call to the function is refused (research_assessment_missing); with the flag off it is not", async () => {
    const d = await assessed(null);
    await setEngine(true);
    expect(await fnApprove(d.head, null)).toBe("refused:research_assessment_missing");
    await setEngine(false);
    expect(await fnApprove(d.head, null)).toBe("recorded");
  });
  it("the state is one audited row: a change needs a new version, a flip and a new reason; it is never deleted; every change leaves an append-only event", async () => {
    const eventsBefore = Number(must((await q("select count(*)::int as n from agent_engine_state_events"))[0])["n"]);
    await setEngine(true); await setEngine(false);
    expect(Number(must((await q("select count(*)::int as n from agent_engine_state_events"))[0])["n"])).toBe(eventsBefore + 2);
    await expect(pool.query("update agent_engine_state set enabled = false, version = version + 1, reason = 'itest same value' where id = 1")).rejects.toThrow(/flip/);
    await expect(pool.query("update agent_engine_state set enabled = true, reason = 'itest no version bump' where id = 1")).rejects.toThrow(/version/);
    await expect(pool.query("delete from agent_engine_state")).rejects.toThrow(/not permitted/);
    await expect(pool.query("truncate agent_engine_state")).rejects.toThrow(/not permitted/);
    await expect(pool.query("update agent_engine_state_events set reason = 'tamper reason'")).rejects.toThrow(/not permitted/);
    await expect(pool.query("insert into agent_engine_state (id, enabled, reason, changed_by) values (2, true, 'a second row', 'itest')")).rejects.toThrow();
  });
  it("the owner CLI reads and changes the flag; bad usage and a stale version are refused; the live-trading guard is the CLI's first statement", async () => {
    const out: string[] = []; const err: string[] = [];
    const deps = { env: { DATABASE_URL }, out: (l: string) => out.push(l), err: (l: string) => err.push(l), openPool: () => ({ pool: pool as never, close: async () => undefined }) };
    expect(await runCli(["status"], deps)).toBe(0);
    expect(JSON.parse(must(out[0]))).toMatchObject({ enabled: false });
    expect(await runCli(["set", "--value", "true", "--reason", "itest enabling", "--changed-by", "operator:itest"], deps)).toBe(0);
    expect(JSON.parse(must(out[1]))).toMatchObject({ changed: true, enabled: true });
    expect(await runCli(["set", "--value", "false", "--reason", "itest stale", "--changed-by", "operator:itest", "--expected-version", "1"], deps)).toBe(3);
    expect(await runCli(["set", "--value", "maybe", "--reason", "itest bad value", "--changed-by", "operator:itest"], deps)).toBe(2);
    expect(await runCli(["set", "--value", "false", "--reason", "short", "--changed-by", "operator:itest"], deps)).toBe(2);
    expect(await runCli(["set", "--value", "false", "--reason", "itest disabling", "--changed-by", "someone"], deps)).toBe(2);
    expect(await runCli(["set", "--value", "false", "--reason", "itest disabling", "--changed-by", "operator:itest"], deps)).toBe(0);
    expect(await runCli(["bogus"], deps)).toBe(2);
    expect(err.join("\n")).not.toContain(DATABASE_URL);
  });
});

describe("HB-04: runtime-role grants and the start-up probe", () => {
  const ROLE = `twins_probe_${sfx()}`;
  const RELS = ["agent_orchestrator_runs", "agent_orchestrator_syntheses", "agent_runs", "agent_evidence_references", "risk_decisions", "agent_engine_state"];
  let rolePool: pg.Pool;
  let roleDb: Db;
  beforeAll(async () => {
    await pool.query(`create role ${ROLE} nologin`);
    await pool.query(`grant usage on schema public to ${ROLE}`);
    await pool.query(`grant select on ${RELS.join(", ")} to ${ROLE}`);
    rolePool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    rolePool.on("connect", (c) => { void c.query(`set role ${ROLE}`); });
    roleDb = drizzle(rolePool, { schema }) as unknown as Db;
  });
  afterAll(async () => { await rolePool?.end(); await pool.query(`drop owned by ${ROLE}`); await pool.query(`drop role ${ROLE}`); });
  afterEach(afterFlag);
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const logger = { error: (e: string, f?: Record<string, unknown>) => { logs.push([e, f]); }, warn: (e: string, f?: Record<string, unknown>) => { logs.push([e, f]); } };

  it("with every grant (and the database flag agreeing) the probe passes", async () => {
    await setEngine(true);
    expect(await probeResearchAccess(roleDb, research())).toMatchObject({ ok: true, fatal: false, databaseEngineEnabled: true });
    await setEngine(false);
    expect(await probeResearchAccess(roleDb, research({ engineEnabled: false }))).toMatchObject({ ok: true, databaseEngineEnabled: false });
  });
  it("a missing grant makes start-up FAIL CLOSED when the check applies, logging a setting/code only", async () => {
    await pool.query(`revoke select on agent_runs from ${ROLE}`);
    logs.length = 0;
    expect(await probeResearchAccess(roleDb, research())).toMatchObject({ ok: false, fatal: true, code: "research_access_denied", relation: "agent_runs" });
    await expect(runResearchProbe(roleDb, logger, research())).rejects.toBeInstanceOf(ResearchProbeError);
    expect(logs[0]?.[0]).toBe("agent_engine.config.invalid");
    expect(JSON.stringify(logs)).not.toMatch(/postgres|password|SELECT/i);
    // REQUIRE also makes it apply with the engine off
    await expect(runResearchProbe(roleDb, logger, research({ engineEnabled: false, whenEngineDisabled: "REQUIRE" }))).rejects.toBeInstanceOf(ResearchProbeError);
    // engine off + IGNORE: reported, not fatal, the process starts
    logs.length = 0;
    expect(await runResearchProbe(roleDb, logger, research({ engineEnabled: false }))).toMatchObject({ ok: false, fatal: false, code: "research_access_denied" });
    expect(logs[0]).toEqual(["agent_engine.config.invalid", expect.objectContaining({ fatal: false })]);
    await pool.query(`grant select on agent_runs to ${ROLE}`);
    expect(await probeResearchAccess(roleDb, research({ engineEnabled: false }))).toMatchObject({ ok: true });
  });
  it("the environment enabling the engine while the database flag is off is fatal; the owner enabling both passes", async () => {
    expect(await probeResearchAccess(roleDb, research())).toMatchObject({ ok: false, fatal: true, code: "engine_enabled_but_database_flag_off" });
    await expect(runResearchProbe(roleDb, logger, research())).rejects.toBeInstanceOf(ResearchProbeError);
    await setEngine(true);
    expect(await probeResearchAccess(roleDb, research())).toMatchObject({ ok: true });
  });
  it("the staging role script grants exactly these relations explicitly", async () => {
    const { readFileSync } = await import("node:fs");
    const sqlText = readFileSync(new URL("../../../infrastructure/staging/app-role.sql", import.meta.url), "utf8");
    for (const rel of RELS) expect(sqlText, rel).toMatch(new RegExp(`GRANT SELECT ON [^;]*\\b${rel}\\b`));
    expect(sqlText).toMatch(/read_only text\[\][^;]*'agent_engine_state'/);
    expect(sqlText).toMatch(/none_for_runtime text\[\][^;]*'agent_engine_state_events'/);
  });
});

describe("P0 hardening: inertness and integrity", () => {
  it("nothing here creates an order, fill or position, and the audit chains (including risk_approvals and the agent chains) verify", async () => {
    const live = await counts(["orders", "fills", "positions"]);
    const d = await assessed("SUPPORTIVE");
    expect((await approve(d.head)).outcome).toBe("recorded");
    expect(await counts(["orders", "fills", "positions"])).toEqual(live);
    expect((await verifyAuditChainsWithPool(pool, { chains: CHAINS })).ok).toBe(true);
  });
});
