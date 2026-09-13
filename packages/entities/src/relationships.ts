import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import type { MatchMethod, RelationshipStrength, RelationshipSubjectType, RelationshipType } from "./types";

/**
 * Creates a relationship edge if it doesn't already exist (idempotent via
 * the (subjectType, subjectId, relationshipType, objectId) unique
 * constraint - reprocessing the same article/instrument/event never
 * duplicates edges).
 */
export async function linkEntities(
  db: Db,
  params: {
    subjectType: RelationshipSubjectType;
    subjectId: string;
    relationshipType: RelationshipType;
    objectId: string;
    strength: RelationshipStrength;
    matchMethod: MatchMethod;
    matchedText?: string;
  },
): Promise<void> {
  await db
    .insert(schema.entityRelationships)
    .values({
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      relationshipType: params.relationshipType,
      objectId: params.objectId,
      strength: params.strength,
      matchMethod: params.matchMethod,
      matchedText: params.matchedText,
    })
    .onConflictDoNothing({
      target: [
        schema.entityRelationships.subjectType,
        schema.entityRelationships.subjectId,
        schema.entityRelationships.relationshipType,
        schema.entityRelationships.objectId,
      ],
    });
}

export interface RelatedEntity {
  entityId: string;
  entityType: string;
  canonicalName: string;
  strength: string;
  matchMethod: string;
}

export async function getRelatedEntities(
  db: Db,
  subjectType: RelationshipSubjectType,
  subjectId: string,
  relationshipType: RelationshipType,
): Promise<RelatedEntity[]> {
  const rows = await db
    .select({
      entityId: schema.entities.id,
      entityType: schema.entities.entityType,
      canonicalName: schema.entities.canonicalName,
      strength: schema.entityRelationships.strength,
      matchMethod: schema.entityRelationships.matchMethod,
    })
    .from(schema.entityRelationships)
    .innerJoin(schema.entities, eq(schema.entityRelationships.objectId, schema.entities.id))
    .where(
      and(
        eq(schema.entityRelationships.subjectType, subjectType),
        eq(schema.entityRelationships.subjectId, subjectId),
        eq(schema.entityRelationships.relationshipType, relationshipType),
      ),
    );
  return rows;
}
