/**
 * Options-claim persistence, retry/idempotency, version handling, API read and non-approval.
 * Runs on the guarded integration target (synthetic data only).
 */
import { randomLetters } from "../../support/randomLetters";
import { requireTestDatabaseUrl } from "../targetConfig";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "../../../packages/database/src/index";
import { buildApp } from "../../support/apiWithTestPolicy";
import { createStructuredLogger, type LogRecord } from "../../../packages/shared/src/index";
import { createManualReferenceContractMaster, parseManualReferenceFile, TELEGRAM_PARSER_VERSION } from "../../../packages/signals/src/index";
import { processTelegramJob } from "../../support/workerWithTestPolicy";
import { marketDataProviders, YAHOO_PROVIDER_NAME, YahooFinanceAdapter, type MarketDataProvider } from "../../../adapters/market/src/index";
import { createViewerServer } from "../../../apps/web/src/server";
import { networkGuardStats } from "../../support/networkGuard";

// The worker's equity path refreshes market data through the registered provider. Replace the real Yahoo adapter with an
// offline stub so this test can never make an external request.
const offlineMarket: MarketDataProvider = {
  providerName: YAHOO_PROVIDER_NAME,
  async getHistoricalBars() {
    return [];
  },
  async getLatestQuote() {
    return null;
  },
  async getHealth() {
    return { providerName: YAHOO_PROVIDER_NAME, providerType: "market", status: "healthy", checkedAt: new Date() };
  },
};
marketDataProviders.register(YAHOO_PROVIDER_NAME, offlineMarket);

const db = createDb(requireTestDatabaseUrl());
afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

const API_KEY = "options-claims-test-key";
const WEBHOOK_SECRET = "options-claims-test-secret";
const fixtureMaster = () => createManualReferenceContractMaster(parseManualReferenceFile(JSON.parse(readFileSync("tests/fixtures/options/manual-reference.TEST-FIXTURE.json", "utf8"))));
const NIFTY = "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 PREMIUM";

function job(channel: string, externalId: string, rawText: string) {
  return {
    id: `oc-${randomUUID()}`,
    data: {
      jobType: "telegram_messages",
      providerName: "telegram-bot-webhook",
      telegram: {
        params: { channelIdentifier: channel },
        normalizedMessage: { channelIdentifier: channel, externalMessageId: externalId, messageTimestamp: new Date().toISOString(), rawText, rawPayload: {} },
        exchange: "NSE",
        instrumentType: "equity",
      },
    },
  } as never;
}
async function run(rawText: string, opts: { channel?: string; id?: string; master?: ReturnType<typeof fixtureMaster> } = {}) {
  const channel = opts.channel ?? `chan-${randomUUID()}`;
  const id = opts.id ?? String(Math.floor(Math.random() * 1e9));
  const records: LogRecord[] = [];
  const outcome = await processTelegramJob(job(channel, id, rawText), "oc-test", db, {
    logger: createStructuredLogger((r) => records.push(r)),
    ...(opts.master ? { optionsMaster: opts.master } : {}),
  });
  const [source] = await db.select().from(schema.telegramSources).where(eq(schema.telegramSources.channelIdentifier, channel));
  const [message] = source ? await db.select().from(schema.telegramMessages).where(and(eq(schema.telegramMessages.telegramSourceId, source.id), eq(schema.telegramMessages.externalMessageId, id))) : [];
  return { outcome, records, channel, id, messageId: message?.id ?? "" };
}
const claimsFor = (messageId: string) => db.select().from(schema.optionsClaims).where(eq(schema.optionsClaims.telegramMessageId, messageId));
const signalsFor = (messageId: string) => db.select({ id: schema.signals.id }).from(schema.signals).where(eq(schema.signals.telegramMessageId, messageId));
const countInstruments = async (symbol: string) => (await db.select({ id: schema.instruments.id }).from(schema.instruments).where(eq(schema.instruments.symbol, symbol))).length;

describe("worker path records an UNVERIFIED options claim", () => {
  it("stores the parsed claim and assessment; no master is attached unless configured; nothing else is created", async () => {
    const niftyBefore = await countInstruments("NIFTY");
    const r = await run(NIFTY);
    expect(r.outcome).toMatchObject({ outcome: "options_claim_not_ingested" });
    const [row, ...rest] = await claimsFor(r.messageId);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      parserVersion: TELEGRAM_PARSER_VERSION, resultKind: "claim", assessmentOutcome: "INSUFFICIENT_EVIDENCE", approvalPossible: false,
      claim: { underlying: "NIFTY", strike: 24500, optionType: "CE", targets: [150], levelBasis: "premium" },
      provenance: { contractMaster: { configured: false }, premiumProvider: { configured: false } },
      verification: { status: "unconfigured" },
    });
    expect((row?.reasons as Array<{ code: string }>).map((x) => x.code)).toEqual(expect.arrayContaining(["contract.master_unconfigured", "option_premium_data.unavailable"]));
    expect(r.outcome.optionsClaimId).toBe(row?.id);
    expect(await signalsFor(r.messageId)).toHaveLength(0); // no signal
    expect(await countInstruments("NIFTY")).toBe(niftyBefore); // no equity instrument
  });

  it("an explicitly configured master is used AND recorded as provenance; premium stays unconfigured", async () => {
    const r = await run(NIFTY, { master: fixtureMaster() });
    const [row] = await claimsFor(r.messageId);
    expect(row?.verification).toMatchObject({ status: "verified", contract: { contractId: "TESTFX-1", lotSize: 4321 } });
    expect(row?.provenance).toMatchObject({ contractMaster: { configured: true, name: "manual-reference:TEST-FIXTURE-manual-v1", reference: { kind: "manual_verified", entryCount: 3 } }, premiumProvider: { configured: false } });
    expect(row?.assessmentOutcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(row?.approvalPossible).toBe(false);
  });

  it("ambiguous and unsupported options results are preserved WITHOUT an invented claim", async () => {
    const amb = await run("BUY NIFTY 24500 CE @ 120 SELL BANKNIFTY 52000 PE @ 300");
    const [a] = await claimsFor(amb.messageId);
    expect(a).toMatchObject({ resultKind: "ambiguous", claim: null, assessmentOutcome: null, verification: null, premium: null, approvalPossible: false });
    expect((a?.detail as { directives: unknown[] }).directives.length).toBeGreaterThanOrEqual(2);
    expect((a?.reasons as Array<{ code: string }>)[0]?.code).toBe("directives.ambiguous");

    const unsup = await run("BUY NIFTYBANK 52000 PE @ 300 SL 250 TGT 350");
    const [u] = await claimsFor(unsup.messageId);
    expect(u).toMatchObject({ resultKind: "unsupported", claim: null, detail: { symbol: "NIFTYBANK", form: "spaced_strike_type" }, assessmentOutcome: null });
    expect((u?.reasons as Array<{ code: string }>)[0]?.code).toBe("underlying.unsupported_options_shape");
    expect(await signalsFor(amb.messageId)).toHaveLength(0);
    expect(await signalsFor(unsup.messageId)).toHaveLength(0);
  });

  it("ordinary equity messages and equity-only ambiguity record NO options claim", async () => {
    const eq1 = await run(`BUY OCPLAIN${randomLetters(5)} @ 100 SL 95 TGT 110`);
    expect(await claimsFor(eq1.messageId)).toHaveLength(0);
    const eq2 = await run("BUY RELIANCE @ 2800 SELL TCS @ 3500");
    expect(await claimsFor(eq2.messageId)).toHaveLength(0);
  });
});

describe("accidental external market-data requests are blocked before transport", () => {
  it("with the REAL Yahoo adapter registered, the worker's market refresh is refused by the guard; the job still completes and no public host is contacted", async () => {
    marketDataProviders.register(YAHOO_PROVIDER_NAME, new YahooFinanceAdapter());
    try {
      const before = networkGuardStats().blocked.length;
      const r = await run(`BUY GUARD${randomLetters(5)} @ 100 SL 95 TGT 110`);
      expect(r.outcome.outcome).toMatch(/validation_created|validation_already_existed/); // local processing completed
      const refused = networkGuardStats().blocked.slice(before);
      expect(refused.length).toBeGreaterThanOrEqual(1);
      expect(refused.every((a) => a.host.endsWith("finance.yahoo.com") && a.via === "fetch")).toBe(true);
    } finally {
      marketDataProviders.register(YAHOO_PROVIDER_NAME, offlineMarket);
    }
  }, 30_000);
});

describe("retries are idempotent and never overwrite", () => {
  it("re-running the same job returns the same row; still exactly one row", async () => {
    const first = await run(NIFTY);
    const again = await run(NIFTY, { channel: first.channel, id: first.id });
    expect(again.messageId).toBe(first.messageId);
    expect(again.outcome.optionsClaimId).toBe(first.outcome.optionsClaimId);
    expect(await claimsFor(first.messageId)).toHaveLength(1);
    expect(again.records.find((x) => x.event === "worker.options.claim_not_ingested")).toMatchObject({ recordCreated: false, differsFromStored: false });
  });

  it("a retry whose result would differ (a master is now configured) reports it and leaves the stored assessment untouched", async () => {
    const first = await run(NIFTY);
    const [before] = await claimsFor(first.messageId);
    const retry = await run(NIFTY, { channel: first.channel, id: first.id, master: fixtureMaster() });
    expect(retry.outcome.optionsClaimId).toBe(first.outcome.optionsClaimId);
    expect(retry.records.find((x) => x.event === "worker.options.claim_not_ingested")).toMatchObject({ recordCreated: false, differsFromStored: true });
    const rows = await claimsFor(first.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(before); // byte-for-byte the earlier record
  });

  it("concurrent identical intakes converge on one row", async () => {
    const first = await run(NIFTY);
    const results = await Promise.all(Array.from({ length: 4 }, () => run(NIFTY, { channel: first.channel, id: first.id })));
    for (const x of results) expect(x.outcome.optionsClaimId).toBe(first.outcome.optionsClaimId);
    expect(await claimsFor(first.messageId)).toHaveLength(1);
  });
});

describe("database guarantees", () => {
  it("rejects a second row for the same (message, parser version), an approvable row, and a claim-shape mismatch", async () => {
    const r = await run(NIFTY);
    const base = { telegramMessageId: r.messageId, resultKind: "unsupported", reasons: [], provenance: {} };
    await expect(db.insert(schema.optionsClaims).values({ ...base, parserVersion: TELEGRAM_PARSER_VERSION })).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(db.insert(schema.optionsClaims).values({ ...base, parserVersion: "x-approvable", approvalPossible: true })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(db.insert(schema.optionsClaims).values({ ...base, parserVersion: "x-shape", resultKind: "claim" })).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await claimsFor(r.messageId)).toHaveLength(1);
  });
});

describe("GET /options-claims/:messageId", () => {
  const app = async () =>
    buildApp({ apiKey: API_KEY, telegramWebhookSecret: WEBHOOK_SECRET, telegramQueue: { add: async () => ({ id: "unused" }) } as never, db, logger: false, structuredLogger: createStructuredLogger(() => undefined) });
  const auth = { authorization: `Bearer ${API_KEY}` };

  it("requires the bearer token (401 without/with a wrong token) before touching the database", async () => {
    const a = await app();
    const r = await run(NIFTY);
    expect((await a.inject({ method: "GET", url: `/options-claims/${r.messageId}` })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: `/options-claims/${r.messageId}`, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/options-claims/not-a-uuid", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    await a.close();
  });

  it("validates the id and 404s when nothing is recorded", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/options-claims/not-a-uuid", headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: `/options-claims/${randomUUID()}`, headers: auth })).statusCode).toBe(404);
    await a.close();
  });

  it("returns the labelled, non-approving record", async () => {
    const a = await app();
    const r = await run(NIFTY);
    const res = await a.inject({ method: "GET", url: `/options-claims/${r.messageId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { claims: Array<Record<string, unknown>>; versionCount: number; notice: string; selectedParserVersion: unknown };
    expect(body.versionCount).toBe(1);
    expect(body.selectedParserVersion).toBeNull();
    expect(body.notice).toMatch(/not signals, not approvals/);
    expect(body.claims[0]).toMatchObject({ parserVersion: TELEGRAM_PARSER_VERSION, resultKind: "claim", assessmentOutcome: "INSUFFICIENT_EVIDENCE", approvalPossible: false });
    expect(JSON.stringify(body)).not.toMatch(/"approvalPossible":true|"APPROVE"/);
    await a.close();
  });

  it("with several parser versions it lists EVERY labelled version (none chosen silently) and filters only on request", async () => {
    const a = await app();
    const r = await run(NIFTY);
    await db.insert(schema.optionsClaims).values({
      telegramMessageId: r.messageId, parserVersion: "telegram-regex-v1", resultKind: "unsupported", detail: { symbol: "NIFTY", form: "legacy" },
      reasons: [{ code: "underlying.unsupported_options_shape", severity: "insufficient", description: "legacy" }], provenance: { contractMaster: { configured: false }, premiumProvider: { configured: false } },
    });
    const all = (await a.inject({ method: "GET", url: `/options-claims/${r.messageId}`, headers: auth })).json() as { versionCount: number; claims: Array<{ parserVersion: string }> };
    expect(all.versionCount).toBe(2);
    expect(all.claims.map((c) => c.parserVersion)).toEqual(["telegram-regex-v1", TELEGRAM_PARSER_VERSION]); // sorted, both labelled
    const one = (await a.inject({ method: "GET", url: `/options-claims/${r.messageId}?parserVersion=telegram-regex-v1`, headers: auth })).json() as { selectedParserVersion: string; claims: Array<{ parserVersion: string }> };
    expect(one.selectedParserVersion).toBe("telegram-regex-v1");
    expect(one.claims.map((c) => c.parserVersion)).toEqual(["telegram-regex-v1"]);
    expect((await a.inject({ method: "GET", url: `/options-claims/${r.messageId}?parserVersion=nope`, headers: auth })).statusCode).toBe(404);
    await a.close();
  });
});

describe("read-only viewer against the real API route (loopback only)", () => {
  it("shows the stored result end to end; 401 without the token", async () => {
    const api = await buildApp({ apiKey: API_KEY, telegramWebhookSecret: WEBHOOK_SECRET, telegramQueue: { add: async () => ({ id: "unused" }) } as never, db, logger: false, structuredLogger: createStructuredLogger(() => undefined) });
    await api.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = (api.server.address() as { port: number }).port;
    const viewer = createViewerServer({ apiBase: `http://127.0.0.1:${apiPort}`, port: 0, log: () => undefined });
    const bound = await viewer.listen();
    try {
      const r = await run(NIFTY);
      const call = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${bound.port}/view/options-claims/${r.messageId}`, { headers });
      expect((await call({})).status).toBe(401);
      const ok = await call({ authorization: `Bearer ${API_KEY}` });
      expect(ok.status).toBe(200);
      const view = (await ok.json()) as { versions: Array<{ kind: string; banner: string; approvalPossible: boolean; reasons: Array<{ code: string }> }> };
      expect(view.versions).toHaveLength(1);
      expect(view.versions[0]).toMatchObject({ kind: "claim", banner: "Stored assessment — not an order", approvalPossible: false });
      expect(view.versions[0]?.reasons.map((x) => x.code)).toContain("option_premium_data.unavailable");
    } finally {
      await new Promise<void>((res) => viewer.server.close(() => res()));
      await api.close();
    }
  }, 30_000);
});
