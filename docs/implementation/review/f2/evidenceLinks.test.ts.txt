/**
 * F2 - signal_evidence link identity. NOT in the suite yet: stored as docs/implementation/review/f2/evidenceLinks.test.ts.txt and copied (as .ts) only
 * into the PATCHED COPY used by the approved scratch rehearsal. Needs migration 0005 + the intelligence.ts patch.
 *
 * What it claims (and nothing more): the writer links each (signal, evidence row) at most once, also under concurrency
 * and across a failed-then-retried run, while legitimately distinct evidence stays distinct. It makes NO claim about
 * scores, theses or confidence: signal_evidence is not read by production analysis (code inspection), so a duplicate
 * link has no current analytical effect, and no test pretends otherwise.
 *
 * Deterministic concurrency: callers are held by a barrier per link just before their INSERT into signal_evidence,
 * so every caller's existence-check SELECT for link k completes before any caller's INSERT for link k.
 * Without migration 0005 this test FAILS with the marker SIGNAL_EVIDENCE_DUPLICATES (the rehearsal's negative control).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName } from "drizzle-orm";
import { createBoundedDb, schema, type BoundedDbHandle, type Db } from "../../../packages/database/src/index";
import { buildSignalIntelligence } from "../../../packages/signals/src/index";
import { DATABASE_URL, must } from "./harness";

let handle: BoundedDbHandle;
beforeAll(async () => {
  handle = createBoundedDb({ url: DATABASE_URL, max: 20, idleTimeoutMillis: 10000 });
  await handle.db.execute("SELECT 1");
});
afterAll(async () => { await handle?.close(); });

const rand = () => Math.floor(Math.random() * 1_000_000_000);
const pgCode = (e: unknown): string | undefined => (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

// ---- fixtures: a private instrument with 2 market observations, 2 macro series, 1 news item, and signals on demand
async function makeFixture() {
  const db = handle.db;
  const tag = `${Date.now().toString(36)}${rand()}`;
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
  const [inst] = await db.insert(schema.instruments).values({ symbol: `F2${tag}`.slice(0, 20), exchange: "NSE", instrumentType: "equity" }).returning();
  const instrumentId = must(inst).id;
  const obs = { instrumentId, source: "f2-test", timeframe: "1d", open: "10", high: "11", low: "9", close: "10", dataQualityStatus: "ok" as const, receivedAt: at(0.5) };
  const [m1] = await db.insert(schema.marketObservations).values({ ...obs, observedAt: at(3) }).returning();
  const [m2] = await db.insert(schema.marketObservations).values({ ...obs, observedAt: at(2) }).returning(); // the latest: what the writer links
  const seriesCodes = [`F2A${tag}`, `F2B${tag}`];
  const macros = [];
  for (const seriesCode of seriesCodes) {
    const [row] = await db.insert(schema.macroObservations).values({ source: "f2-test", region: "IN", seriesCode, observedAt: at(1.5), value: "1", dataQualityStatus: "ok" }).returning();
    macros.push(must(row));
  }
  const [src] = await db.insert(schema.newsSources).values({ name: `f2-${tag}`, tier: "C" }).returning();
  const [news] = await db.insert(schema.newsEvidence).values({ newsSourceId: must(src).id, sourceUrl: `https://f2.invalid/${tag}`, headline: "f2 fixture", sourceTimestamp: at(1), dedupeHash: `f2-${tag}` }).returning();
  const newSignal = async () => {
    const [s] = await db.insert(schema.signals).values({ sourceType: "manual", instrumentId, parserVersion: "f2-test", direction: "buy", status: "pending", signalTimestamp: new Date(now) }).returning();
    return must(s).id;
  };
  return { m1: must(m1), m2: must(m2), macros, news: must(news), seriesCodes, newSignal };
}

const linksOf = (signalId: string) => handle.db.select().from(schema.signalEvidence).where(eq(schema.signalEvidence.signalId, signalId));
const refOf = (l: typeof schema.signalEvidence.$inferSelect) => `${l.evidenceKind}:${l.marketObservationId ?? l.macroObservationId ?? l.newsEvidenceId}`;
function duplicateGroups(links: Array<typeof schema.signalEvidence.$inferSelect>) {
  const counts = new Map<string, number>();
  for (const l of links) counts.set(refOf(l), (counts.get(refOf(l)) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([ref, n]) => `${ref} x${n}`);
}

// ---- deterministic gating helpers (same technique as concurrency.test.ts)
function barrier(parties: number) {
  let arrived = 0; let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return { arrive: async () => { arrived += 1; if (arrived >= parties) release(); await open; } };
}
function wrapBuilder<T extends object>(builder: T, wait: () => Promise<void>): T {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "then") {
        const then = Reflect.get(target, "then", receiver) as (a: unknown, b: unknown) => unknown;
        return (res: unknown, rej: unknown) => wait().then(() => then.call(target, res, rej));
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => { const r = (v as (...a: unknown[]) => unknown).apply(target, args); return r && typeof r === "object" ? wrapBuilder(r as object, wait) : r; };
    },
  });
}
/** Wraps a db for ONE caller: its k-th INSERT into signal_evidence waits on gates[k]; optionally throws on the n-th insert. */
function callerDb(db: Db, opts: { gates?: Array<{ arrive: () => Promise<void> }>; failOnInsert?: number }): Db {
  let k = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "insert" && typeof v === "function") {
        return (t: Parameters<Db["insert"]>[0]) => {
          const isLink = getTableName(t) === "signal_evidence";
          const index = isLink ? k++ : -1;
          if (isLink && opts.failOnInsert === index) throw new Error("injected failure before link insert (f2 test seam)");
          const builder = (v as (x: unknown) => object).call(target, t);
          const gate = isLink ? opts.gates?.[index] : undefined;
          return gate ? wrapBuilder(builder, gate.arrive) : builder;
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Db;
}
const writerOptions = (f: Awaited<ReturnType<typeof makeFixture>>) => ({ enforceNoLookahead: true, macro: { seriesCodes: f.seriesCodes } });

describe("signal_evidence link identity (migration 0005 + conflict-safe writer)", () => {
  it("database level: a second link for the same (signal, evidence row) is rejected (23505) and ON CONFLICT DO NOTHING inserts nothing - for market, macro and news", async () => {
    const f = await makeFixture();
    const signalId = await f.newSignal();
    const cases = [
      { evidenceKind: "market_observation" as const, ref: { marketObservationId: f.m2.id } },
      { evidenceKind: "macro_observation" as const, ref: { macroObservationId: must(f.macros[0]).id } },
      { evidenceKind: "news_evidence" as const, ref: { newsEvidenceId: f.news.id } },
    ];
    for (const c of cases) {
      await handle.db.insert(schema.signalEvidence).values({ signalId, evidenceKind: c.evidenceKind, ...c.ref });
      const err = await handle.db.insert(schema.signalEvidence).values({ signalId, evidenceKind: c.evidenceKind, ...c.ref }).then(() => undefined, (e: unknown) => e);
      expect(pgCode(err), `${c.evidenceKind}: duplicate must be a unique violation`).toBe("23505");
      const none = await handle.db.insert(schema.signalEvidence).values({ signalId, evidenceKind: c.evidenceKind, ...c.ref }).onConflictDoNothing().returning({ id: schema.signalEvidence.id });
      expect(none).toHaveLength(0);
    }
    expect(await linksOf(signalId)).toHaveLength(3); // exactly one per kind
  });

  it("legitimately distinct evidence stays distinct: other observation, other signal, other kind are all accepted", async () => {
    const f = await makeFixture();
    const s1 = await f.newSignal(); const s2 = await f.newSignal();
    const link = (signalId: string, evidenceKind: "market_observation" | "macro_observation" | "news_evidence", ref: Record<string, string>) =>
      handle.db.insert(schema.signalEvidence).values({ signalId, evidenceKind, ...ref });
    await link(s1, "market_observation", { marketObservationId: f.m1.id }); // an older observation
    await link(s1, "market_observation", { marketObservationId: f.m2.id }); // a newer one: a different evidence row, not a duplicate
    await link(s1, "macro_observation", { macroObservationId: must(f.macros[0]).id });
    await link(s1, "macro_observation", { macroObservationId: must(f.macros[1]).id });
    await link(s1, "news_evidence", { newsEvidenceId: f.news.id });
    await link(s2, "market_observation", { marketObservationId: f.m1.id }); // same evidence row, different signal
    expect((await linksOf(s1)).map(refOf).sort()).toEqual([`market_observation:${f.m1.id}`, `market_observation:${f.m2.id}`, `macro_observation:${must(f.macros[0]).id}`, `macro_observation:${must(f.macros[1]).id}`, `news_evidence:${f.news.id}`].sort());
    expect(await linksOf(s2)).toHaveLength(1);
  });

  it("concurrent writers (N=4, held at a barrier per link) produce exactly one link per gathered evidence row", async () => {
    const f = await makeFixture();
    const signalId = await f.newSignal();
    const N = 4;
    const gates = [barrier(N), barrier(N), barrier(N)]; // market + two macro links
    const results = await Promise.allSettled(Array.from({ length: N }, () => buildSignalIntelligence(callerDb(handle.db, { gates }), signalId, writerOptions(f))));
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)), "writers must not fail").toEqual([]);
    const links = await linksOf(signalId);
    expect(duplicateGroups(links), "SIGNAL_EVIDENCE_DUPLICATES").toEqual([]);
    expect(links.map(refOf).sort()).toEqual([`market_observation:${f.m2.id}`, `macro_observation:${must(f.macros[0]).id}`, `macro_observation:${must(f.macros[1]).id}`].sort());
  });

  it("partial failure then retry converges: the first link survives unchanged, the missing links are added, nothing is duplicated", async () => {
    const f = await makeFixture();
    const signalId = await f.newSignal();
    await expect(buildSignalIntelligence(callerDb(handle.db, { failOnInsert: 1 }), signalId, writerOptions(f))).rejects.toThrow(/injected failure/);
    const afterFailure = await linksOf(signalId);
    expect(afterFailure).toHaveLength(1); // only the market link was written before the failure
    await buildSignalIntelligence(handle.db, signalId, writerOptions(f)); // the retry
    await buildSignalIntelligence(handle.db, signalId, writerOptions(f)); // and a repeat
    const final = await linksOf(signalId);
    expect(duplicateGroups(final), "SIGNAL_EVIDENCE_DUPLICATES").toEqual([]);
    expect(final).toHaveLength(3);
    expect(final.find((l) => l.marketObservationId === f.m2.id)?.id).toBe(must(afterFailure[0]).id); // the pre-existing link was reused, not re-created
  });
});
