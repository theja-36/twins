import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { schema } from "@twins/database";
import { assessMarketObservation, type QualityAssessmentResult } from "@twins/dataquality";
import type { Db } from "../db";

export type PriceField = "open" | "high" | "low" | "close";

export interface MarketContext {
  observation: typeof schema.marketObservations.$inferSelect;
  quality: QualityAssessmentResult;
  /**
   * Which price fields this observation actually carries. A close-only observation is NOT a complete OHLC(V) bar
   * and must not be offered to consumers (e.g. indicators) that need more; they request it via `requiredPrices`.
   * Eligible input does not imply fresh, complete or entitled data - this system verifies none of those.
   */
  priceFields: Record<PriceField, boolean>;
}

/**
 * Sources that carry synthetic/test data, by naming convention (the schema has no explicit flag):
 * `r0b-synthetic...` or `synthetic`, optionally followed by `-`, `_` or `:` and a suffix.
 * Synthetic rows are only eligible in the explicit "synthetic" context, never in "analysis".
 */
export const SYNTHETIC_SOURCE_PATTERN = "^(r0b-synthetic|synthetic([-_:].*)?$)";
export function isSyntheticSource(source: string): boolean {
  return new RegExp(SYNTHETIC_SOURCE_PATTERN).test(source);
}

export interface MarketContextOptions {
  /** Observation-time bound (no look-ahead): only observations at or before this timestamp. Omit for unbounded. */
  asOf?: Date | undefined;
  /** Information cutoff: only rows RECEIVED at or before this instant (historical replay must not see later arrivals). */
  receivedBy?: Date | undefined;
  /** Bar interval. Explicit; defaults to "1d", the only interval the pipeline ingests for analysis. */
  timeframe?: string | undefined;
  /** Explicit source to use. Omitted: allowed only while exactly one eligible source exists; several sources is reported, never guessed. */
  source?: string | undefined;
  /** "analysis" (default) never uses synthetic sources; "synthetic" uses only synthetic sources (explicit test context). */
  context?: "analysis" | "synthetic" | undefined;
  /**
   * Price fields the CONSUMER needs; rows lacking any of them are excluded. Defaults to ["close"], enough for the
   * current evidence checks only. A consumer that needs a full bar must ask for all four.
   */
  requiredPrices?: PriceField[] | undefined;
}

export type MarketSelection =
  | { context: MarketContext; reason?: undefined }
  | { context: null; reason: string };

/**
 * Selects the market input for an analysis, deterministically and explainably.
 * Eligible rows: the chosen instrument and interval, a present `close` price (the minimum price a bar must carry;
 * rows with a NULL close are excluded, never coerced), observed/received within the bounds, and a source allowed by
 * the context. Among eligible rows of ONE source the latest `observed_at` wins. There is no fallback to another
 * source or to synthetic data: when nothing is eligible the result is `context: null` with a reason.
 * Nothing here knows whether a daily bar is complete - the adapter does not report that - so no completeness
 * claim is made or implied.
 */
export async function selectMarketContext(
  db: Db,
  instrumentId: string,
  options: MarketContextOptions = {},
): Promise<MarketSelection> {
  const mode = options.context ?? "analysis";
  const timeframe = options.timeframe ?? "1d";
  const t = schema.marketObservations;

  if (options.source !== undefined && isSyntheticSource(options.source) !== (mode === "synthetic")) {
    return {
      context: null,
      reason: `source "${options.source}" is ${isSyntheticSource(options.source) ? "synthetic" : "not synthetic"} and cannot be used in the "${mode}" context`,
    };
  }

  const required = options.requiredPrices?.length ? options.requiredPrices : (['close'] as PriceField[]);
  const conditions = [eq(t.instrumentId, instrumentId), eq(t.timeframe, timeframe), ...required.map((f) => isNotNull(t[f]))];
  if (options.asOf) conditions.push(lte(t.observedAt, options.asOf));
  if (options.receivedBy) conditions.push(lte(t.receivedAt, options.receivedBy));
  conditions.push(mode === "synthetic" ? sql`${t.source} ~ ${SYNTHETIC_SOURCE_PATTERN}` : sql`${t.source} !~ ${SYNTHETIC_SOURCE_PATTERN}`);
  if (options.source !== undefined) conditions.push(eq(t.source, options.source));

  let chosenSource = options.source;
  if (chosenSource === undefined) {
    const sources = await db.selectDistinct({ source: t.source }).from(t).where(and(...conditions));
    if (sources.length > 1) {
      return {
        context: null,
        reason: `several eligible market sources (${sources.map((s) => s.source).sort().join(", ")}); select one explicitly - none was guessed`,
      };
    }
    chosenSource = sources[0]?.source;
  }

  const [latest] = await db.select().from(t).where(and(...conditions)).orderBy(desc(t.observedAt)).limit(1);
  if (!latest) {
    return {
      context: null,
      reason: `no eligible market observation (context=${mode}, interval=${timeframe}, source=${chosenSource ?? "any"}; requires ${required.join("+")} within the as-of and received-by bounds)`,
    };
  }
  const quality = await assessMarketObservation(db, latest.id);
  const priceFields = {
    open: latest.open !== null,
    high: latest.high !== null,
    low: latest.low !== null,
    close: latest.close !== null,
  };
  return { context: { observation: latest, quality, priceFields } };
}

/** Compatibility wrapper: the selected context, or null. Use selectMarketContext to also obtain the reason. */
export async function gatherMarketContext(
  db: Db,
  instrumentId: string,
  options: MarketContextOptions = {},
): Promise<MarketContext | null> {
  return (await selectMarketContext(db, instrumentId, options)).context;
}
