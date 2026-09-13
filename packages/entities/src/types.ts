/**
 * Phase 7 - Entity & Event Intelligence. Every type here mirrors the
 * controlled vocabularies in packages/database/src/schema/{enums,entities}.ts.
 * Nothing in this package makes a trading decision, calls an AI/LLM, or
 * executes anything - it only identifies entities/events and the
 * relationships between them, with provenance attached to every edge.
 */

export type EntityType = "company" | "sector" | "market" | "country" | "macro";

export type RelationshipType =
  | "ISSUED_BY"
  | "BELONGS_TO"
  | "TRADED_ON"
  | "LOCATED_IN"
  | "AFFECTS"
  | "MENTIONS";

/**
 * `direct`: the evidence itself states the link (e.g. an explicit text
 * mention). `structural`: a fixed domain mapping TWINS was configured
 * with. `potential`: reserved for a future analytical-validation phase -
 * nothing here emits it, so a "potential" relationship never appears
 * unless a later phase deliberately adds that capability.
 */
export type RelationshipStrength = "direct" | "structural" | "potential";

export type MatchMethod =
  | "exact_canonical"
  | "exact_alias"
  | "ticker_exchange"
  | "structured_provider_id"
  | "deterministic_rule";

export type RelationshipSubjectType = "instrument" | "entity" | "news_events" | "news_evidence";

/** A single resolved candidate for a free-text mention. */
export interface EntityCandidate {
  entityId: string;
  entityType: EntityType;
  canonicalName: string;
  matchedText: string;
  matchMethod: MatchMethod;
}

/**
 * The outcome of resolving one piece of text against the entity
 * registry. Ambiguous/unknown mentions are represented explicitly rather
 * than guessed (spec: "Ambiguous matches should be UNRESOLVED rather
 * than guessed").
 */
export type EntityResolution =
  | { status: "resolved"; candidate: EntityCandidate }
  | { status: "ambiguous"; matchedText: string; candidates: EntityCandidate[] }
  | { status: "unresolved"; matchedText: string };
