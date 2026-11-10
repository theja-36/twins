import { refuseUnlessSafe } from "@twins/risk";
import type { AgentEngineConfig } from "../config";
import { orchestrate, type OrchestrationDeps } from "../orchestrator";
import type { AgentRegistry } from "../registry";
import { candidateToAgentInputs, type ResearchCandidate } from "./candidateInput";
import { mapOptionsRisk, type ContractFacts } from "./optionsRiskMapping";
import { researchRunKey, toAgentRunRecords } from "./runRecords";
import { buildResearchPackage, toResearchPackageRow, type ResearchPackage } from "./package";

/** Where a finished package is saved. The agents package writes nothing itself: the caller passes a sink (the database store in production, a list in tests). */
export interface ResearchPackageSink { save(candidateId: string, build: (version: number) => ReturnType<typeof toResearchPackageRow>): Promise<{ id: string; version: number; deduplicated?: boolean; stored?: unknown }> }
export type CandidateResearchResult =
  | { skipped: "ENGINE_DISABLED" | "CANDIDATE_EXPIRED" }
  | { skipped?: undefined; packageId: string; version: number; research: ResearchPackage; /** true when this run had already stored its package (a crash between saving and completing): nothing new was written */ deduplicated?: boolean };

/**
 * Researches ONE candidate from EITHER pipeline with the common research infrastructure: candidate -> agent inputs -> specialist agents -> synthesis -> research package -> saved.
 * Nothing here reads message text, sizes a position, checks a limit or creates a decision: the package is evidence for the decision engine, which keeps its own deterministic gates.
 * Fails closed: a disabled engine does nothing, and the runtime safety check (kill switch / live guard) is applied before any agent runs.
 */
export async function runCandidateResearch(candidate: ResearchCandidate & { expiresAt?: Date }, o: {
  /** The contract record in force for an option candidate, when a contract master exists (none is configured yet: the mapping then says CONTRACT_MASTER_UNAVAILABLE). */
  contract?: ContractFacts | null;
  registry: AgentRegistry; config: AgentEngineConfig; sink: ResearchPackageSink; deps?: OrchestrationDeps; sourceIntelligence?: Record<string, unknown> | null; refuse?: (action: string) => Promise<void>;
}): Promise<CandidateResearchResult> {
  if (!o.config.enabled) return { skipped: "ENGINE_DISABLED" };
  const now = (o.deps?.now ?? (() => new Date()))();
  if (candidate.expiresAt && candidate.expiresAt.getTime() <= now.getTime()) return { skipped: "CANDIDATE_EXPIRED" };
  await (o.refuse ?? refuseUnlessSafe)("agent_engine.run");
  const plan = o.registry.resolve(o.config); // a mis-wired graph throws: a broken engine must not run
  const inputs = candidateToAgentInputs(candidate, { sourceIntelligence: o.sourceIntelligence ?? null });
  const outcome = await orchestrate(plan, o.config, inputs, { riskDecisionId: candidate.id, decisionVersion: 1 }, o.deps);
  // The run's identity and its per-agent records travel WITH the package: the sink stores them in one transaction, and a second attempt of the same run finds the package that is already stored (G-43, G-44).
  const runKey = researchRunKey(candidate.id, outcome.results, o.config), agentRuns = toAgentRunRecords(outcome);
  // the sink assigns the next version and asks for the package built WITH it, so the stored JSON, its hash and the row version always agree
  let research: ResearchPackage | null = null;
  const saved = await o.sink.save(candidate.id, (version) => { research = buildResearchPackage(candidate, version, outcome, { optionsRiskMapping: mapOptionsRisk({ candidate, now, contract: o.contract ?? null }) }); return toResearchPackageRow(research, { runKey, agentRuns }); });
  if (research === null) throw new Error("the sink did not build the package");
  if (saved.deduplicated) return { packageId: saved.id, version: saved.version, research: (saved.stored ?? research) as ResearchPackage, deduplicated: true };
  return { packageId: saved.id, version: saved.version, research: research as ResearchPackage };
}
