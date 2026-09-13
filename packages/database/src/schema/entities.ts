import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";
import { entityTypeEnum, matchMethodEnum, relationshipStrengthEnum, relationshipTypeEnum } from "./enums";

/**
 * A canonical real-world entity (spec: company/sector/market/country/
 * macro - deliberately not "instrument", which already has its own table
 * from Phase 2; instruments relate to entities via entity_relationships
 * rather than being duplicated here).
 */
export const entities = pgTable(
  "entities",
  {
    id: idColumn(),
    entityType: entityTypeEnum("entity_type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    description: text("description"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    typeNameUnique: uniqueIndex("entities_type_canonical_name_unique").on(
      table.entityType,
      table.canonicalName,
    ),
  }),
);

/**
 * Alternate names for an entity (spec: "Reliance" / "RIL" / "Reliance
 * Industries" as aliases of one canonical entity). `normalizedAlias` is
 * the lowercased/trimmed form actually used for lookups; the same
 * normalized alias MAY legitimately belong to more than one entity
 * (that is exactly the ambiguous case resolution must refuse to guess),
 * so uniqueness is scoped to (entity, alias), never to the alias alone.
 */
export const entityAliases = pgTable(
  "entity_aliases",
  {
    id: idColumn(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    aliasType: text("alias_type").notNull(), // exact_name | ticker | abbreviation | variant
    createdAt: createdAtColumn(),
  },
  (table) => ({
    entityAliasUnique: uniqueIndex("entity_aliases_entity_alias_unique").on(
      table.entityId,
      table.normalizedAlias,
    ),
    normalizedAliasIdx: index("entity_aliases_normalized_alias_idx").on(
      table.normalizedAlias,
    ),
  }),
);

/**
 * A single, controlled-vocabulary relationship edge (spec section:
 * "Avoid an unrestricted graph database ... PostgreSQL relational
 * representation is sufficient"). The subject is polymorphic
 * (instrument | entity | news_events | news_evidence - same pattern as
 * audit_events/signal_evidence's generic references elsewhere in this
 * schema); the object is always a canonical entity, so `objectId` carries
 * a real FK for integrity.
 *
 * `matchMethod` + `matchedText` are the provenance trail (spec: "why did
 * TWINS associate this article with this entity?"); `strength`
 * distinguishes an explicit/direct link from a fixed structural mapping,
 * so a later phase can never mistake domain configuration for verified
 * fact - and nothing in Phase 7 emits `potential`, which is reserved for
 * a future analytical-validation step.
 */
export const entityRelationships = pgTable(
  "entity_relationships",
  {
    id: idColumn(),
    subjectType: text("subject_type").notNull(), // instrument | entity | news_events | news_evidence
    subjectId: uuid("subject_id").notNull(),
    relationshipType: relationshipTypeEnum("relationship_type").notNull(),
    objectId: uuid("object_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    strength: relationshipStrengthEnum("strength").notNull(),
    matchMethod: matchMethodEnum("match_method").notNull(),
    matchedText: text("matched_text"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    dedupeUnique: uniqueIndex("entity_relationships_dedupe_unique").on(
      table.subjectType,
      table.subjectId,
      table.relationshipType,
      table.objectId,
    ),
    subjectIdx: index("entity_relationships_subject_idx").on(
      table.subjectType,
      table.subjectId,
    ),
    objectIdx: index("entity_relationships_object_idx").on(table.objectId),
  }),
);
