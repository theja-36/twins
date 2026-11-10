import type { FastifyInstance } from "fastify";
import { PlatformError } from "@twins/types";
import type { AuthService } from "@twins/auth";
import { EXTRA_SPECIALISTS, SPEC_ROLE_MAP, createProductionRegistry, DEFAULT_AGENT_RULES, DEFAULT_REQUIRED_AGENTS, deriveResearchStatus, roleOfAgent, supplementsOf, type ResearchStatus } from "@twins/agents";
import { getCandidate, getLatestResearchPackage, getResearchPackageById, type Db } from "@twins/database";
import { query, uuid } from "./userApi.js";
import { iso, sharedGet } from "./telegramIntelApi.js";

/**
 * Research read API (Stage 04). Session-protected like the Telegram intelligence routes and READ-ONLY: research packages and the agent registry are SHARED platform intelligence (no owner), so the shared
 * permission `research:read` applies. A package is evidence: it carries `grantsApproval: false`, never message text, and never a decision. The status is DERIVED from the stored candidate state and package
 * (nothing new is persisted). No route writes, runs research, or reaches a provider.
 */
export interface StoredResearchPackage { id: string; version: number; assessment: string; haltReason: string | null; agentResults: unknown; createdAt: Date }
export interface ResearchOps {
  latest(candidateId: string): Promise<StoredResearchPackage | null>;
  byId(id: string): Promise<StoredResearchPackage | null>;
  candidate(id: string): Promise<{ state: string; attempts: number } | null>;
}
export function buildResearchOps(db: Db): ResearchOps {
  return { latest: (id) => getLatestResearchPackage(db, id), byId: (id) => getResearchPackageById(db, id), candidate: async (id) => { const c = await getCandidate(db, id); return c ? { state: c.state, attempts: c.attempts } : null; } };
}
const view = (p: StoredResearchPackage, candidateId: string, status: ResearchStatus | null, attempts: number | null) => ({
  packageId: p.id, candidateId, version: p.version, assessment: p.assessment, haltReason: p.haltReason, status, researchAttempts: attempts, createdAt: iso(p.createdAt), package: p.agentResults,
});

export function registerResearchRoutes(app: FastifyInstance, deps: { auth: AuthService; ops: ResearchOps; researchMaxAttempts?: number | null }): void {
  const { ops } = deps, get = sharedGet(app, deps.auth), maxAttempts = deps.researchMaxAttempts ?? null;
  const statusOf = async (candidateId: string, p: StoredResearchPackage | null): Promise<{ status: ResearchStatus | null; attempts: number | null }> => {
    const c = await ops.candidate(candidateId);
    return { status: c ? deriveResearchStatus({ candidateState: c.state, hasPackage: p !== null, assessment: (p?.assessment ?? null) as never, attempts: c.attempts, maxAttempts }) : null, attempts: c?.attempts ?? null };
  };

  get<{ id: string }>("/research/candidates/:id/package", "research:read", async (req) => {
    query(req as never, []); const id = uuid(req.params.id, "id"), p = await ops.latest(id), s = await statusOf(id, p);
    if (!p) { if (s.status === null) throw new PlatformError("NOT_FOUND", "not found"); return { candidateId: id, status: s.status, researchAttempts: s.attempts, package: null, note: "No research package has been stored for this candidate; nothing is inferred." }; }
    return view(p, id, s.status, s.attempts);
  });
  get<{ id: string }>("/research/packages/:id", "research:read", async (req) => {
    query(req as never, []); const p = await ops.byId(uuid(req.params.id, "id"));
    if (!p) throw new PlatformError("NOT_FOUND", "not found");
    const cid = (p.agentResults as { candidateId?: unknown } | null)?.candidateId, candidateId = typeof cid === "string" ? cid : "";
    const s = candidateId ? await statusOf(candidateId, p) : { status: null, attempts: null };
    return view(p, candidateId, s.status, s.attempts);
  });
  get("/research/agents", "research:read", async (req) => {
    query(req as never, []);
    const contracts = createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).snapshot();
    return {
      agents: contracts.map((c) => ({ agentId: c.agentId, name: c.agentName, version: c.version, role: roleOfAgent(c.agentId), supplementsRoles: supplementsOf(c.agentId), required: DEFAULT_REQUIRED_AGENTS.includes(c.agentId), canBlock: c.canBlock, advisoryOnly: c.advisoryOnly, weight: c.weight, timeoutMs: c.timeoutMs, dependsOn: c.dependsOn, softDependsOn: c.softDependsOn ?? [], requiredInputs: c.requiredInputs, optionalInputs: c.optionalInputs })),
      roles: Object.values(SPEC_ROLE_MAP).map((b) => ({ role: b.role, name: b.specName, kind: b.kind, components: b.components })),
      extraSpecialists: [...EXTRA_SPECIALISTS],
      note: "Contract metadata only. Every agent is a deterministic rule engine over injected data; none uses a model. Research is evidence, never an approval.",
    };
  });
}
