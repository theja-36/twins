import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { researchPackages } from "../schema/intelligence";

export type StoredAssessment = "RESEARCH_SUPPORTIVE" | "RESEARCH_NEUTRAL" | "RESEARCH_CAUTION" | "RESEARCH_ADVERSE" | "RESEARCH_INCOMPLETE" | "RESEARCH_BLOCKED";
/** A research package as stored: the whole package JSON (per-agent spec verdicts, evidence references, versions, hashes) plus its headline assessment. */
export interface ResearchPackageInput { candidateId: string; agentResults: unknown; assessment: StoredAssessment; haltReason: string | null }

/** Appends the NEXT version of a candidate's research package (`research_packages` is append-only; a re-evaluation is a new version, never an edit). Serialised per candidate with an advisory lock so two workers cannot take the same version. */
export async function storeResearchPackage(db: Pick<Db, "transaction">, source: ResearchPackageInput | ((version: number) => ResearchPackageInput), candidateIdHint?: string): Promise<{ id: string; version: number }> {
  return db.transaction(async (tx) => {
    const lockId = typeof source === "function" ? candidateIdHint : source.candidateId;
    if (!lockId) throw new Error("a candidate id is needed to serialise versions");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"research_packages:" + lockId}, 0))`);
    const [last] = await tx.select({ version: researchPackages.version }).from(researchPackages).where(eq(researchPackages.candidateId, lockId)).orderBy(desc(researchPackages.version)).limit(1);
    const version = (last?.version ?? 0) + 1;
    const input = typeof source === "function" ? source(version) : source;
    if (input.candidateId !== lockId) throw new Error("the package belongs to a different candidate");
    const [row] = await tx.insert(researchPackages).values({ candidateId: input.candidateId, version, agentResults: input.agentResults, assessment: input.assessment, haltReason: input.haltReason }).returning({ id: researchPackages.id });
    return { id: (row as { id: string }).id, version };
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

