import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../../packages/database/src/index";
import { addAlias, createEntity, createEntityWithCanonicalAlias } from "../../../packages/entities/src/entities";
import { resolveMention } from "../../../packages/entities/src/resolve";
import {
  findCountry,
  findInstrumentByExchangeSymbol,
  findIssuingCompany,
  findSector,
  findTradedMarket,
  linkCompanyToSector,
  linkEntityToCountry,
  linkInstrumentToCompany,
  linkInstrumentToMarket,
} from "../../../packages/entities/src/instrumentMapping";
import { resolveInstrument } from "../../../packages/ingestion/src/instruments";

const DATABASE_URL =
  requireTestDatabaseUrl();
const db = createDb(DATABASE_URL);

beforeAll(async () => {
  await db.execute("select 1");
});
afterAll(async () => {
  const pool = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
  await pool.end();
});

describe("entity resolution (integration)", () => {
  it("resolves an exact canonical name", async () => {
    const name = `Test Company ${randomUUID()}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const result = await resolveMention(db, name);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.candidate.matchMethod).toBe("exact_canonical");
      expect(result.candidate.canonicalName).toBe(name);
    }
  });

  it("resolves a valid alias to its canonical entity", async () => {
    const name = `Alias Target ${randomUUID()}`;
    const entityId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const alias = `ALIASWORD-${randomUUID().slice(0, 8)}`;
    await addAlias(db, { entityId, alias, aliasType: "ticker" });

    const result = await resolveMention(db, alias.toLowerCase());
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.candidate.entityId).toBe(entityId);
      expect(result.candidate.matchMethod).toBe("exact_alias");
    }
  });

  it("normalizes case when matching", async () => {
    const name = `CaseTest ${randomUUID()}`;
    await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: name });
    const result = await resolveMention(db, name.toUpperCase());
    expect(result.status).toBe("resolved");
  });

  it("leaves an ambiguous alias UNRESOLVED rather than guessing", async () => {
    const sharedAlias = `SHARED-${randomUUID().slice(0, 8)}`;
    const entityAId = await createEntity(db, { entityType: "company", canonicalName: `Company A ${randomUUID()}` });
    const entityBId = await createEntity(db, { entityType: "company", canonicalName: `Company B ${randomUUID()}` });
    await addAlias(db, { entityId: entityAId, alias: sharedAlias, aliasType: "variant" });
    await addAlias(db, { entityId: entityBId, alias: sharedAlias, aliasType: "variant" });

    const result = await resolveMention(db, sharedAlias);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((c) => c.entityId).sort()).toEqual([entityAId, entityBId].sort());
    }
  });

  it("returns unresolved for a completely unknown term (false-positive prevention)", async () => {
    const result = await resolveMention(db, `NoSuchEntity-${randomUUID()}`);
    expect(result.status).toBe("unresolved");
  });

  it("never conflates two distinct entities that happen to share no configured alias", async () => {
    const appleCompany = await createEntityWithCanonicalAlias(db, {
      entityType: "company",
      canonicalName: `Apple Inc ${randomUUID()}`,
    });
    // "apple" the word is NOT registered as an alias for anything else here,
    // so resolving a genuinely unrelated term must not accidentally match it.
    const unrelated = await resolveMention(db, `SomeUnrelatedFruitCompany-${randomUUID()}`);
    expect(unrelated.status).toBe("unresolved");
    expect(appleCompany).toBeTruthy();
  });
});

describe("instrument -> entity mapping (integration)", () => {
  it("maps an NSE instrument to company, sector, market, and country", async () => {
    const symbol = `MAP-${randomUUID().slice(0, 8)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");

    const companyId = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: `Co ${symbol}` });
    const sectorId = await createEntityWithCanonicalAlias(db, { entityType: "sector", canonicalName: `Energy-${randomUUID()}` });
    const marketId = await createEntityWithCanonicalAlias(db, { entityType: "market", canonicalName: `NSE-${randomUUID()}` });
    const countryId = await createEntityWithCanonicalAlias(db, { entityType: "country", canonicalName: `India-${randomUUID()}` });

    await linkInstrumentToCompany(db, instrumentId, companyId);
    await linkInstrumentToMarket(db, instrumentId, marketId);
    await linkCompanyToSector(db, companyId, sectorId);
    await linkEntityToCountry(db, companyId, countryId);

    const company = await findIssuingCompany(db, instrumentId);
    const market = await findTradedMarket(db, instrumentId);
    const sector = company ? await findSector(db, company.entityId) : null;
    const country = company ? await findCountry(db, company.entityId) : null;

    expect(company?.entityId).toBe(companyId);
    expect(market?.entityId).toBe(marketId);
    expect(sector?.entityId).toBe(sectorId);
    expect(country?.entityId).toBe(countryId);
  });

  it("does not conflate the same ticker on two different exchanges", async () => {
    const symbol = `DUAL-${randomUUID().slice(0, 6)}`;
    const nseId = await resolveInstrument(db, { symbol, exchange: "NSE" }, "equity");
    const nasdaqId = await resolveInstrument(db, { symbol, exchange: "NASDAQ" }, "equity");
    expect(nseId).not.toBe(nasdaqId);

    const companyOnNse = await createEntityWithCanonicalAlias(db, { entityType: "company", canonicalName: `NSE Co ${symbol}` });
    await linkInstrumentToCompany(db, nseId, companyOnNse);

    expect(await findIssuingCompany(db, nseId)).not.toBeNull();
    expect(await findIssuingCompany(db, nasdaqId)).toBeNull(); // unmapped, not guessed
  });

  it("returns null rather than guessing for an instrument with no configured mapping", async () => {
    const symbol = `UNMAPPED-${randomUUID().slice(0, 6)}`;
    const instrumentId = await resolveInstrument(db, { symbol, exchange: "LSE" }, "equity");
    expect(await findIssuingCompany(db, instrumentId)).toBeNull();
  });

  it("looks up an instrument by exchange-qualified symbol without creating one that doesn't exist", async () => {
    const missing = await findInstrumentByExchangeSymbol(db, "BSE", `NEVER-${randomUUID()}`);
    expect(missing).toBeNull();
  });
});
