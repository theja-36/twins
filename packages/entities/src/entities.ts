import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import type { EntityType } from "./types";

export function normalizeAlias(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Creates a canonical entity if it doesn't already exist (idempotent via
 * the (entityType, canonicalName) unique constraint). This is reference
 * data - not a fabricated observation - the same category as Phase 4's
 * instrument-row upsert.
 */
export async function createEntity(
  db: Db,
  params: { entityType: EntityType; canonicalName: string; description?: string },
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(
      and(
        eq(schema.entities.entityType, params.entityType),
        eq(schema.entities.canonicalName, params.canonicalName),
      ),
    );
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(schema.entities)
    .values({
      entityType: params.entityType,
      canonicalName: params.canonicalName,
      description: params.description,
    })
    .onConflictDoNothing({
      target: [schema.entities.entityType, schema.entities.canonicalName],
    })
    .returning({ id: schema.entities.id });
  if (inserted) return inserted.id;

  const [afterRace] = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(
      and(
        eq(schema.entities.entityType, params.entityType),
        eq(schema.entities.canonicalName, params.canonicalName),
      ),
    );
  if (!afterRace) throw new Error(`failed to resolve entity ${params.entityType}:${params.canonicalName}`);
  return afterRace.id;
}

/**
 * Creates a canonical entity (if needed) and registers its own canonical
 * name as an alias, so mention resolution has a single table
 * (entity_aliases) to query rather than two separate lookup paths.
 */
export async function createEntityWithCanonicalAlias(
  db: Db,
  params: { entityType: EntityType; canonicalName: string; description?: string },
): Promise<string> {
  const entityId = await createEntity(db, params);
  await addAlias(db, { entityId, alias: params.canonicalName, aliasType: "exact_name" });
  return entityId;
}

/**
 * Registers an alias for an entity. Deliberately does NOT enforce
 * global uniqueness on the alias text - the same alias legitimately
 * belonging to two different entities is exactly the ambiguous case
 * resolution must detect and refuse to guess (spec: "Avoid false
 * positives").
 */
export async function addAlias(
  db: Db,
  params: { entityId: string; alias: string; aliasType: "exact_name" | "ticker" | "abbreviation" | "variant" },
): Promise<void> {
  const normalizedAlias = normalizeAlias(params.alias);
  await db
    .insert(schema.entityAliases)
    .values({
      entityId: params.entityId,
      alias: params.alias,
      normalizedAlias,
      aliasType: params.aliasType,
    })
    .onConflictDoNothing({
      target: [schema.entityAliases.entityId, schema.entityAliases.normalizedAlias],
    });
}
