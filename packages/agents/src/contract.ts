import { sanitizeText, stableStringify } from "./sanitize";

/**
 * The agent contract (Stage 5 / Task 1), version `agent-contract-v1`. A STRICT, versioned declaration every agent must satisfy before it can be registered, and a strict shape every
 * agent run must return. No agent is implemented here; this is the foundation. An agent never receives raw message text: only the closed set of parsed context inputs below.
 */
export const AGENT_CONTRACT_VERSION = "agent-contract-v1";
export const AGENT_STATUSES = ["COMPLETED", "FAILED", "TIMEOUT", "SKIPPED", "UNAVAILABLE"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AGENT_VERDICTS = ["SUPPORTIVE", "NEUTRAL", "CAUTION", "ADVERSE", "BLOCKING", "UNAVAILABLE"] as const;
export type AgentVerdict = (typeof AGENT_VERDICTS)[number];
/** The inputs the orchestrator can resolve from a risk-decision context (parsed fields, tiers and numbers only). */
export const CONTEXT_INPUT_KEYS = ["risk_decision", "source_intelligence", "stop_loss_validation", "signal_features"] as const;
export type ContextInputKey = (typeof CONTEXT_INPUT_KEYS)[number];
export const FINDING_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type OutputFieldType = "string" | "number" | "boolean" | "string[]" | "number[]";

export interface AgentContract {
  agentId: string;
  agentName: string;
  /** Semantic version `major.minor.patch`. */
  version: string;
  requiredInputs: ContextInputKey[];
  optionalInputs: ContextInputKey[];
  /** The closed set of keys the agent's `output` snapshot may contain. Unknown keys / wrong types are a contract violation. */
  outputSchema: { fields: Record<string, { type: OutputFieldType; required?: boolean }> };
  timeoutMs: number;
  retry: { maxAttempts: number; backoffMs: number };
  /** Contribution weight in the synthesis, 0-100. */
  weight: number;
  /** May return BLOCKING (and so cause RESEARCH_BLOCKED). Never combinable with advisoryOnly. */
  canBlock: boolean;
  /** Informational only: reported by the synthesis but never scored and never able to block. */
  advisoryOnly: boolean;
  /** Agents whose COMPLETED result this agent needs (run order + data). */
  dependsOn: string[];
}
export interface AgentFinding { code: string; severity: FindingSeverity; summary: string; detail?: Record<string, string | number | boolean | null> }
export interface AgentEvidence { kind: string; ref: string; sha256?: string }
export interface AgentOutput { verdict: AgentVerdict; confidence: number; findings: AgentFinding[]; evidence: AgentEvidence[]; output: Record<string, unknown> }
export interface AgentContext {
  agentId: string;
  /** Only the inputs the contract declares, as frozen copies. */
  inputs: Readonly<Record<string, unknown>>;
  /** Frozen COMPLETED results of the agents it depends on. */
  dependencies: Readonly<Record<string, AgentRunResult>>;
  attempt: number;
  /** Aborted when the attempt times out; a well-behaved agent stops work. Its late result is ignored regardless. */
  signal: AbortSignal;
}
export interface AgentDefinition { contract: AgentContract; run(ctx: AgentContext): Promise<AgentOutput> }
export interface AgentRunResult {
  agentId: string;
  agentVersion: string;
  status: AgentStatus;
  verdict: AgentVerdict;
  /** 0-100; null unless COMPLETED. */
  confidence: number | null;
  findings: AgentFinding[];
  evidence: AgentEvidence[];
  /** sha256 of the canonical input snapshot the agent was given. */
  inputSnapshotRef: string;
  inputSnapshot: Record<string, unknown>;
  outputSnapshot: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export class AgentContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentContractError";
  }
}
/** Thrown by an agent that cannot evaluate (no data, dependency down): recorded as UNAVAILABLE, never retried. */
export class AgentUnavailableError extends Error {
  constructor(readonly code: string = "AGENT_UNAVAILABLE", message = "the agent cannot evaluate this context") {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

const AGENT_ID = /^[a-z][a-z0-9_]{2,40}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,60}$/;
const KIND = /^[a-z][a-z0-9_]{1,30}$/;
const REF = /^[A-Za-z0-9_.:/#@=-]{1,200}$/;
const FIELD = /^[a-z][A-Za-z0-9_]{0,40}$/;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const fail = (code: string, msg: string): never => { throw new AgentContractError(code, msg); };
const inputList = (v: unknown, name: string): ContextInputKey[] => {
  if (!Array.isArray(v) || v.some((k) => !(CONTEXT_INPUT_KEYS as readonly unknown[]).includes(k)) || new Set(v).size !== v.length) return fail("INVALID_INPUT_DECLARATION", `${name} must be a list of distinct known context inputs`);
  return [...v] as ContextInputKey[];
};

/** Validates (and returns a normalized copy of) an agent contract. Throws AgentContractError with a fixed code. */
export function validateAgentContract(raw: unknown): AgentContract {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("CONTRACT_NOT_AN_OBJECT", "the contract must be an object");
  const c = raw as Record<string, unknown>;
  if (typeof c["agentId"] !== "string" || !AGENT_ID.test(c["agentId"])) fail("INVALID_AGENT_ID", "agentId must be lower_snake_case, 3-41 characters");
  if (typeof c["agentName"] !== "string" || c["agentName"].trim().length < 3 || c["agentName"].length > 80 || sanitizeText(c["agentName"], 80) !== c["agentName"].trim()) fail("INVALID_AGENT_NAME", "agentName must be 3-80 plain characters");
  if (typeof c["version"] !== "string" || !VERSION.test(c["version"])) fail("INVALID_VERSION", "version must be major.minor.patch");
  const requiredInputs = inputList(c["requiredInputs"], "requiredInputs");
  const optionalInputs = inputList(c["optionalInputs"], "optionalInputs");
  if (requiredInputs.some((k) => optionalInputs.includes(k))) fail("INVALID_INPUT_DECLARATION", "an input cannot be both required and optional");
  const schema = c["outputSchema"] as { fields?: Record<string, { type?: unknown; required?: unknown }> } | undefined;
  if (!schema || typeof schema !== "object" || typeof schema.fields !== "object" || schema.fields === null || Array.isArray(schema.fields)) return fail("INVALID_OUTPUT_SCHEMA", "outputSchema.fields is required");
  const fields: AgentContract["outputSchema"]["fields"] = {};
  const names = Object.keys(schema.fields);
  if (names.length > 30) fail("INVALID_OUTPUT_SCHEMA", "at most 30 output fields");
  for (const n of names) {
    const f = schema.fields[n] as { type?: unknown; required?: unknown };
    if (!FIELD.test(n) || !f || !["string", "number", "boolean", "string[]", "number[]"].includes(f.type as string) || (f.required !== undefined && typeof f.required !== "boolean")) fail("INVALID_OUTPUT_SCHEMA", `output field ${sanitizeText(n, 40)} is malformed`);
    fields[n] = { type: f.type as OutputFieldType, ...(f.required === true ? { required: true } : {}) };
  }
  if (!isInt(c["timeoutMs"], 50, 120_000)) fail("INVALID_TIMEOUT", "timeoutMs must be a whole number from 50 to 120000");
  const retry = c["retry"] as { maxAttempts?: unknown; backoffMs?: unknown } | undefined;
  if (!retry || !isInt(retry.maxAttempts, 1, 5) || !isInt(retry.backoffMs, 0, 30_000)) fail("INVALID_RETRY_POLICY", "retry needs maxAttempts 1-5 and backoffMs 0-30000");
  if (!isInt(c["weight"], 0, 100)) fail("INVALID_WEIGHT", "weight must be a whole number from 0 to 100");
  if (typeof c["canBlock"] !== "boolean" || typeof c["advisoryOnly"] !== "boolean") fail("INVALID_FLAGS", "canBlock and advisoryOnly must be booleans");
  if (c["canBlock"] === true && c["advisoryOnly"] === true) fail("ADVISORY_CANNOT_BLOCK", "an advisory-only agent can never block eligibility");
  const dependsOn = c["dependsOn"] ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== "string" || !AGENT_ID.test(d)) || new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(c["agentId"] as string)) fail("INVALID_DEPENDENCIES", "dependsOn must be a list of distinct other agent ids");
  return {
    agentId: c["agentId"] as string, agentName: (c["agentName"] as string).trim(), version: c["version"] as string, requiredInputs, optionalInputs, outputSchema: { fields },
    timeoutMs: c["timeoutMs"] as number, retry: { maxAttempts: retry!.maxAttempts as number, backoffMs: retry!.backoffMs as number }, weight: c["weight"] as number,
    canBlock: c["canBlock"] as boolean, advisoryOnly: c["advisoryOnly"] as boolean, dependsOn: [...(dependsOn as string[])].sort(),
  };
}

const MAX_OUTPUT_BYTES = 8192;
/**
 * Validates and SANITIZES what an agent returned: verdict / confidence / findings / evidence / output against the contract. Returns a new object (the agent's own is never kept).
 * Violations are fixed-code AgentContractErrors; the run is then recorded as FAILED.
 */
export function validateAgentOutput(contract: AgentContract, raw: unknown): AgentOutput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("OUTPUT_NOT_AN_OBJECT", "the agent must return an object");
  const o = raw as Record<string, unknown>;
  if (!(AGENT_VERDICTS as readonly unknown[]).includes(o["verdict"])) fail("OUTPUT_VERDICT_INVALID", "unknown verdict");
  const verdict = o["verdict"] as AgentVerdict;
  if (verdict === "BLOCKING" && !(contract.canBlock && !contract.advisoryOnly)) fail("OUTPUT_BLOCKING_NOT_PERMITTED", "this agent is not permitted to return BLOCKING");
  const conf = o["confidence"];
  if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 100) fail("OUTPUT_CONFIDENCE_INVALID", "confidence must be a number from 0 to 100");
  const findingsRaw = o["findings"] ?? [], evidenceRaw = o["evidence"] ?? [];
  if (!Array.isArray(findingsRaw) || findingsRaw.length > 20) return fail("OUTPUT_FINDINGS_INVALID", "findings must be a list of at most 20");
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length > 20) return fail("OUTPUT_EVIDENCE_INVALID", "evidence must be a list of at most 20");
  const findings: AgentFinding[] = findingsRaw.map((f: unknown) => {
    const x = f as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || typeof x["code"] !== "string" || !CODE.test(x["code"]) || !(FINDING_SEVERITIES as readonly unknown[]).includes(x["severity"]) || typeof x["summary"] !== "string") return fail("OUTPUT_FINDINGS_INVALID", "a finding needs a CODE, a severity and a summary");
    let detail: AgentFinding["detail"];
    if (x["detail"] !== undefined) {
      const d = x["detail"] as Record<string, unknown>;
      if (typeof d !== "object" || d === null || Array.isArray(d) || Object.keys(d).length > 12) return fail("OUTPUT_FINDINGS_INVALID", "finding detail must be a small flat object");
      detail = {};
      for (const [k, v] of Object.entries(d)) {
        if (!FIELD.test(k) || !(v === null || ["string", "number", "boolean"].includes(typeof v)) || (typeof v === "number" && !Number.isFinite(v))) return fail("OUTPUT_FINDINGS_INVALID", "finding detail values must be flat scalars");
        detail[k] = typeof v === "string" ? sanitizeText(v, 200) : (v as number | boolean | null);
      }
    }
    return { code: x["code"], severity: x["severity"] as FindingSeverity, summary: sanitizeText(x["summary"], 280), ...(detail ? { detail } : {}) };
  });
  const evidence: AgentEvidence[] = evidenceRaw.map((e: unknown) => {
    const x = e as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || typeof x["kind"] !== "string" || !KIND.test(x["kind"]) || typeof x["ref"] !== "string" || !REF.test(x["ref"]) || (x["sha256"] !== undefined && (typeof x["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(x["sha256"])))) return fail("OUTPUT_EVIDENCE_INVALID", "evidence needs a kind and a safe reference (no spaces) and an optional sha256");
    return { kind: x["kind"], ref: x["ref"], ...(x["sha256"] ? { sha256: x["sha256"] as string } : {}) };
  });
  const out = o["output"] ?? {};
  if (typeof out !== "object" || out === null || Array.isArray(out)) return fail("OUTPUT_SCHEMA_VIOLATION", "output must be an object");
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(out)) if (!contract.outputSchema.fields[key]) return fail("OUTPUT_SCHEMA_VIOLATION", `unexpected output field ${sanitizeText(key, 40)}`);
  for (const [key, spec] of Object.entries(contract.outputSchema.fields)) {
    const v = (out as Record<string, unknown>)[key];
    if (v === undefined) { if (spec.required) fail("OUTPUT_SCHEMA_VIOLATION", `missing required output field ${key}`); continue; }
    const ok = spec.type === "string" ? typeof v === "string" : spec.type === "number" ? typeof v === "number" && Number.isFinite(v) : spec.type === "boolean" ? typeof v === "boolean"
      : spec.type === "string[]" ? Array.isArray(v) && v.length <= 50 && v.every((s) => typeof s === "string") : Array.isArray(v) && v.length <= 50 && v.every((n) => typeof n === "number" && Number.isFinite(n));
    if (!ok) fail("OUTPUT_SCHEMA_VIOLATION", `output field ${key} is not a ${spec.type}`);
    snapshot[key] = spec.type === "string" ? sanitizeText(v, 500) : spec.type === "string[]" ? (v as string[]).map((s) => sanitizeText(s, 200)) : v;
  }
  if (stableStringify(snapshot).length > MAX_OUTPUT_BYTES) fail("OUTPUT_TOO_LARGE", "the output snapshot exceeds 8 KB");
  return { verdict, confidence: Math.round((conf as number) * 100) / 100, findings, evidence, output: snapshot };
}
