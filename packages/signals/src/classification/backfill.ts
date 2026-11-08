import { and, desc, eq, isNull } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "../db";
import type { OptionsClaim } from "../options/types";
import { classifySignal } from "./classify";
import { CLASSIFIER_VERSION, type ClassificationResult } from "./types";

export interface PendingClaim { claimId: string; claim: OptionsClaim; text: string | null; at: Date }

const looksLikeClaim = (v: unknown): v is OptionsClaim => {
  const o = v as Partial<OptionsClaim> | null;
  return typeof o === "object" && o !== null && typeof o.entry === "object" && o.entry !== null && Array.isArray(o.targets) && typeof o.levelBasis === "string" && typeof o.underlying === "string";
};

/** Stored claims that have no classification from the CURRENT classifier version yet (newest first). Read-only. */
export async function loadPendingClaims(db: Db, limit: number): Promise<PendingClaim[]> {
  const C = schema.optionsClaims, M = schema.telegramMessages, S = schema.signalClassifications;
  const rows = await db.select({ id: C.id, claim: C.claim, text: M.rawText, at: M.messageTimestamp }).from(C)
    .innerJoin(M, eq(M.id, C.telegramMessageId))
    .leftJoin(S, and(eq(S.claimId, C.id), eq(S.classifierVersion, CLASSIFIER_VERSION)))
    .where(and(eq(C.resultKind, "claim"), isNull(S.id))).orderBy(desc(M.messageTimestamp)).limit(limit);
  const out: PendingClaim[] = [];
  for (const r of rows) if (looksLikeClaim(r.claim)) out.push({ claimId: String(r.id), claim: r.claim, text: r.text ?? null, at: r.at });
  return out;
}

export interface BatchResult { considered: number; stored: number; alreadyDone: number }
/** Classifies and stores each pending claim; a storage "false" means it was already recorded (idempotent). Pure apart from `store`. */
export async function classifyBatch(rows: readonly PendingClaim[], store: (claimId: string, r: ClassificationResult) => Promise<boolean>): Promise<BatchResult> {
  let stored = 0, alreadyDone = 0;
  for (const r of rows) {
    const result = classifySignal({ claim: r.claim, messageText: r.text, messageTimestamp: r.at });
    if (await store(r.claimId, result)) stored++; else alreadyDone++;
  }
  return { considered: rows.length, stored, alreadyDone };
}
