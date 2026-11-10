import type { AgentEngineConfig } from "../config";
import type { AgentRunResult } from "../contract";
import type { OrchestrationOutcome } from "../orchestrator";
import { hashOf } from "../sanitize";
import { toSpecAgentReport, type SpecAgentReport } from "./specMapping";

/**
 * Candidate-path research run records (G-43, G-44).
 *  - G-43: `researchRunKey` identifies a research RUN by what it is made of (the candidate, the agent set with versions, each agent's input hash, the deterministic engine configuration), never by the clock or by provider data.
 *    A second attempt of the same run (a crash between saving the package and completing the queue item) therefore resolves to the package that is already stored instead of appending a duplicate version.
 *  - G-44: `toAgentRunRecords` turns every agent result of the run into one record (inputs, outputs, findings, evidence, status, versions, timing, synthesis metadata) that is stored WITH the package, in one transaction;
 *    `reconstructAgentResult` / `reportsFromRecords` rebuild the results and the package's per-agent reports from those records alone. Provider data is not stored: re-executing an agent against a provider is out of scope.
 */
export const RESEARCH_RUN_KEY_VERSION = "research-run-v1";

type KeyConfig = Pick<AgentEngineConfig, "version" | "requiredAgents" | "disabledAgents" | "weights" | "haltOn" | "thresholds">;
/** Deterministic identity of the run. Independent of the clock, the worker, concurrency settings and provider data. */
export function researchRunKey(candidateId: string, results: readonly Pick<AgentRunResult, "agentId" | "agentVersion" | "inputSnapshotRef">[], config: KeyConfig): string {
  return hashOf({
    v: RESEARCH_RUN_KEY_VERSION, candidateId,
    config: { version: config.version, requiredAgents: [...config.requiredAgents].sort(), disabledAgents: [...config.disabledAgents].sort(), weights: config.weights, haltOn: [...config.haltOn].sort(), thresholds: config.thresholds },
    agents: results.map((r) => [r.agentId, r.agentVersion, r.inputSnapshotRef]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  });
}

export interface AgentRunRecord {
  agentId: string; agentVersion: string; status: string; verdict: string; confidence: number | null; attempts: number; inputSnapshotRef: string; inputSnapshot: unknown; outputSnapshot: unknown;
  findings: unknown[]; evidence: unknown[]; meta: unknown; startedAt: Date; completedAt: Date; durationMs: number; errorCode: string | null; errorMessage: string | null;
}
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,60}$/;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
/** A value over its storage limit is replaced by a marker that says so (the input hash stays in `inputSnapshotRef`): research is never lost because one snapshot is large. */
const bounded = (v: unknown, max: number): unknown => (bytes(v) <= max ? v : { _truncated: true, bytes: bytes(v) });
/** The limits are set well under the table's size checks, which measure the jsonb TEXT form (a little longer than compact JSON). An oversize list keeps its leading items. */
const boundedList = (v: readonly unknown[], max: number): unknown[] => { const out = [...v]; while (out.length > 0 && bytes(out) > max) out.pop(); return out; };

export function toAgentRunRecords(outcome: Pick<OrchestrationOutcome, "results" | "metas">): AgentRunRecord[] {
  const meta = new Map(outcome.metas.map((m) => [m.agentId, m]));
  return outcome.results.map((r): AgentRunRecord => ({
    agentId: r.agentId, agentVersion: r.agentVersion, status: r.status, verdict: r.verdict, confidence: r.confidence, attempts: r.attempts, inputSnapshotRef: r.inputSnapshotRef,
    inputSnapshot: bounded(r.inputSnapshot, 40_000), outputSnapshot: bounded(r.outputSnapshot, 10_000), findings: boundedList(r.findings.slice(0, 20), 40_000), evidence: boundedList(r.evidence.slice(0, 20), 10_000), meta: bounded(meta.get(r.agentId) ?? {}, 2_000),
    startedAt: r.startedAt, completedAt: r.completedAt, durationMs: r.durationMs,
    errorCode: r.errorCode === null ? null : ERROR_CODE.test(r.errorCode) ? r.errorCode : "INVALID_ERROR_CODE", errorMessage: r.errorMessage === null ? null : r.errorMessage.slice(0, 300),
  })).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
}
/** The agent result as it was, rebuilt from its stored record. */
export function reconstructAgentResult(rec: AgentRunRecord): AgentRunResult {
  return {
    agentId: rec.agentId, agentVersion: rec.agentVersion, status: rec.status as AgentRunResult["status"], verdict: rec.verdict as AgentRunResult["verdict"], confidence: rec.confidence, findings: rec.findings as AgentRunResult["findings"],
    evidence: rec.evidence as AgentRunResult["evidence"], inputSnapshotRef: rec.inputSnapshotRef, inputSnapshot: rec.inputSnapshot as Record<string, unknown>, outputSnapshot: rec.outputSnapshot as Record<string, unknown>,
    startedAt: rec.startedAt, completedAt: rec.completedAt, durationMs: rec.durationMs, attempts: rec.attempts, errorCode: rec.errorCode, errorMessage: rec.errorMessage,
  };
}
/** The package's per-agent reports, rebuilt from the stored records alone (they must equal `package.reports`). */
export function reportsFromRecords(recs: readonly AgentRunRecord[]): SpecAgentReport[] {
  return recs.map((r) => toSpecAgentReport(reconstructAgentResult(r))).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
}
