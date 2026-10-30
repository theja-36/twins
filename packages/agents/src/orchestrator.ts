import { validateAgentOutput, AgentContractError, AgentUnavailableError, type AgentContext, type AgentDefinition, type AgentRunResult, type ContextInputKey } from "./contract";
import type { AgentEngineConfig } from "./config";
import type { ExecutionPlan } from "./registry";
import { frozenCopy, hashOf, sanitizeText } from "./sanitize";
import { buildSynthesisInput, synthesize, type AgentMeta, type SynthesisInput, type SynthesisResult } from "./synthesis";

/**
 * The orchestrator (Stage 5 / Task 1). Given a risk-decision context it resolves each agent's declared inputs, runs the agents along the dependency graph (independent agents in
 * parallel, bounded by `maxConcurrency`), applies per-agent timeouts and retry policies, ISOLATES failures (every agent runs in its own try/catch on frozen copies of its inputs;
 * one agent failing, timing out or misbehaving cannot change another's result) and returns every run plus a deterministic synthesis. It performs NO I/O of its own (persistence is
 * `record.ts`), calls no external API and grants no approval.
 */
export type AgentEventType = "orchestrator.started" | "agent.started" | "agent.attempt_failed" | "agent.finished" | "agent.skipped" | "orchestrator.finished";
/** Allow-listed event shape: identifiers, codes and numbers only - never free text, inputs or outputs. */
export interface AgentEvent { type: AgentEventType; agentId?: string; agentVersion?: string; attempt?: number; status?: string; verdict?: string; durationMs?: number; errorCode?: string; agents?: number; assessment?: string }
export interface OrchestrationDeps {
  emit?: (e: AgentEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}
export interface DecisionRef { riskDecisionId: string; decisionVersion: number }
export interface OrchestrationOutcome {
  results: AgentRunResult[];
  synthesisInput: SynthesisInput;
  synthesis: SynthesisResult;
  status: "COMPLETED" | "INCOMPLETE";
  startedAt: Date;
  completedAt: Date;
  metas: AgentMeta[];
}

class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(n: number) { this.free = n; }
  async acquire(): Promise<void> { if (this.free > 0) { this.free -= 1; return; } await new Promise<void>((r) => this.waiters.push(r)); }
  release(): void { const next = this.waiters.shift(); if (next) next(); else this.free += 1; }
}
class TimeoutMarker extends Error {}
const CODE = /^[A-Z][A-Z0-9_]{2,60}$/;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function orchestrate(plan: ExecutionPlan, config: AgentEngineConfig, inputs: Record<ContextInputKey, unknown>, ref: DecisionRef, deps: OrchestrationDeps = {}): Promise<OrchestrationOutcome> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const emit = (e: AgentEvent): void => { try { deps.emit?.(e); } catch { /* an event sink can never break an orchestration */ } };
  const startedAt = now();
  emit({ type: "orchestrator.started", agents: plan.agents.length });
  const sem = new Semaphore(config.maxConcurrency);
  const promises = new Map<string, Promise<AgentRunResult>>();

  const finish = (def: { contract: { agentId: string; version: string } }, snap: Record<string, unknown>, p: Partial<AgentRunResult> & Pick<AgentRunResult, "status" | "startedAt" | "attempts">): AgentRunResult => {
    const completedAt = now();
    const r: AgentRunResult = {
      agentId: def.contract.agentId, agentVersion: def.contract.version, verdict: "UNAVAILABLE", confidence: null, findings: [], evidence: [], inputSnapshotRef: hashOf(snap), inputSnapshot: snap, outputSnapshot: {},
      completedAt, durationMs: Math.max(0, completedAt.getTime() - p.startedAt.getTime()), errorCode: null, errorMessage: null, ...p,
    };
    emit({ type: r.status === "SKIPPED" ? "agent.skipped" : "agent.finished", agentId: r.agentId, agentVersion: r.agentVersion, status: r.status, verdict: r.verdict, durationMs: r.durationMs, attempt: r.attempts, ...(r.errorCode ? { errorCode: r.errorCode } : {}) });
    return r;
  };

  const runAgent = async (def: AgentDefinition, depResults: AgentRunResult[]): Promise<AgentRunResult> => {
    const c = def.contract;
    const declared = [...c.requiredInputs, ...c.optionalInputs];
    const snapshot: Record<string, unknown> = {};
    for (const k of declared) snapshot[k] = inputs[k] ?? null;
    const t0 = now();
    const missing = c.requiredInputs.find((k) => inputs[k] === null || inputs[k] === undefined);
    if (missing) return finish(def, snapshot, { status: "SKIPPED", startedAt: t0, attempts: 0, errorCode: "MISSING_REQUIRED_INPUT", errorMessage: `required input ${missing} is unavailable` });
    const notDone = depResults.find((d) => d.status !== "COMPLETED");
    if (notDone) return finish(def, snapshot, { status: "SKIPPED", startedAt: t0, attempts: 0, errorCode: "DEPENDENCY_NOT_COMPLETED", errorMessage: `dependency ${notDone.agentId} did not complete` });

    await sem.acquire();
    try {
      const startedAtAgent = now();
      emit({ type: "agent.started", agentId: c.agentId, agentVersion: c.version });
      let lastCode = "AGENT_ERROR", lastMessage = "the agent failed", lastTimeout = false;
      for (let attempt = 1; attempt <= c.retry.maxAttempts; attempt++) {
        const ac = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ctx: AgentContext = {
          agentId: c.agentId, attempt, signal: ac.signal, now: now(),
          inputs: frozenCopy(Object.fromEntries(declared.map((k) => [k, inputs[k] ?? null]))),
          dependencies: frozenCopy(Object.fromEntries(depResults.map((d) => [d.agentId, d]))),
        };
        try {
          const running = Promise.resolve().then(() => def.run(ctx));
          running.catch(() => undefined); // a late failure after a timeout must not become an unhandled rejection
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new TimeoutMarker()); }, c.timeoutMs); });
          const raw = await Promise.race([running, timeout]);
          const out = validateAgentOutput(c, raw);
          if (out.verdict === "UNAVAILABLE") return finish(def, snapshot, { status: "UNAVAILABLE", startedAt: startedAtAgent, attempts: attempt, findings: out.findings, evidence: out.evidence, outputSnapshot: out.output, errorCode: "AGENT_REPORTED_UNAVAILABLE" });
          return finish(def, snapshot, { status: "COMPLETED", startedAt: startedAtAgent, attempts: attempt, verdict: out.verdict, confidence: out.confidence, findings: out.findings, evidence: out.evidence, outputSnapshot: out.output });
        } catch (error) {
          if (error instanceof AgentUnavailableError) return finish(def, snapshot, { status: "UNAVAILABLE", startedAt: startedAtAgent, attempts: attempt, errorCode: CODE.test(error.code) ? error.code : "AGENT_UNAVAILABLE", errorMessage: sanitizeText(error.message, 200) });
          if (error instanceof AgentContractError) return finish(def, snapshot, { status: "FAILED", startedAt: startedAtAgent, attempts: attempt, errorCode: error.code, errorMessage: sanitizeText(error.message, 200) }); // a contract violation is not retried
          lastTimeout = error instanceof TimeoutMarker;
          const code = (error as { code?: unknown } | null)?.code;
          lastCode = lastTimeout ? "AGENT_TIMEOUT" : typeof code === "string" && CODE.test(code) ? code : "AGENT_ERROR";
          lastMessage = lastTimeout ? `timed out after ${c.timeoutMs} ms` : sanitizeText(error instanceof Error ? error.message : "the agent failed", 200);
          emit({ type: "agent.attempt_failed", agentId: c.agentId, agentVersion: c.version, attempt, errorCode: lastCode });
          if (attempt < c.retry.maxAttempts && c.retry.backoffMs > 0) await sleep(c.retry.backoffMs * attempt);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return finish(def, snapshot, { status: lastTimeout ? "TIMEOUT" : "FAILED", startedAt: startedAtAgent, attempts: c.retry.maxAttempts, errorCode: lastCode, errorMessage: lastMessage });
    } finally {
      sem.release();
    }
  };

  // plan.agents is ordered level by level, so every dependency's promise already exists when a dependent is started
  for (const def of plan.agents) {
    promises.set(def.contract.agentId, (async () => {
      const dependencies = await Promise.all(def.contract.dependsOn.map((d) => promises.get(d) as Promise<AgentRunResult>));
      try {
        return await runAgent(def, dependencies);
      } catch (error) { // defence in depth: an unexpected orchestrator-side fault is recorded for THIS agent only
        return finish(def, {}, { status: "FAILED", startedAt: now(), attempts: 0, errorCode: "ORCHESTRATOR_FAULT", errorMessage: sanitizeText(error instanceof Error ? error.message : "fault", 200) });
      }
    })());
  }
  const results = await Promise.all(plan.agents.map((d) => promises.get(d.contract.agentId) as Promise<AgentRunResult>));
  // required agents that cannot run at all are recorded as SKIPPED so the synthesis (and the audit trail) see them
  const t = now();
  for (const m of plan.missingRequired) {
    results.push({ agentId: m.agentId, agentVersion: "0.0.0", status: "SKIPPED", verdict: "UNAVAILABLE", confidence: null, findings: [], evidence: [], inputSnapshotRef: hashOf({}), inputSnapshot: {}, outputSnapshot: {}, startedAt: t, completedAt: t, durationMs: 0, attempts: 0, errorCode: m.reason === "DISABLED" ? "REQUIRED_AGENT_DISABLED" : "REQUIRED_AGENT_NOT_REGISTERED", errorMessage: "a required agent has no result" });
    emit({ type: "agent.skipped", agentId: m.agentId, status: "SKIPPED", errorCode: m.reason === "DISABLED" ? "REQUIRED_AGENT_DISABLED" : "REQUIRED_AGENT_NOT_REGISTERED" });
  }
  results.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  const metas: AgentMeta[] = [
    ...plan.agents.map((d) => ({ agentId: d.contract.agentId, agentVersion: d.contract.version, weight: config.weights[d.contract.agentId] ?? d.contract.weight, canBlock: d.contract.canBlock, advisoryOnly: d.contract.advisoryOnly, required: config.requiredAgents.includes(d.contract.agentId) })),
    ...plan.missingRequired.map((m) => ({ agentId: m.agentId, agentVersion: "0.0.0", weight: config.weights[m.agentId] ?? 0, canBlock: false, advisoryOnly: false, required: true })),
  ];
  const synthesisInput = buildSynthesisInput(ref, results, metas, config);
  const synthesis = synthesize(synthesisInput);
  const completedAt = now();
  emit({ type: "orchestrator.finished", assessment: synthesis.assessment, agents: results.length, durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()) });
  return { results, synthesisInput, synthesis, status: synthesis.assessment === "RESEARCH_INCOMPLETE" ? "INCOMPLETE" : "COMPLETED", startedAt, completedAt, metas };
}
