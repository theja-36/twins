import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { researchAgentRuns, researchPackages } from "../schema/intelligence";

export type StoredAssessment = "RESEARCH_SUPPORTIVE" | "RESEARCH_NEUTRAL" | "RESEARCH_CAUTION" | "RESEARCH_ADVERSE" | "RESEARCH_INCOMPLETE" | "RESEARCH_BLOCKED";
/** A research package as stored: the whole package JSON (per-agent spec verdicts, evidence references, versions, hashes) plus its headline assessment. */
/** One agent run of the research that produced a package (G-44). Provider data is never part of it; see the table comment. */
export interface ResearchAgentRunInput {
  agentId: string; agentVersion: string; status: string; verdict: string; confidence: number | null; attempts: number; inputSnapshotRef: string; inputSnapshot: unknown; outputSnapshot: unknown;
  findings: readonly unknown[]; evidence: readonly unknown[]; meta: unknown; startedAt: Date; completedAt: Date; durationMs: number; errorCode: string | null; errorMessage: string | null;
}
/**
 * `runKey` (G-43) identifies the research RUN: a second attempt with the same key finds the stored package instead of appending a duplicate version. `agentRuns` (G-44) are written in the SAME transaction as the package:
 * both are stored or neither is.
 */
export interface ResearchPackageInput { candidateId: string; agentResults: unknown; assessment: StoredAssessment; haltReason: string | null; runKey?: string | null; agentRuns?: readonly ResearchAgentRunInput[] }
export interface StoredResearchRun { id: string; version: number; /** true when the package already existed for this run key and nothing was written */ deduplicated?: boolean; /** the package JSON that is stored (set on a duplicate) */ stored?: unknown }

/** Appends the NEXT version of a candidate's research package (`research_packages` is append-only; a re-evaluation is a new version, never an edit). Serialised per candidate with an advisory lock so two workers cannot take the same version. */
export async function storeResearchPackage(db: Pick<Db, "transaction">, source: ResearchPackageInput | ((version: number) => ResearchPackageInput), candidateIdHint?: string): Promise<StoredResearchRun> {
  return db.transaction(async (tx) => {
    const lockId = typeof source === "function" ? candidateIdHint : source.candidateId;
    if (!lockId) throw new Error("a candidate id is needed to serialise versions");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"research_packages:" + lockId}, 0))`);
    const [last] = await tx.select({ version: researchPackages.version }).from(researchPackages).where(eq(researchPackages.candidateId, lockId)).orderBy(desc(researchPackages.version)).limit(1);
    const version = (last?.version ?? 0) + 1;
    const input = typeof source === "function" ? source(version) : source;
    if (input.candidateId !== lockId) throw new Error("the package belongs to a different candidate");
    if (input.runKey) { // an earlier attempt of the SAME research run already stored its package (crash before the queue item completed): return it, write nothing
      const [dup] = await tx.select({ id: researchPackages.id, version: researchPackages.version, agentResults: researchPackages.agentResults }).from(researchPackages).where(and(eq(researchPackages.candidateId, lockId), eq(researchPackages.runKey, input.runKey))).limit(1);
      if (dup) return { id: dup.id, version: dup.version, deduplicated: true, stored: dup.agentResults };
    }
    const [row] = await tx.insert(researchPackages).values({ candidateId: input.candidateId, version, agentResults: input.agentResults, assessment: input.assessment, haltReason: input.haltReason, runKey: input.runKey ?? null }).returning({ id: researchPackages.id });
    const id = (row as { id: string }).id;
    if (input.agentRuns && input.agentRuns.length > 0) {
      await tx.insert(researchAgentRuns).values(input.agentRuns.map((r) => ({
        researchPackageId: id, agentId: r.agentId, agentVersion: r.agentVersion, status: r.status, verdict: r.verdict, confidence: r.confidence === null ? null : String(r.confidence), attempts: r.attempts, inputSnapshotRef: r.inputSnapshotRef,
        inputSnapshot: r.inputSnapshot, outputSnapshot: r.outputSnapshot, findings: [...r.findings], evidence: [...r.evidence], meta: r.meta, startedAt: r.startedAt, completedAt: r.completedAt, durationMs: r.durationMs, errorCode: r.errorCode, errorMessage: r.errorMessage,
      })));
    }
    return { id, version };
  });
}
export async function getLatestResearchPackage(db: Pick<Db, "select">, candidateId: string): Promise<{ id: string; version: number; assessment: string; haltReason: string | null; agentResults: unknown; createdAt: Date } | null> {
  const [r] = await db.select().from(researchPackages).where(and(eq(researchPackages.candidateId, candidateId))).orderBy(desc(researchPackages.version)).limit(1);
  return r ? { id: r.id, version: r.version, assessment: r.assessment, haltReason: r.haltReason, agentResults: r.agentResults, createdAt: r.createdAt } : null;
}
/** One research package by its id (the exact version a risk assessment or a decision recorded). Null when it does not exist. */
export async function getResearchPackageById(db: Pick<Db, "select">, id: string): Promise<{ id: string; version: number; assessment: string; haltReason: string | null; agentResults: unknown; createdAt: Date } | null> {
  const [r] = await db.select().from(researchPackages).where(eq(researchPackages.id, id)).limit(1);
  return r ? { id: r.id, version: r.version, assessment: r.assessment, haltReason: r.haltReason, agentResults: r.agentResults, createdAt: r.createdAt } : null;
}
/** The stored agent runs of one package, by agent id: what each agent saw and produced, for reconstruction and audit. */
export async function listResearchAgentRuns(db: Pick<Db, "select">, researchPackageId: string): Promise<Array<ResearchAgentRunInput & { id: string; createdAt: Date }>> {
  const rows = await db.select().from(researchAgentRuns).where(eq(researchAgentRuns.researchPackageId, researchPackageId)).orderBy(asc(researchAgentRuns.agentId));
  return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, agentId: r.agentId, agentVersion: r.agentVersion, status: r.status, verdict: r.verdict, confidence: r.confidence === null ? null : Number(r.confidence), attempts: r.attempts, inputSnapshotRef: r.inputSnapshotRef, inputSnapshot: r.inputSnapshot, outputSnapshot: r.outputSnapshot, findings: r.findings as unknown[], evidence: r.evidence as unknown[], meta: r.meta, startedAt: r.startedAt, completedAt: r.completedAt, durationMs: r.durationMs, errorCode: r.errorCode, errorMessage: r.errorMessage }));
}

