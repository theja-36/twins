/**
 * Regression tests for explicit market/macro input selection and the analysis as-of cutoff.
 * Synthetic data only, written to the approved integration target with unique symbols/series per test.
 */
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { createSignalFromTelegramMessage } from "../../../packages/signals/src/ingestSignal";
import { buildSignalIntelligence } from "../../../packages/signals/src/intelligence";
import { assembleSignalIntelligence } from "../../../packages/signals/src/engine";
import { validateSignal } from "../../../packages/decision-intelligence/src/engine";
import { buildBearThesis } from "../../../packages/decision-intelligence/src/thesis";

const db = createDb(requireTestDatabaseUrl());
afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function newSignal() {
  const symbol = `SEL-${randomLetters(8)}`;
  const [source] = await db.insert(schema.telegramSources).values({ channelIdentifier: `chan-${randomUUID()}` }).returning();
  if (!source) throw new Error("source");
  const [message] = await db
    .insert(schema.telegramMessages)
    .values({ telegramSourceId: source.id, externalMessageId: "1", messageTimestamp: new Date(), rawText: `BUY ${symbol} @ 100 SL 95 TGT 110` })
    .returning();
  if (!message) throw new Error("message");
  const { signalId } = await createSignalFromTelegramMessage(db, message.id, { exchange: "NSE", instrumentType: "equity" });
  if (!signalId) throw new Error("signal");
  const [signal] = await db.select().from(schema.signals).where(eq(schema.signals.id, signalId));
  if (!signal) throw new Error("signal row");
  return { signalId, instrumentId: signal.instrumentId };
}

type Bar = { source: string; timeframe?: string; observedAt: Date; receivedAt?: Date; close: number | null };
async function addBars(instrumentId: string, bars: Bar[]) {
  for (const b of bars) {
    await db.insert(schema.marketObservations).values({
      instrumentId,
      source: b.source,
      timeframe: b.timeframe ?? "1d",
      observedAt: b.observedAt,
      ...(b.receivedAt ? { receivedAt: b.receivedAt } : {}),
      ...(b.close === null ? {} : { close: String(b.close), open: String(b.close), high: String(b.close), low: String(b.close) }),
    });
  }
}

describe("market input selection", () => {
  it("a LATER synthetic row does not override the real analysis context", async () => {
    const { signalId, instrumentId } = await newSignal();
    await addBars(instrumentId, [
      { source: "yahoo-finance", observedAt: ago(5 * H), close: 1211 },
      { source: "r0b-synthetic", observedAt: ago(1 * H), close: 2810 }, // later and synthetic
    ]);
    const r = await buildSignalIntelligence(db, signalId, {});
    expect(r.marketContext?.observation.source).toBe("yahoo-finance");
    expect(Number(r.marketContext?.observation.close)).toBe(1211);
  });

  it("synthetic data is usable only when the synthetic context is requested explicitly", async () => {
    const { signalId, instrumentId } = await newSignal();
    await addBars(instrumentId, [{ source: "r0b-synthetic", observedAt: ago(1 * H), close: 2810 }]);
    const analysis = await buildSignalIntelligence(db, signalId, {});
    expect(analysis.marketContext).toBeNull();
    expect(analysis.marketInputReason).toMatch(/no eligible market observation/);
    const named = await buildSignalIntelligence(db, signalId, { market: { source: "r0b-synthetic" } });
    expect(named.marketContext).toBeNull(); // naming a synthetic source does not make it analysis input
    expect(named.marketInputReason).toMatch(/synthetic and cannot be used in the "analysis" context/);
    const synthetic = await buildSignalIntelligence(db, signalId, { market: { context: "synthetic" } });
    expect(synthetic.marketContext?.observation.source).toBe("r0b-synthetic");
  });

  it("rows missing the required close price are excluded (never coerced), older complete rows are used", async () => {
    const { signalId, instrumentId } = await newSignal();
    await addBars(instrumentId, [
      { source: "yahoo-finance", observedAt: ago(30 * H), close: 1200 },
      { source: "yahoo-finance", observedAt: ago(6 * H), close: null },
    ]);
    const r = await buildSignalIntelligence(db, signalId, {});
    expect(Number(r.marketContext?.observation.close)).toBe(1200);

    const only = await newSignal();
    await addBars(only.instrumentId, [{ source: "yahoo-finance", observedAt: ago(6 * H), close: null }]);
    const none = await buildSignalIntelligence(db, only.signalId, {});
    expect(none.marketContext).toBeNull();
    expect(none.dataCompletenessNotes.join(" ")).toMatch(/no eligible market input/);
  });

  it("several eligible sources are reported, not guessed; an explicit source selects; an absent explicit source does NOT fall back", async () => {
    const { signalId, instrumentId } = await newSignal();
    await addBars(instrumentId, [
      { source: "src-a", observedAt: ago(3 * H), close: 100 },
      { source: "src-b", observedAt: ago(2 * H), close: 101 },
    ]);
    const ambiguous = await buildSignalIntelligence(db, signalId, {});
    expect(ambiguous.marketContext).toBeNull();
    expect(ambiguous.marketInputReason).toMatch(/src-a, src-b/);
    const chosen = await buildSignalIntelligence(db, signalId, { market: { source: "src-a" } });
    expect(chosen.marketContext?.observation.source).toBe("src-a");
    const missing = await buildSignalIntelligence(db, signalId, { market: { source: "src-missing" } });
    expect(missing.marketContext).toBeNull();
    expect(missing.marketInputReason).toMatch(/source=src-missing/);
  });

  it("the interval is explicit: another interval is never substituted", async () => {
    const { signalId, instrumentId } = await newSignal();
    await addBars(instrumentId, [
      { source: "yahoo-finance", timeframe: "1m", observedAt: ago(1 * H), close: 999 },
      { source: "yahoo-finance", timeframe: "1d", observedAt: ago(20 * H), close: 1000 },
    ]);
    expect(Number((await buildSignalIntelligence(db, signalId, {})).marketContext?.observation.close)).toBe(1000);
    expect(Number((await buildSignalIntelligence(db, signalId, { market: { timeframe: "1m" } })).marketContext?.observation.close)).toBe(999);
    expect((await buildSignalIntelligence(db, signalId, { market: { timeframe: "1h" } })).marketContext).toBeNull();
  });

  it("no eligible input produces the bear.no_market_data factor WITH the reason, and no thesis support", async () => {
    const { signalId, instrumentId } = await newSignal();
    await addBars(instrumentId, [{ source: "r0b-synthetic", observedAt: ago(1 * H), close: 2810 }]);
    const report = await assembleSignalIntelligence(db, signalId);
    const factor = buildBearThesis(report).factors.find((f) => f.ruleId === "bear.no_market_data");
    expect(factor?.description).toMatch(/no eligible market input.*no eligible market observation/);
  });
});

describe("macro relevance", () => {
  const addMacro = async (seriesCode: string, region: string, receivedAt?: Date) => {
    await db.insert(schema.macroObservations).values({
      source: "RBI", region, seriesCode, observedAt: ago(2 * H), ...(receivedAt ? { receivedAt } : {}), value: "6.5",
    });
  };

  it("without a relevance rule NO macro row is used, linked, or counted as corroboration", async () => {
    const { signalId } = await newSignal();
    await addMacro(`UNRELATED-${randomUUID().slice(0, 6)}`, "IN"); // newest macro rows exist
    const r = await buildSignalIntelligence(db, signalId, {});
    expect(r.macroContext).toEqual([]);
    expect(r.dataCompletenessNotes.join(" ")).toMatch(/macro observations not used: no relevance rule/);
    const links = await db.select().from(schema.signalEvidence).where(eq(schema.signalEvidence.signalId, signalId));
    expect(links.filter((l) => l.macroObservationId)).toHaveLength(0);

    const report = await assembleSignalIntelligence(db, signalId);
    expect(buildBearThesis(report).factors.map((f) => f.ruleId)).toContain("bear.no_corroborating_context");
  });

  it("an explicit series/region rule selects only matching rows", async () => {
    const { signalId } = await newSignal();
    const series = `REL-${randomUUID().slice(0, 6)}`;
    await addMacro(series, "IN");
    await addMacro(series + "X", "IN");
    const hit = await buildSignalIntelligence(db, signalId, { macro: { seriesCodes: [series] } });
    expect(hit.macroContext.map((m) => m.seriesCode)).toEqual([series]);
    const wrongRegion = await buildSignalIntelligence(db, signalId, { macro: { seriesCodes: [series], regions: ["US"] } });
    expect(wrongRegion.macroContext).toEqual([]);
  });
});

describe("explicit analysis as-of time (historical replay)", () => {
  it("market and macro rows RECEIVED after the cutoff are excluded; without a cutoff they are visible", async () => {
    const { signalId, instrumentId } = await newSignal();
    const series = `ASOF-${randomUUID().slice(0, 6)}`;
    const cutoff = ago(30 * 60_000);
    await addBars(instrumentId, [
      { source: "yahoo-finance", observedAt: ago(3 * H), receivedAt: ago(2 * H), close: 100 }, // known at the cutoff
      { source: "yahoo-finance", observedAt: ago(1 * H), receivedAt: ago(10 * 60_000), close: 111 }, // observed earlier but received AFTER the cutoff
    ]);
    await db.insert(schema.macroObservations).values({ source: "RBI", region: "IN", seriesCode: series, observedAt: ago(2 * H), receivedAt: ago(5 * 60_000), value: "6.5" });

    const replay = await buildSignalIntelligence(db, signalId, { asOf: cutoff, market: { source: "yahoo-finance" }, macro: { seriesCodes: [series] } });
    expect(Number(replay.marketContext?.observation.close)).toBe(100);
    expect(replay.macroContext).toEqual([]);

    const live = await buildSignalIntelligence(db, signalId, { market: { source: "yahoo-finance" }, macro: { seriesCodes: [series] } });
    expect(Number(live.marketContext?.observation.close)).toBe(111);
    expect(live.macroContext).toHaveLength(1);
  });
});

describe("consumer-specific price requirements and the single effective as-of time", () => {
  it("a close-only bar is not offered to a consumer that requires a full bar, and priceFields says what is present", async () => {
    const { signalId, instrumentId } = await newSignal();
    await db.insert(schema.marketObservations).values({ instrumentId, source: "yahoo-finance", timeframe: "1d", observedAt: ago(2 * H), close: "100" }); // close only
    const closeOnly = await buildSignalIntelligence(db, signalId, {});
    expect(closeOnly.marketContext?.priceFields).toEqual({ open: false, high: false, low: false, close: true });
    const needsBar = await buildSignalIntelligence(db, signalId, { market: { requiredPrices: ["open", "high", "low", "close"] } });
    expect(needsBar.marketContext).toBeNull();
    expect(needsBar.marketInputReason).toMatch(/open\+high\+low\+close/);
  });

  it("validateSignal uses one as-of for selection and decision, reports it, and replays without later-received rows", async () => {
    const { signalId, instrumentId } = await newSignal();
    const cutoff = ago(30 * 60_000);
    await addBars(instrumentId, [
      { source: "yahoo-finance", observedAt: ago(3 * H), receivedAt: ago(2 * H), close: 100 },
      { source: "yahoo-finance", observedAt: ago(1 * H), receivedAt: ago(10 * 60_000), close: 111 },
    ]);
    const out = await validateSignal(db, signalId, { asOf: cutoff, intelligence: { market: { source: "yahoo-finance" } } });
    expect(out.asOf?.getTime()).toBe(cutoff.getTime());
    expect(out.result?.validatedAt.getTime()).toBe(cutoff.getTime());
    const [link] = await db.select().from(schema.signalEvidence).where(eq(schema.signalEvidence.signalId, signalId));
    const [obs] = await db.select().from(schema.marketObservations).where(eq(schema.marketObservations.id, link?.marketObservationId ?? ""));
    expect(Number(obs?.close)).toBe(100); // the 111 bar was received after the cutoff
    await expect(validateSignal(db, signalId, { asOf: cutoff, decide: { now: new Date() } })).rejects.toThrow(/must be the same instant/);
  });
});
