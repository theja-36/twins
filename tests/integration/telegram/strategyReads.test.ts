/**
 * Stage 03 closure against REAL PostgreSQL (migration 0043 and the strategy read API): versioned playbooks cannot be rewritten by anyone, and a claim is compared with archived history only as of its own time.
 * The archive is built by the real import and the real outcome evaluator from SYNTHETIC messages and bars (no provider, no Telegram, no network).
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "../../../packages/auth/src/index";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { buildChannelProfile, buildPlaybookContent, createPlaybook, inspectInput, memoryProvider, proposeVersion, rollbackPlaybook, runEvaluation, runImport, transitionVersion, type PlaybookEvaluation } from "../../../packages/historical/src/index";
import { registerHistoryIntelRoutes } from "../../../apps/api/src/intelligenceApi";
import { buildTelegramIntelOps, registerTelegramIntelRoutes } from "../../../apps/api/src/telegramIntelApi";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { tempDir, writeJsonl } from "../../support/historicalFixtures";
import { dailyBars, datasetOf, optionSeries, underlyingSeries } from "../../support/outcomeFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const URL_ = requireTestDatabaseUrl(), pool = new pg.Pool({ connectionString: URL_, max: 3 });
let handle: BoundedDbHandle;
beforeAll(() => { handle = createBoundedDb(URL_, { max: 4, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as Array<Record<string, unknown>>;
const owner = { kind: "OWNER" as const, id: "owner" }, system = { kind: "SYSTEM" as const, id: "learning-job" };
const evaluation = (resolved = 40): PlaybookEvaluation => ({ outOfSample: true, resolved, driftFlag: false, evaluatedAt: new Date().toISOString(), metrics: { winRate: 0.5 }, });
async function refused(f: () => Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null; try { await f(); } catch (e) { err = e; }
  expect(err, "expected the database to refuse").not.toBeNull();
  expect(`${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""}`).toMatch(re);
}
async function playbook(): Promise<{ id: string; sourceId: string }> {
  const [src] = await handle.db.insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Date.now()}${randomUUID().slice(0, 6)}` }).returning();
  return { id: await createPlaybook(handle.db, { sourceKind: "TELEGRAM_CHANNEL", telegramSourceId: must(src).id, name: `pb-${randomUUID().slice(0, 8)}` }), sourceId: must(src).id };
}
const content = () => buildPlaybookContent(buildChannelProfile([]));

describe("migration 0043: a playbook version cannot be silently rewritten", () => {
  it("content, identity and creation time never change, and a version is never deleted", async () => {
    const { id } = await playbook(), v = await proposeVersion(handle.db, id, content(), system);
    await refused(() => pool.query("update playbook_versions set content = '{\"rewritten\":true}'::jsonb where id = $1", [v.versionId]), /never change: propose a new version/);
    await refused(() => pool.query("update playbook_versions set version = 9 where id = $1", [v.versionId]), /never change: propose a new version/);
    await refused(() => pool.query("update playbook_versions set created_at = now() - interval '1 year' where id = $1", [v.versionId]), /never change: propose a new version/);
    await refused(() => pool.query("delete from playbook_versions where id = $1", [v.versionId]), /never deleted/);
    await refused(() => pool.query("insert into playbook_versions (id, playbook_id, version, state, content) values (gen_random_uuid(), $1, 7, 'ACTIVE', '{}'::jsonb)", [id]), /starts as a DRAFT/);
  });
  it("only legal state moves, and ACTIVE needs recorded performance and at least 30 resolved cases, whatever code asks", async () => {
    const { id } = await playbook(), v = await proposeVersion(handle.db, id, content(), system);
    await refused(() => pool.query("update playbook_versions set state = 'ACTIVE', performance = '{}'::jsonb, sample_size = 99 where id = $1", [v.versionId]), /illegal playbook version transition DRAFT -> ACTIVE/);
    await transitionVersion(handle.db, v.versionId, "EVALUATING", system, "evaluate");
    await refused(() => pool.query("update playbook_versions set state = 'ACTIVE', performance = '{}'::jsonb, sample_size = 29 where id = $1", [v.versionId]), /at least 30 resolved cases/);
    await refused(() => pool.query("update playbook_versions set state = 'ACTIVE', sample_size = 40 where id = $1", [v.versionId]), /performance|evidence_check|at least 30/);
    await transitionVersion(handle.db, v.versionId, "ACTIVE", owner, "ok", evaluation(40));
    expect((await q("select state, sample_size from playbook_versions where id = $1", [v.versionId]))[0]).toMatchObject({ state: "ACTIVE", sample_size: 40 });
  });
  it("the evidence of an activated version is frozen, and a rolled-back version is final", async () => {
    const { id } = await playbook(), v = await proposeVersion(handle.db, id, content(), system); await transitionVersion(handle.db, v.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, v.versionId, "ACTIVE", owner, "ok", evaluation(40));
    for (const set of ["performance = '{\"winRate\":1}'::jsonb", "sample_size = 400", "confidence = 0.99", "limitations = 'edited'"]) await refused(() => pool.query(`update playbook_versions set ${set} where id = $1`, [v.versionId]), /frozen/);
    await rollbackPlaybook(handle.db, id, owner, "test");
    expect((await q("select state from playbook_versions where id = $1", [v.versionId]))[0]!["state"]).toBe("ROLLED_BACK");
    await refused(() => pool.query("update playbook_versions set state = 'ACTIVE' where id = $1", [v.versionId]), /illegal playbook version transition ROLLED_BACK -> ACTIVE/);
    await refused(() => pool.query("update playbook_versions set state = 'EVALUATING' where id = $1", [v.versionId]), /illegal playbook version transition/);
  });
  it("the service lifecycle still works end to end (retire on activation, rollback restores the earlier evaluated version)", async () => {
    const { id } = await playbook(), a = await proposeVersion(handle.db, id, content(), system); await transitionVersion(handle.db, a.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, a.versionId, "ACTIVE", owner, "ok", evaluation(40));
    const b = await proposeVersion(handle.db, id, content(), system); await transitionVersion(handle.db, b.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, b.versionId, "ACTIVE", owner, "better", evaluation(60));
    expect((await q("select version, state from playbook_versions where playbook_id = $1 order by version", [id])).map((r) => `${r.version}:${r.state}`)).toEqual(["1:RETIRED", "2:ACTIVE"]);
    await rollbackPlaybook(handle.db, id, owner, "bad week");
    expect((await q("select version, state from playbook_versions where playbook_id = $1 order by version", [id])).map((r) => `${r.version}:${r.state}`)).toEqual(["1:ACTIVE", "2:ROLLED_BACK"]);
  });
});

const D0 = new Date("2024-03-04T00:00:00Z"), NOW = new Date("2031-01-06T05:00:00Z");
const auth = new AuthService({ store: memoryAuthStore(), audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true } });
const app = Fastify(); let token = "";
beforeAll(async () => {
  registerAuthRoutes(app, { auth }); const ops = buildTelegramIntelOps(handle.db);
  registerHistoryIntelRoutes(app, { auth, ops }); registerTelegramIntelRoutes(app, { auth, ops, now: () => NOW });
  await auth.register({ email: "t@example.com", password: "correct horse battery staple" }); token = (await auth.login({ email: "t@example.com", password: "correct horse battery staple" })).token;
});
// `null` means "send no credentials". (A default parameter would silently turn an explicit `undefined` into the session token, which made the unauthenticated checks run authenticated.)
const get = (url: string, t: string | null = token) => app.inject({ method: "GET", url, headers: t ? { authorization: `Bearer ${t}` } : {} });
const liveClaim = (o: Record<string, unknown> = {}) => ({ action: "buy", intent: "long_entry_presumed", underlying: "NIFTY", underlyingAliasUsed: false, strike: 24500, optionType: "CE", compactCodeUnrecognized: false, optionTypeConflict: false, expiry: { status: "full", day: 28, month: 3, year: 2024, raw: "28 MAR 2024" }, entry: { type: "at", price: 100 }, stopLoss: 80, targets: [120, 140], levelBasis: "premium", levelBasisConflict: false, impliedUnderlyingView: "bullish", ...o });
async function liveClaimAt(ts: string, claim: Record<string, unknown> = liveClaim()): Promise<string> {
  const src = randomUUID(), m = randomUUID(), c = randomUUID();
  await pool.query("insert into telegram_sources (id, channel_identifier) values ($1, $2)", [src, `tg_chat_-100${Date.now()}${randomUUID().slice(0, 5)}`]);
  await pool.query("insert into telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text) values ($1, $2, '1', $3, 'BUY NIFTY')", [m, src, ts]);
  await pool.query("insert into options_claims (id, telegram_message_id, parser_version, result_kind, claim, reasons, provenance) values ($1, $2, 'itest', 'claim', $3, '[]', '{}')", [c, m, JSON.stringify(claim)]);
  return c;
}
let archiveBuilt = false;
async function buildArchive(): Promise<void> {
  if (archiveBuilt) return; archiveBuilt = true;
  const ch = `strat-${randomUUID().slice(0, 8)}`, file = writeJsonl(tempDir(), "export.jsonl", [{ channel: ch, message_id: 1, timestamp: D0.toISOString(), text: "BUY NIFTY 24500 CE 28 MAR 2024 @ 100 SL 80 TGT 120 140 premium", market: "NSE" }]);
  const imp = await runImport(handle.db, await inspectInput(file), { label: `strat-${randomUUID().slice(0, 8)}`, defaultMarket: "NSE", createdBy: "service:itest", confirmedSource: file, now: new Date("2026-10-30T10:00:00Z") });
  const data = datasetOf([optionSeries("NIFTY", 24500, "CE", "2024-03-28", dailyBars({ start: D0, days: 24, base: 100, at: { 2: [100, 121, 100, 120] } })), underlyingSeries("NIFTY", dailyBars({ start: D0, days: 24, base: 22000 }))]);
  const r = await runEvaluation(handle.db, { scope: { kind: "BATCH", batchId: imp.batchId }, provider: memoryProvider([data]), createdBy: "service:itest", asOf: new Date("2026-06-01T00:00:00Z") });
  expect(r.outcome).toBe("EVALUATED");
}

describe("historical matches are computed as of the claim's own time", () => {
  it("requires a session and validates the id", async () => {
    await buildArchive(); const c = await liveClaimAt("2024-06-03T00:00:00Z");
    expect((await get(`/intelligence/claims/${c}/historical-matches`, null)).statusCode).toBe(401);
    expect((await get("/intelligence/claims/not-a-uuid/historical-matches")).statusCode).toBe(422); expect((await get(`/intelligence/claims/${randomUUID()}/historical-matches`)).statusCode).toBe(404);
  });
  it("a claim made AFTER the outcome was known sees the archived win, labelled as insufficient evidence and as association only", async () => {
    await buildArchive(); const c = await liveClaimAt("2024-06-03T00:00:00Z", liveClaim({ expiry: { status: "full", day: 20, month: 6, year: 2024, raw: "20 JUN 2024" } }));
    const j = (await get(`/intelligence/claims/${c}/historical-matches`)).json();
    expect(j).toMatchObject({ source: "ARCHIVE_IMPORT", asOf: "2024-06-03T00:00:00.000Z" }); expect(j.casesConsidered).toBeGreaterThanOrEqual(1);
    expect(j.result.aggregate).toMatchObject({ status: "INSUFFICIENT_EVIDENCE" }); expect(j.result.aggregate.wins).toBeGreaterThanOrEqual(1); expect(j.limitations.join(" ")).toMatch(/not a prediction/);
    for (const m of j.result.matches) expect(Date.parse(m.observedAt)).toBeLessThan(Date.parse("2024-06-03T00:00:00Z")); // every match pre-dates the claim, with its original timestamp
    expect(j.result.notes.join(" ")).toMatch(/historical association only/);
  });
  it("a claim made after the archived message but BEFORE its outcome was known does not get the win: the case is unresolved", async () => {
    await buildArchive(); const c = await liveClaimAt("2024-03-05T00:00:00Z");
    const j = (await get(`/intelligence/claims/${c}/historical-matches`)).json();
    expect(j.result.aggregate.wins).toBe(0); expect(j.result.aggregate.unresolved).toBeGreaterThanOrEqual(1); expect(j.result.temporal.outcomeNotYetKnown).toBeGreaterThanOrEqual(1);
  });
  it("a claim made BEFORE any archived message gets no history at all (missing evidence, not a neutral signal)", async () => {
    await buildArchive(); const c = await liveClaimAt("2024-03-01T00:00:00Z");
    expect((await get(`/intelligence/claims/${c}/historical-matches`)).json()).toMatchObject({ state: "UNAVAILABLE", casesConsidered: 0, result: null });
  });
  it("an ambiguous or unsupported result is not compared with history", async () => {
    const src = randomUUID(), m = randomUUID(), c = randomUUID();
    await pool.query("insert into telegram_sources (id, channel_identifier) values ($1, $2)", [src, `tg_chat_-100${Date.now()}x`]); await pool.query("insert into telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text) values ($1, $2, '1', now(), 'x')", [m, src]);
    await pool.query("insert into options_claims (id, telegram_message_id, parser_version, result_kind, detail, reasons, provenance) values ($1, $2, 'itest', 'ambiguous', '{}', '[]', '{}')", [c, m]);
    expect((await get(`/intelligence/claims/${c}/historical-matches`)).json()).toMatchObject({ state: "NOT_APPLICABLE", result: null });
  });
});

describe("playbook, performance and archive reads", () => {
  it("lists and shows versioned playbooks with their audited history; an unknown id is 404, bad parameters are 422, bounds hold", async () => {
    const { id, sourceId } = await playbook(), a = await proposeVersion(handle.db, id, content(), system); await transitionVersion(handle.db, a.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, a.versionId, "ACTIVE", owner, "ok", evaluation(40));
    const list = (await get(`/intelligence/playbooks?channelId=${sourceId}&limit=5`)).json(); expect(list.playbooks.map((p: { id: string }) => p.id)).toEqual([id]); expect(list.playbooks[0]).toMatchObject({ activeVersion: 1, versions: 1 });
    const one = (await get(`/intelligence/playbooks/${id}`)).json(); expect(one.versions[0]).toMatchObject({ version: 1, state: "ACTIVE", sampleSize: 40 }); expect(one.versions[0].events.map((e: { toState: string }) => e.toState)).toEqual(["PROPOSED", "EVALUATING", "ACTIVE"]);
    expect((await get(`/intelligence/playbooks/${randomUUID()}`)).statusCode).toBe(404);
    for (const u of ["/intelligence/playbooks?limit=0", "/intelligence/playbooks?limit=201", "/intelligence/playbooks?offset=-1", "/intelligence/playbooks?channelId=x", "/intelligence/playbooks?bogus=1", "/intelligence/archive/channels?limit=101"]) expect((await get(u)).statusCode, u).toBe(422);
    expect((await get("/intelligence/playbooks?channelId=" + randomUUID())).json()).toMatchObject({ state: "EMPTY", playbooks: [] });
    expect((await get("/intelligence/playbooks", null)).statusCode).toBe(401);
  });
  it("pagination is deterministic and does not repeat or skip records", async () => {
    for (let i = 0; i < 3; i++) await playbook();
    const all = (await get("/intelligence/playbooks?limit=200")).json().playbooks.map((p: { id: string }) => p.id) as string[];
    const p1 = (await get("/intelligence/playbooks?limit=2&offset=0")).json().playbooks.map((p: { id: string }) => p.id), p2 = (await get("/intelligence/playbooks?limit=2&offset=2")).json().playbooks.map((p: { id: string }) => p.id);
    expect([...p1, ...p2]).toEqual(all.slice(0, 4)); expect(new Set([...p1, ...p2]).size).toBe(4);
  });
  it("channel performance never claims a reliability: it reports what was claimed and what the pipeline did, and says outcomes are not available", async () => {
    const c = await liveClaimAt(new Date().toISOString()); void c;
    const ch = (await q("select id from telegram_sources order by created_at desc limit 1"))[0]!["id"];
    const j = (await get(`/intelligence/channels/${ch}/performance`)).json();
    expect(j).toMatchObject({ outcomes: { status: "NOT_AVAILABLE" }, reliability: "NOT_AVAILABLE", archive: { linked: false } }); expect(j.funnel.claims.claim).toBeGreaterThanOrEqual(1);
    expect(j.channel.channel).toMatch(/^\*\*\*/); expect((await get(`/intelligence/channels/${randomUUID()}/performance`)).statusCode).toBe(404);
  });
  it("archive score tables are read-only, bounded and honest when empty or present", async () => {
    const j = (await get("/intelligence/archive/channels?limit=5")).json(); expect(["EMPTY", "OK"]).toContain(j.state); expect(j.source).toBe("ARCHIVE_IMPORT"); expect(j.scorecards.length).toBeLessThanOrEqual(5);
    for (const s of j.scorecards) { expect(Date.parse(s.asOf)).not.toBeNaN(); for (const w of s.windows) expect(w.sampleSize).toBeGreaterThanOrEqual(0); }
  });
});
