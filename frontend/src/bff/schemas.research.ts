/**
 * Stage 09.3B.3: STRICT relay schemas for the three research routes. The package body is the shape proven against the real orchestrator output (schemas.verified093b.ts, tests/unit/api-contracts/researchParity.test.ts).
 * Rules: undeclared fields are stripped; the whole response is refused (neutral 502, no data) when a declared field breaks the contract; `optionsRisk` is deliberately NOT declared, so it never reaches the browser (its structure is unverified);
 * nothing here computes, defaults or grants anything (`grantsApproval` must be the literal false).
 */
import { z } from "zod";
import { ResearchPackageBody } from "./schemas.verified093b";

const txt = (n = 400) => z.string().max(n), id = z.string().max(64), ts = z.string().max(40);
/** The package as the browser may see it. `optionsRisk` is omitted on purpose (unverified structure). */
export const ResearchBody = ResearchPackageBody.omit({ optionsRisk: true });
/** GET /research/candidates/:id/package when a package exists, and GET /research/packages/:id (its `candidateId` is empty when the stored package does not say). */
export const ResearchPackagePresent = z.object({ packageId: id, candidateId: txt(64), version: z.number(), assessment: txt(60), haltReason: txt(120).nullable(), status: txt(40).nullable(), researchAttempts: z.number().nullable(), createdAt: ts, package: ResearchBody });
/** The same route when no package exists yet: nothing is inferred. */
export const ResearchPackageAbsent = z.object({ candidateId: id, status: txt(40).nullable(), researchAttempts: z.number().nullable(), package: z.null(), note: txt(400) });
export const ResearchPackageRelay = z.union([ResearchPackagePresent, ResearchPackageAbsent]);

const AgentRow = z.object({
  agentId: txt(80), name: txt(120), version: txt(40), role: txt(60).nullable(), supplementsRoles: z.array(txt(60)).max(20), required: z.boolean(), canBlock: z.boolean(), advisoryOnly: z.boolean(), weight: z.number(), timeoutMs: z.number(),
  dependsOn: z.array(txt(80)).max(30), softDependsOn: z.array(txt(80)).max(30), requiredInputs: z.array(txt(80)).max(30), optionalInputs: z.array(txt(80)).max(30),
});
export const AgentRegistryRelay = z.object({
  agents: z.array(AgentRow).max(100), roles: z.array(z.object({ role: txt(60), name: txt(120), kind: txt(40), components: z.array(txt(80)).max(30) })).max(50), extraSpecialists: z.array(txt(80)).max(20), note: txt(500),
});
export const RESEARCH_RELAY_SCHEMAS = { "research.package": ResearchPackageRelay, "research.packageById": ResearchPackageRelay, "research.agents": AgentRegistryRelay } as const;
