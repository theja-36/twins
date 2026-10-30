import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { deriveFeatures } from "@twins/historical";
import { getRevisionStates, originOf } from "@twins/ingestion";
import { getRiskDecision, intelligenceOf, refuseUnlessSafe, RiskDecisionError, type RiskDecisionRecord } from "@twins/risk";
import type { AgentEngineConfig, ResearchAssessment } from "./config";
import type { ContextInputKey } from "./contract";
import { orchestrate, type OrchestrationDeps } from "./orchestrator";
import type { AgentRegistry } from "./registry";
import { hashOf, sanitizeText } from "./sanitize";

/**
 * Runs the agent engine for a risk decision and persists the result (Stage 5 / Task 1). DISABLED by default: when the configuration says so this returns immediately and touches
 * nothing (the risk flow is exactly as before). When enabled it checks the runtime state first (kill switch / intake / unreadable state => refused, nothing read or written), builds
 * the agents' inputs from PARSED fields only (never message text), runs the orchestrator in memory, then writes the whole run in one transaction to the append-only, hash-chained
 * tables. The research assessment is evidence for the later gates, never an approval; this module creates no risk decision, approval, card, order, fill or position and calls no
 * network. A database or runtime-state error propagates: the caller fails closed.
 */
export const AGENT_ENGINE_ACTOR = "service:agent-engine";
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export interface EngineDeps extends OrchestrationDeps {
  registry: AgentRegistry;
  config: AgentEngineConfig;
  trigger?: "WORKER_PIPELINE" | "OPERATOR";
}
export type EngineResult =
  | { skipped: "ENGINE_DISABLED" }
  | { skipped?: undefined; runId: string; created: boolean; riskDecisionId: string; status: "COMPLETED" | "INCOMPLETE" | "FAILED"; assessment: ResearchAssessment; halt: boolean; /** Why the flow halts or continues (`HALT_<rule>` | `NO_HALT`); `UNKNOWN` for a run stored before synthesis v2. */ haltReasonCode: string; agents: number };

/** Allow-listed, text-free inputs for the agents. */
export async function buildDecisionInputs(db: Db, d: RiskDecisionRecord): Promise<Record<ContextInputKey, unknown>> {
  const targets = [d.target1, d.target2, d.target3].map(num).filter((x): x is number => x !== null);
  const i = intelligenceOf(d);
  const [stop] = await db.select().from(schema.stopLossValidations).where(d.signalId ? eq(schema.stopLossValidations.signalId, d.signalId) : eq(schema.stopLossValidations.optionsClaimId, d.optionsClaimId as string)).orderBy(desc(schema.stopLossValidations.createdAt), desc(schema.stopLossValidations.id)).limit(1);
  const asOf = i?.asOf ? new Date(i.asOf) : d.createdAt;
  return {
    risk_decision: {
      id: d.id, version: d.decisionVersion, status: d.status, instrumentType: d.instrumentType, market: d.market, symbol: d.symbol, side: d.side, entryPrice: num(d.entryPrice), stopLoss: num(d.stopLoss), stopLossBasis: d.stopLossBasis,
      targets, expiry: d.expiry, strike: num(d.strike), optionType: d.optionType, createdAt: d.createdAt.toISOString(),
    },
    source_intelligence: i ? {
      status: i.status, reasonCode: i.reasonCode, sourceRegistered: i.sourceIdentity.registered, trust: { tier: i.trust.tier, asOf: i.trust.asOf, scorecardRunId: i.trust.scorecardRunId },
      confidence: { score: i.confidence.score, tier: i.confidence.tier, evidenceQuality: i.confidence.evidenceQuality, sampleSize: i.confidence.sampleSize, primaryPatternKey: i.confidence.primaryPatternKey },
      dataSufficiency: i.dataSufficiency, asOf: i.asOf,
    } : null,
    stop_loss_validation: stop ? { id: stop.id, result: stop.result, reasonCode: stop.reasonCode, levelBasis: stop.levelBasis, riskPct: num(stop.riskPct), ruleVersion: stop.ruleVersion } : null,
    signal_context: await buildSignalContext(db, d),
    signal_features: deriveFeatures({ market: d.market, instrumentType: d.instrumentType, underlying: d.symbol, optionType: d.optionType, side: d.side, entry: d.entryPrice === null ? null : { type: "at", price: Number(d.entryPrice) }, stopLoss: num(d.stopLoss), targets, expiryDate: d.expiry, timestamp: asOf }),
  };
}


export interface SignalContext {
  subject: "signal" | "options_claim";
  /** When the signal was sent (null if unknown - an agent must not guess it). */
  signalTimestamp: string | null;
  messageLinked: boolean;
  revision: { known: boolean; otherVersions: number; state: "current" | "superseded" | "ambiguous" | "unknown"; anyAmbiguous: boolean; levelsChanged: boolean | null };
  entryType: string | null;
  parserVersion: string | null;
}
/** Signal time and revision state from stored, deterministic data (no message text). */
export async function buildSignalContext(db: Db, d: RiskDecisionRecord): Promise<SignalContext> {
  let messageId: string | null = null, ts: Date | null = null, entryType: string | null = null, parserVersion: string | null = null;
  const fingerprint = (x: { direction: string; entryPrice: unknown; stopLoss: unknown; targets: unknown }): string => JSON.stringify([x.direction, num(x.entryPrice), num(x.stopLoss), x.targets ?? null]);
  let mine: string | null = null;
  if (d.signalId) {
    const [s] = await db.select().from(schema.signals).where(eq(schema.signals.id, d.signalId));
    messageId = s?.telegramMessageId ?? null; ts = s?.signalTimestamp ?? null; entryType = s ? "at" : null; parserVersion = s?.parserVersion ?? null;
    mine = s ? fingerprint(s) : null;
  } else {
    const [c] = await db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.id, d.optionsClaimId as string));
    messageId = c?.telegramMessageId ?? null; parserVersion = c?.parserVersion ?? null;
    entryType = (c?.claim as { entry?: { type?: string } } | null)?.entry?.type ?? null;
  }
  const base = { subject: (d.signalId ? "signal" : "options_claim") as SignalContext["subject"], entryType, parserVersion };
  if (!messageId) return { ...base, signalTimestamp: ts?.toISOString() ?? null, messageLinked: false, revision: { known: false, otherVersions: 0, state: "unknown", anyAmbiguous: false, levelsChanged: null } };
  const [m] = await db.select({ id: schema.telegramMessages.id, source: schema.telegramMessages.telegramSourceId, external: schema.telegramMessages.externalMessageId, origin: schema.telegramMessages.originMessageId, at: schema.telegramMessages.messageTimestamp }).from(schema.telegramMessages).where(eq(schema.telegramMessages.id, messageId));
  if (!m) return { ...base, signalTimestamp: ts?.toISOString() ?? null, messageLinked: false, revision: { known: false, otherVersions: 0, state: "unknown", anyAmbiguous: false, levelsChanged: null } };
  const states = await getRevisionStates(db, m.source, originOf({ externalMessageId: m.external, originMessageId: m.origin }));
  const me = states.find((x) => x.id === m.id);
  const others = states.filter((x) => x.id !== m.id).map((x) => x.id);
  let levelsChanged: boolean | null = null;
  if (d.signalId && mine !== null) {
    levelsChanged = false;
    if (others.length > 0) {
      const sibs = await db.select().from(schema.signals).where(and(inArray(schema.signals.telegramMessageId, others)));
      levelsChanged = sibs.some((x) => fingerprint(x) !== mine);
    }
  }
  return { ...base, signalTimestamp: (ts ?? m.at).toISOString(), messageLinked: true, revision: { known: me !== undefined, otherVersions: others.length, state: me?.state ?? "unknown", anyAmbiguous: states.some((x) => x.state === "ambiguous"), levelsChanged } };
}

const configSnapshot = (c: AgentEngineConfig): Record<string, unknown> => ({ version: c.version, requiredAgents: c.requiredAgents, disabledAgents: c.disabledAgents, weights: c.weights, maxConcurrency: c.maxConcurrency, haltOn: c.haltOn, thresholds: c.thresholds });

export async function runAgentEngine(db: Db, decisionId: string, deps: EngineDeps): Promise<EngineResult> {
  const { config, registry } = deps;
  if (!config.enabled) return { skipped: "ENGINE_DISABLED" }; // nothing is read, written or logged
  await refuseUnlessSafe("agent_engine.run"); // fail closed before anything is read or written
  const decision = await getRiskDecision(db, decisionId);
  if (!decision) throw new RiskDecisionError("not_found", "the risk decision does not exist");
  const inputs = await buildDecisionInputs(db, decision);
  const plan = registry.resolve(config); // throws on a mis-wired graph: a broken engine must not run
  const cfg = configSnapshot(config);
  const configSha256 = hashOf(cfg);
  const inputSha256 = hashOf(inputs);
  const contracts = plan.agents.map((a) => ({ contract: a.contract, sha: hashOf(a.contract) }));
  const agentSet = [...contracts.map((c) => ({ agentId: c.contract.agentId, version: c.contract.version, contractSha256: c.sha })), ...plan.missingRequired.map((m) => ({ agentId: m.agentId, version: "0.0.0", contractSha256: null, missing: m.reason }))].sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  const runKey = hashOf({ decisionId: decision.id, decisionVersion: decision.decisionVersion, agentSet, configSha256, inputSha256 });
  const O = schema.agentOrchestratorRuns, S = schema.agentOrchestratorSyntheses;
  const reasonOf = (result: unknown, assessment: ResearchAssessment): string => { const code = (result as { halt?: { reasonCode?: unknown } } | null)?.halt?.reasonCode; return typeof code === "string" && /^[A-Z_]{1,60}$/.test(code) ? code : config.haltOn.includes(assessment) ? "UNKNOWN" : "NO_HALT"; };
  const outputOf = (runId: string, assessment: ResearchAssessment, status: "COMPLETED" | "INCOMPLETE" | "FAILED", created: boolean, result?: unknown): EngineResult => ({ runId, created, riskDecisionId: decision.id, status, assessment, halt: config.haltOn.includes(assessment), haltReasonCode: reasonOf(result, assessment), agents: agentSet.length });
  const [existing] = await db.select({ id: O.id, status: O.status, assessment: S.assessment, result: S.result }).from(O).innerJoin(S, eq(S.orchestratorRunId, O.id)).where(eq(O.runKey, runKey));
  if (existing) return outputOf(existing.id, existing.assessment as ResearchAssessment, existing.status as "COMPLETED" | "INCOMPLETE", false, existing.result); // the same evaluation: no agent is re-run

  const outcome = await orchestrate(plan, config, inputs, { riskDecisionId: decision.id, decisionVersion: decision.decisionVersion }, deps);

  const D = schema.agentDefinitions;
  const definitionIds = new Map<string, string>();
  for (const c of contracts) {
    const [ins] = await db.insert(D).values({ agentId: c.contract.agentId, agentVersion: c.contract.version, contractVersion: "agent-contract-v1", contract: c.contract, contractSha256: c.sha, createdBy: AGENT_ENGINE_ACTOR }).onConflictDoNothing().returning({ id: D.id });
    const [row] = ins ? [ins] : await db.select({ id: D.id }).from(D).where(eq(D.contractSha256, c.sha));
    if (row) definitionIds.set(c.contract.agentId, row.id);
  }
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [dup] = await tx.select({ id: O.id }).from(O).where(eq(O.runKey, runKey));
    if (dup) { // a concurrent worker finished the same evaluation first
      const [s] = await tx.select({ assessment: S.assessment, result: S.result }).from(S).where(eq(S.orchestratorRunId, dup.id));
      return outputOf(dup.id, (s?.assessment ?? "RESEARCH_INCOMPLETE") as ResearchAssessment, "COMPLETED", false, s?.result);
    }
    const [run] = await tx.insert(O).values({
      runKey, riskDecisionId: decision.id, decisionVersion: decision.decisionVersion, trigger: deps.trigger ?? "WORKER_PIPELINE", triggerContext: { source: "risk_decision_flow", afterStage: decision.createdBy.replace(/^service:/, "") }, agentSet,
      config: cfg, configSha256, inputSnapshot: inputs, inputSha256, status: outcome.status, startedAt: outcome.startedAt, completedAt: outcome.completedAt, durationMs: Math.max(0, outcome.completedAt.getTime() - outcome.startedAt.getTime()), createdBy: AGENT_ENGINE_ACTOR,
    }).onConflictDoNothing({ target: O.runKey }).returning({ id: O.id });
    if (!run) return outputOf((await tx.select({ id: O.id }).from(O).where(eq(O.runKey, runKey)))[0]?.id as string, outcome.synthesis.assessment, outcome.status, false, outcome.synthesis);
    for (const r of outcome.results) {
      const [ar] = await tx.insert(schema.agentRuns).values({
        orchestratorRunId: run.id, definitionId: definitionIds.get(r.agentId) ?? null, agentId: r.agentId, agentVersion: r.agentVersion, status: r.status, verdict: r.verdict, confidence: r.confidence === null ? null : r.confidence.toFixed(2), attempts: r.attempts,
        inputSnapshotRef: r.inputSnapshotRef, inputSnapshot: r.inputSnapshot, outputSnapshot: r.outputSnapshot, startedAt: r.startedAt, completedAt: r.completedAt, durationMs: r.durationMs, errorCode: r.errorCode, errorMessage: r.errorMessage === null ? null : sanitizeText(r.errorMessage, 200), createdBy: AGENT_ENGINE_ACTOR,
      }).returning({ id: schema.agentRuns.id });
      const runId = (ar as { id: string }).id;
      for (const [n, f] of r.findings.entries()) await tx.insert(schema.agentFindings).values({ agentRunId: runId, ordinal: n, code: f.code, severity: f.severity, summary: f.summary, detail: f.detail ?? {}, createdBy: AGENT_ENGINE_ACTOR });
      for (const [n, e] of r.evidence.entries()) await tx.insert(schema.agentEvidenceReferences).values({ agentRunId: runId, ordinal: n, kind: e.kind, ref: e.ref, refSha256: e.sha256 ?? null, createdBy: AGENT_ENGINE_ACTOR });
    }
    const s = outcome.synthesis;
    await tx.insert(S).values({
      orchestratorRunId: run.id, assessment: s.assessment, score: s.score === null ? null : s.score.toFixed(6), algorithmVersion: s.algorithmVersion, synthesisInput: outcome.synthesisInput, synthesisInputSha256: s.inputSha256, result: s, grantsApproval: false, createdBy: AGENT_ENGINE_ACTOR,
    });
    return outputOf(run.id, s.assessment, outcome.status, true, s);
  });
}

/** Read model: the latest orchestrator run for a decision with its assessment (no inputs, no outputs). */
export async function getLatestAgentAssessment(db: Db, riskDecisionId: string): Promise<{ runId: string; decisionVersion: number; status: string; assessment: string; score: string | null; agents: Array<{ agentId: string; agentVersion: string; status: string; verdict: string; confidence: string | null; errorCode: string | null }> } | undefined> {
  const O = schema.agentOrchestratorRuns, S = schema.agentOrchestratorSyntheses;
  const [r] = await db.select({ id: O.id, v: O.decisionVersion, status: O.status, assessment: S.assessment, score: S.score }).from(O).innerJoin(S, eq(S.orchestratorRunId, O.id)).where(eq(O.riskDecisionId, riskDecisionId)).orderBy(desc(O.createdAt), desc(O.id)).limit(1);
  if (!r) return undefined;
  const agents = await db.select({ agentId: schema.agentRuns.agentId, agentVersion: schema.agentRuns.agentVersion, status: schema.agentRuns.status, verdict: schema.agentRuns.verdict, confidence: schema.agentRuns.confidence, errorCode: schema.agentRuns.errorCode }).from(schema.agentRuns).where(eq(schema.agentRuns.orchestratorRunId, r.id));
  return { runId: r.id, decisionVersion: r.v, status: r.status, assessment: r.assessment, score: r.score, agents: agents.sort((a, b) => (a.agentId < b.agentId ? -1 : 1)) };
}
