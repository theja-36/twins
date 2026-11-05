import { AgentContractError } from "./contract";
import type { AgentEvent } from "./orchestrator";
import type { EngineResult } from "./record";
import { sanitizeText } from "./sanitize";
import { SNAPSHOT_SPECS } from "./snapshots";

/**
 * Agent-engine observability (Stage 5 / Task 9). Structured, redacted, BOUNDED log records for the engine run, built only from the orchestrator events and the engine result: ids, codes, counts, durations,
 * verdict names, assessments. It never logs message text, finding summaries or details, agent output, provider responses, file contents or secrets - only fixed-form codes (validated against an allow-list
 * pattern) and numbers - and it changes no verdict, no assessment and no approval behaviour. The logger is the existing structured logger (which additionally masks sensitive-looking keys and bounds values).
 *
 *   TWINS_AGENT_LOG_LEVEL   errors | summary | agents | debug   (default summary)
 *     errors  : agent_engine.run.failed, agent_engine.config.invalid
 *     summary : + ONE agent_engine.run.completed (or .reused) per run - status counts, verdict distribution, retries, timeouts, halt reason, a compact per-agent list (at most 20) -
 *               and agent_engine.providers once at start-up
 *     agents  : + agent_engine.run.started and one agent_engine.agent.finished (or .timed_out) per agent
 *     debug   : + agent_engine.agent.started and agent_engine.agent.attempt_failed
 * At the default level an engine run costs exactly one record, however many agents run.
 */
export const OBSERVABILITY_LEVELS = ["errors", "summary", "agents", "debug"] as const;
export type ObservabilityLevel = (typeof OBSERVABILITY_LEVELS)[number];
export interface ObservabilityConfig { level: ObservabilityLevel }
export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = { level: "summary" };
export function loadObservabilityConfig(env: Record<string, string | undefined> = process.env): ObservabilityConfig {
  const v = env["TWINS_AGENT_LOG_LEVEL"];
  if (v === undefined || v === "") return { ...DEFAULT_OBSERVABILITY_CONFIG };
  if (!(OBSERVABILITY_LEVELS as readonly string[]).includes(v)) throw new AgentContractError("INVALID_ENGINE_CONFIG", "invalid observability configuration: TWINS_AGENT_LOG_LEVEL");
  return { level: v as ObservabilityLevel };
}
const RANK: Record<ObservabilityLevel, number> = { errors: 0, summary: 1, agents: 2, debug: 3 };

/** The existing structured logger satisfies this shape. */
export interface ObserverLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const code = (v: unknown, fallback = "UNKNOWN"): string => (typeof v === "string" && CODE.test(v) ? v : fallback);
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
const MAX_AGENTS = 20;

interface AgentSeen { agentId: string; status: string; verdict: string; durationMs: number | null; attempts: number; errorCode: string | null }
export interface RunObserver {
  /** Pass to the orchestrator as `emit`. Never throws. */
  emit(e: AgentEvent): void;
  /** Call with the engine result (a disabled engine's `{ skipped }` is ignored). */
  completed(r: EngineResult): void;
  /** Call with the error that escaped the engine run (the caller still rethrows). */
  failed(error: unknown): void;
}
export function createRunObserver(log: ObserverLog, cfg: ObservabilityConfig, ref: { riskDecisionId: string }): RunObserver {
  const rank = RANK[cfg.level];
  const decisionId = uuid(ref.riskDecisionId);
  const agents: AgentSeen[] = [];
  let failedAttempts = 0, durationMs: number | null = null, started = false;
  const safe = (fn: () => void): void => { try { fn(); } catch { /* observability can never break the engine */ } };
  return {
    emit: (e) => safe(() => {
      if (e.type === "orchestrator.started") { started = true; if (rank >= RANK.agents) log.info("agent_engine.run.started", { riskDecisionId: decisionId, agents: num(e.agents) }); return; }
      if (e.type === "agent.started") { if (rank >= RANK.debug) log.info("agent_engine.agent.started", { riskDecisionId: decisionId, agentId: code(e.agentId), agentVersion: code(e.agentVersion) }); return; }
      if (e.type === "agent.attempt_failed") { failedAttempts += 1; if (rank >= RANK.debug) log.warn("agent_engine.agent.attempt_failed", { riskDecisionId: decisionId, agentId: code(e.agentId), attempt: num(e.attempt), errorCode: code(e.errorCode) }); return; }
      if (e.type === "agent.finished" || e.type === "agent.skipped") {
        const seen: AgentSeen = { agentId: code(e.agentId), status: code(e.status), verdict: code(e.verdict, "UNAVAILABLE"), durationMs: num(e.durationMs), attempts: num(e.attempt) ?? (e.type === "agent.skipped" ? 0 : 1), errorCode: e.errorCode === undefined ? null : code(e.errorCode) };
        agents.push(seen);
        if (rank >= RANK.agents) {
          const fields = { riskDecisionId: decisionId, agentId: seen.agentId, status: seen.status, verdict: seen.verdict, durationMs: seen.durationMs, attempts: seen.attempts, errorCode: seen.errorCode };
          if (seen.status === "TIMEOUT") log.warn("agent_engine.agent.timed_out", fields);
          else if (seen.status === "COMPLETED") log.info("agent_engine.agent.finished", fields); else log.warn("agent_engine.agent.finished", fields);
        }
        return;
      }
      if (e.type === "orchestrator.finished") durationMs = num(e.durationMs);
    }),
    completed: (r) => safe(() => {
      if (r.skipped) return;
      const res = r;
      if (!res.created) { if (rank >= RANK.summary) log.info("agent_engine.run.reused", { riskDecisionId: decisionId, runId: uuid(res.runId), assessment: code(res.assessment), halt: res.halt === true, haltReasonCode: code(res.haltReasonCode), agents: num(res.agents) }); return; }
      if (rank < RANK.summary) return;
      const statusCounts: Record<string, number> = {}, verdictDistribution: Record<string, number> = {};
      for (const a of agents) { statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1; verdictDistribution[a.verdict] = (verdictDistribution[a.verdict] ?? 0) + 1; }
      const bad = agents.filter((a) => a.status !== "COMPLETED").length;
      const fields = {
        riskDecisionId: decisionId, runId: uuid(res.runId), created: true, status: code(res.status), assessment: code(res.assessment), halt: res.halt === true, haltReasonCode: code(res.haltReasonCode), agents: num(res.agents), durationMs,
        statusCounts, verdictDistribution, timedOut: statusCounts["TIMEOUT"] ?? 0, notCompleted: bad, failedAttempts, agentList: agents.slice(0, MAX_AGENTS), agentListTruncated: agents.length > MAX_AGENTS, observedStart: started,
      };
      if (res.halt || bad > 0) log.warn("agent_engine.run.completed", fields); else log.info("agent_engine.run.completed", fields);
    }),
    failed: (error) => safe(() => {
      const c = (error as { code?: unknown } | null)?.code;
      const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      log.error("agent_engine.run.failed", { riskDecisionId: decisionId, errorCode: code(c, code(cause, "ENGINE_ERROR")), errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(error.name) ? error.name : "Error", completedAgents: agents.length });
    }),
  };
}

/** Records a configuration failure (the caller rethrows): the config name and a fixed code, plus a redacted, bounded message that names settings but never their values. */
export function logConfigInvalid(log: ObserverLog, name: string, error: unknown): void {
  try {
    const c = (error as { code?: unknown } | null)?.code;
    log.error("agent_engine.config.invalid", { config: code(name, "config"), errorCode: code(c, "INVALID_CONFIG"), errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(error.name) ? error.name : "Error", problem: sanitizeText(error instanceof Error ? error.message : "invalid", 160) });
  } catch { /* never break start-up reporting */ }
}
/** Loads a configuration, logging a redacted record before rethrowing when it is invalid. */
export function observeConfigLoad<T>(log: ObserverLog, name: string, load: () => T): T {
  try { return load(); } catch (e) { logConfigInvalid(log, name, e); throw e; }
}

export interface ProviderAvailability { configured: string[]; missing: string[]; providers: Record<string, string | null> }
/** Which providers the registry was given (by snapshot kind), from the provider objects themselves. */
export function providerAvailability(providers: Record<string, { name?: unknown } | null | undefined>): ProviderAvailability {
  const configured: string[] = [], missing: string[] = [], names: Record<string, string | null> = {};
  for (const s of SNAPSHOT_SPECS) {
    const p = providers[s.providerField];
    if (p) { configured.push(s.kind); names[s.kind] = typeof p.name === "string" ? sanitizeText(p.name, 60) : "provider"; } else { missing.push(s.kind); names[s.kind] = null; }
  }
  return { configured, missing, providers: names };
}
export function logProviderAvailability(log: ObserverLog, cfg: ObservabilityConfig, providers: Record<string, { name?: unknown } | null | undefined>, mode: { enabled: boolean; shadow: boolean }): ProviderAvailability {
  const a = providerAvailability(providers);
  if (RANK[cfg.level] >= RANK.summary) {
    const fields = { engineEnabled: mode.enabled, shadowEnabled: mode.shadow, configuredCount: a.configured.length, missingCount: a.missing.length, configured: a.configured, missing: a.missing, providerNames: a.configured.map((k) => `${k}=${a.providers[k] ?? ""}`) };
    if ((mode.enabled || mode.shadow) && a.missing.length > 0) log.warn("agent_engine.providers", fields); else log.info("agent_engine.providers", fields);
  }
  return a;
}
