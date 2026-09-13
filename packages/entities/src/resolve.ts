import { eq, inArray } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import { normalizeAlias } from "./entities";
import type { EntityCandidate, EntityResolution } from "./types";

/**
 * Resolves one piece of already-extracted text (a candidate name/ticker
 * token) against the entity registry. Returns exactly one of
 * resolved/ambiguous/unresolved - there is no fourth "best guess" outcome
 * (spec: "Ambiguous matches should be UNRESOLVED rather than guessed").
 */
export async function resolveMention(db: Db, text: string): Promise<EntityResolution> {
  const normalizedAlias = normalizeAlias(text);
  if (normalizedAlias.length === 0) return { status: "unresolved", matchedText: text };

  const rows = await db
    .select({
      entityId: schema.entityAliases.entityId,
      alias: schema.entityAliases.alias,
      aliasType: schema.entityAliases.aliasType,
      entityType: schema.entities.entityType,
      canonicalName: schema.entities.canonicalName,
    })
    .from(schema.entityAliases)
    .innerJoin(schema.entities, eq(schema.entityAliases.entityId, schema.entities.id))
    .where(eq(schema.entityAliases.normalizedAlias, normalizedAlias));

  if (rows.length === 0) return { status: "unresolved", matchedText: text };

  const distinctEntityIds = new Set(rows.map((r) => r.entityId));

  if (distinctEntityIds.size > 1) {
    const candidates: EntityCandidate[] = rows.map((r) => ({
      entityId: r.entityId,
      entityType: r.entityType,
      canonicalName: r.canonicalName,
      matchedText: text,
      matchMethod: r.aliasType === "exact_name" && r.alias === r.canonicalName ? "exact_canonical" : "exact_alias",
    }));
    return { status: "ambiguous", matchedText: text, candidates };
  }

  const row = rows[0]!;
  return {
    status: "resolved",
    candidate: {
      entityId: row.entityId,
      entityType: row.entityType,
      canonicalName: row.canonicalName,
      matchedText: text,
      matchMethod: row.aliasType === "exact_name" && row.alias === row.canonicalName ? "exact_canonical" : "exact_alias",
    },
  };
}

/** Batch variant for the bounded candidate-token sets news/tokenizing produces (spec: avoid N+1 lookups). */
export async function resolveMentionsBatch(
  db: Db,
  texts: string[],
): Promise<Map<string, EntityResolution>> {
  const normalizedToOriginal = new Map<string, string>();
  for (const text of texts) {
    const normalized = normalizeAlias(text);
    if (normalized.length > 0 && !normalizedToOriginal.has(normalized)) {
      normalizedToOriginal.set(normalized, text);
    }
  }
  const normalizedList = Array.from(normalizedToOriginal.keys());
  if (normalizedList.length === 0) return new Map();

  const rows = await db
    .select({
      normalizedAlias: schema.entityAliases.normalizedAlias,
      entityId: schema.entityAliases.entityId,
      alias: schema.entityAliases.alias,
      aliasType: schema.entityAliases.aliasType,
      entityType: schema.entities.entityType,
      canonicalName: schema.entities.canonicalName,
    })
    .from(schema.entityAliases)
    .innerJoin(schema.entities, eq(schema.entityAliases.entityId, schema.entities.id))
    .where(inArray(schema.entityAliases.normalizedAlias, normalizedList));

  const byNormalized = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byNormalized.get(row.normalizedAlias) ?? [];
    list.push(row);
    byNormalized.set(row.normalizedAlias, list);
  }

  const result = new Map<string, EntityResolution>();
  for (const [normalized, originalText] of normalizedToOriginal) {
    const matches = byNormalized.get(normalized) ?? [];
    if (matches.length === 0) {
      result.set(originalText, { status: "unresolved", matchedText: originalText });
      continue;
    }
    const distinctEntityIds = new Set(matches.map((m) => m.entityId));
    const toCandidate = (m: (typeof matches)[number]): EntityCandidate => ({
      entityId: m.entityId,
      entityType: m.entityType,
      canonicalName: m.canonicalName,
      matchedText: originalText,
      matchMethod: m.aliasType === "exact_name" && m.alias === m.canonicalName ? "exact_canonical" : "exact_alias",
    });
    if (distinctEntityIds.size > 1) {
      result.set(originalText, {
        status: "ambiguous",
        matchedText: originalText,
        candidates: matches.map(toCandidate),
      });
    } else {
      result.set(originalText, { status: "resolved", candidate: toCandidate(matches[0]!) });
    }
  }
  return result;
}
