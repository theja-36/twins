import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { canonicalSources } from "../scorecards/run";
import { buildAttribution, type AttributionOptions, type AttributionReport, type AttributionRow } from "./attribution";

/**
 * READ-ONLY loader for the attribution report: one SELECT over the imported source records, their newest normalization and the newest evaluation label. It inserts and updates nothing and
 * reads no message text (timestamps, market, side, outcome and data quality only).
 */
export async function loadAttributionRows(db: Db): Promise<AttributionRow[]> {
  const S = schema.historicalSourceRecords, N = schema.historicalNormalizedRecords, L = schema.historicalOutcomeLabels, ER = schema.historicalEvaluationRuns;
  const canonicalOf = new Map<string, string>();
  for (const c of await canonicalSources(db)) for (const m of c.members) canonicalOf.set(m, c.channelLabel);

  const normalized = await db.select({ id: S.id, channel: S.channelLabel, mid: S.originalMessageId, rev: S.revisionNo, at: S.messageTimestamp, nId: N.id, market: N.market, side: N.side, parseStatus: N.parseStatus, createdN: N.createdAt })
    .from(S).leftJoin(N, eq(N.sourceRecordId, S.id)).orderBy(asc(S.id), asc(N.createdAt));
  const latestN = new Map<string, (typeof normalized)[number]>();
  for (const r of normalized) latestN.set(r.id, r);

  const labels = await db.select({ nId: L.normalizedRecordId, outcome: L.finalOutcome, quality: L.dataQuality }).from(L).innerJoin(ER, eq(ER.id, L.runId)).orderBy(asc(ER.createdAt), asc(L.id));
  const latestLabel = new Map<string, (typeof labels)[number]>();
  for (const l of labels) latestLabel.set(l.nId, l);

  const rows: AttributionRow[] = [];
  for (const r of latestN.values()) {
    if (r.rev !== 0 || !r.nId || (r.parseStatus !== "SIGNAL" && r.parseStatus !== "OPTIONS_CLAIM")) continue;
    const l = latestLabel.get(r.nId);
    rows.push({ key: `${r.channel}|${r.mid}`, source: canonicalOf.get(r.channel) ?? r.channel, market: r.market ?? null, side: r.side ?? null, at: r.at, outcome: l?.outcome ?? null, dataQuality: l?.quality ?? null });
  }
  return rows;
}

export async function attributionReport(db: Db, opts?: AttributionOptions): Promise<AttributionReport> {
  return buildAttribution(await loadAttributionRows(db), opts);
}
