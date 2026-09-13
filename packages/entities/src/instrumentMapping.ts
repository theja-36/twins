import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";
import { linkEntities, getRelatedEntities, type RelatedEntity } from "./relationships";

/**
 * Read-only instrument lookup by (exchange, symbol) - the "exchange-
 * qualified symbol" tier from the spec's resolution priority list.
 * Deliberately does NOT create the instrument if missing (unlike
 * ingestion's resolveInstrument) - mapping is a read/query concern, not
 * an ingestion one, and the same ticker can exist on multiple exchanges
 * (spec: "Do not assume a symbol globally identifies an instrument").
 */
export async function findInstrumentByExchangeSymbol(
  db: Db,
  exchange: string,
  symbol: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: schema.instruments.id })
    .from(schema.instruments)
    .where(and(eq(schema.instruments.exchange, exchange), eq(schema.instruments.symbol, symbol)));
  return row ?? null;
}

/**
 * Configures the deterministic domain mapping instrument -> issuing
 * company (spec: "INSTRUMENT -> ISSUED_BY -> COMPANY"). This is
 * structural configuration, not evidence extracted from a single
 * document, hence strength="structural"/matchMethod="deterministic_rule".
 */
export async function linkInstrumentToCompany(
  db: Db,
  instrumentId: string,
  companyEntityId: string,
): Promise<void> {
  await linkEntities(db, {
    subjectType: "instrument",
    subjectId: instrumentId,
    relationshipType: "ISSUED_BY",
    objectId: companyEntityId,
    strength: "structural",
    matchMethod: "deterministic_rule",
  });
}

export async function linkInstrumentToMarket(
  db: Db,
  instrumentId: string,
  marketEntityId: string,
): Promise<void> {
  await linkEntities(db, {
    subjectType: "instrument",
    subjectId: instrumentId,
    relationshipType: "TRADED_ON",
    objectId: marketEntityId,
    strength: "structural",
    matchMethod: "deterministic_rule",
  });
}

export async function linkCompanyToSector(db: Db, companyEntityId: string, sectorEntityId: string): Promise<void> {
  await linkEntities(db, {
    subjectType: "entity",
    subjectId: companyEntityId,
    relationshipType: "BELONGS_TO",
    objectId: sectorEntityId,
    strength: "structural",
    matchMethod: "deterministic_rule",
  });
}

export async function linkEntityToCountry(db: Db, entityId: string, countryEntityId: string): Promise<void> {
  await linkEntities(db, {
    subjectType: "entity",
    subjectId: entityId,
    relationshipType: "LOCATED_IN",
    objectId: countryEntityId,
    strength: "structural",
    matchMethod: "deterministic_rule",
  });
}

/** The company an instrument is issued by, if that mapping has been configured. */
export async function findIssuingCompany(db: Db, instrumentId: string): Promise<RelatedEntity | null> {
  const [row] = await getRelatedEntities(db, "instrument", instrumentId, "ISSUED_BY");
  return row ?? null;
}

export async function findTradedMarket(db: Db, instrumentId: string): Promise<RelatedEntity | null> {
  const [row] = await getRelatedEntities(db, "instrument", instrumentId, "TRADED_ON");
  return row ?? null;
}

export async function findSector(db: Db, companyEntityId: string): Promise<RelatedEntity | null> {
  const [row] = await getRelatedEntities(db, "entity", companyEntityId, "BELONGS_TO");
  return row ?? null;
}

export async function findCountry(db: Db, entityId: string): Promise<RelatedEntity | null> {
  const [row] = await getRelatedEntities(db, "entity", entityId, "LOCATED_IN");
  return row ?? null;
}
