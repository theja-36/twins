/**
 * Stage 03 (G-19) against REAL PostgreSQL: Telegram claim -> candidate -> the SHARED research dispatch.
 * Real messages, claims and revisions are stored with the real triggers (hash chain, revision metadata); the cycle runs on them; the database's own refusals are exercised directly.
 * Every scenario uses its own channel (telegram source) and the cycle is scoped to it, so nothing here touches claims created by other tests.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../../packages/database/src/index";
import { createCandidateQueue } from "../../../packages/database/src/index";
import { dispatchResearch } from "../../../packages/opportunity/src/index";
import { DEFAULT_TELEGRAM_CANDIDATE_RUN, runTelegramCandidateCycle } from "../../../packages/signals/src/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import pg from "pg";

const URL_ = requireTestDatabaseUrl(), db = createDb(URL_);
const clients: pg.Client[] = []; let shared: pg.Client | null = null;
const own = async (): Promise<pg.Client> => { if (!shared) { shared = new pg.Client({ connectionString: URL_ }); await shared.connect(); clients.push(shared); } return shared; };
afterAll(async () => { await Promise.all(clients.map((c) => c.end().catch(() => undefined))); });
const NOW = new Date(), at = (minAgo: number): Date => new Date(NOW.getTime() - minAgo * 60_000);
const cfg = { ...DEFAULT_TELEGRAM_CANDIDATE_RUN, enabled: true, forceDataSource: "FIXTURE" as const };

const claimJson = (o: Record<string, unknown> = {}) => ({ action: "buy", intent: "long_entry_presumed", underlying: "NIFTY", underlyingAliasUsed: false, strike: 24500, optionType: "CE", compactCodeUnrecognized: false, optionTypeConflict: false, expiry: { status: "missing" }, entry: { type: "above", price: 118 }, stopLoss: 96, targets: [140, 165], levelBasis: "premium", levelBasisConflict: false, impliedUnderlyingView: "bullish", ...o });
async function channel(): Promise<string> { const c = await own(), id = randomUUID(); await c.query("insert into telegram_sources (id, channel_identifier) values ($1, $2)", [id, `tg_chat_-100${Date.now()}${Math.floor(Math.random() * 1e6)}`]); return id; }
async function message(sourceId: string, o: { ext?: string; origin?: string | null; editDate?: Date | null; ts: Date; text?: string }): Promise<string> {
  const c = await own(), id = randomUUID(), ext = o.ext ?? String(Math.floor(Math.random() * 1e9));
  await c.query("insert into telegram_messages (id, telegram_source_id, external_message_id, message_timestamp, raw_text, origin_message_id, edit_date) values ($1, $2, $3, $4, $5, $6, $7)", [id, sourceId, ext, o.ts, o.text ?? "BUY NIFTY 24500 CE ABOVE 118 SL 96 TGT 140 165", o.origin === undefined ? ext : o.origin, o.editDate ?? null]);
  return id;
}
async function claim(messageId: string, kind: "claim" | "ambiguous" | "unsupported" = "claim", json: Record<string, unknown> = claimJson()): Promise<string> {
  const c = await own(), id = randomUUID();
  await c.query("insert into options_claims (id, telegram_message_id, parser_version, result_kind, claim, detail, reasons, provenance) values ($1, $2, $3, $4, $5, $6, '[]', '{}')", [id, messageId, `itest-${randomUUID().slice(0, 8)}`, kind, kind === "claim" ? JSON.stringify(json) : null, kind === "claim" ? null : JSON.stringify({ note: "x" })]);
  return id;
}
const cycle = (sourceIds: string[], o: Record<string, unknown> = {}) => runTelegramCandidateCycle({ db, config: cfg, now: () => NOW, scope: { sourceIds }, ...o });
const one = async (sql: string, p: unknown[] = []): Promise<Record<string, unknown>> => ((await (await own()).query(sql, p)).rows[0] ?? {}) as Record<string, unknown>;
const all = async (sql: string, p: unknown[] = []): Promise<Array<Record<string, unknown>>> => (await (await own()).query(sql, p)).rows as Array<Record<string, unknown>>;
async function refused(f: () => Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null; try { await f(); } catch (e) { err = e; }
  expect(err, "expected the database to refuse").not.toBeNull();
  expect(`${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""}`).toMatch(re);
}

describe("a Telegram claim becomes a candidate (G-19)", () => {
  it("creates one NEW, unverified TELEGRAM candidate with provenance, thesis, missing information and an audit row; a second run changes nothing", async () => {
    const s = await channel(), m = await message(s, { ts: at(10) }), c = await claim(m);
    const r = await cycle([s]); expect(r).toMatchObject({ examined: 1, created: 1, failed: 0 });
    const k = await one("select * from opportunity_candidates where claim_id = $1", [c]);
    expect(k).toMatchObject({ source: "TELEGRAM", state: "NEW", underlying: "NIFTY", exchange: "NSE", side: "BUY", option_type: "CE", entry_kind: "above", data_source: "FIXTURE", validation_status: "UNVERIFIED", candidate_version: 1, scan_id: null, dedupe_key: null });
    expect(Number(k["strike"])).toBe(24500); expect(Number(k["entry_low"])).toBe(118); expect(Number(k["stop_loss"])).toBe(96); expect(k["targets"]).toEqual([140, 165]);
    expect(k["thesis"]).toMatch(/Unverified claim, not a recommendation/); expect(k["missing_information"]).toEqual(expect.arrayContaining(["contractVerification", "expiry"]));
    expect(k["provenance"]).toMatchObject({ source: "TELEGRAM", channelId: s, messageId: m, claimId: undefined, policyVersion: "telegram-candidacy-v1" });
    expect(JSON.stringify(k["provenance"])).not.toContain("BUY NIFTY"); expect(String(k["thesis"])).not.toContain("TGT"); // no raw message text is stored
    expect(k["evidence"]).toEqual([{ kind: "telegram_claim", claimId: c, messageId: m }]);
    const a = await one("select outcome, candidate_id, policy_version from telegram_claim_candidacy where claim_id = $1", [c]); expect(a).toMatchObject({ outcome: "CREATED", candidate_id: k["id"], policy_version: "telegram-candidacy-v1" });
    expect(await cycle([s])).toMatchObject({ examined: 0, created: 0 });
    expect(Number((await one("select count(*)::int as n from opportunity_candidates where claim_id = $1", [c]))["n"])).toBe(1);
    expect((await one("select signal_type, horizon from signal_classifications where claim_id = $1", [c]))["signal_type"]).toBe("OPTIONS_BUY"); // classification stored as evidence
  });
  it("never creates a candidate from noise: ambiguous and unsupported results are not read, and the database refuses a forced insert", async () => {
    const s = await channel(), a = await claim(await message(s, { ts: at(5) }), "ambiguous"), u = await claim(await message(s, { ts: at(4) }), "unsupported");
    expect(await cycle([s])).toMatchObject({ examined: 0, created: 0 });
    expect(Number((await one("select count(*)::int as n from telegram_claim_candidacy where claim_id = any($1::uuid[])", [[a, u]]))["n"])).toBe(0);
    for (const claimId of [a, u]) await refused(async () => (await own()).query("insert into opportunity_candidates (id, source, claim_id, underlying, side, entry_kind, data_source, correlation_id, expires_at, thesis, provenance) values (gen_random_uuid(), 'TELEGRAM', $1, 'NIFTY', 'BUY', 'at', 'FIXTURE', gen_random_uuid(), now() + interval '1 hour', 't', '{\"messageId\":\"m\",\"channelId\":\"c\"}')", [claimId]), /stored parsed claim/);
  });
  it("never invents a value: an unstated entry, a missing instrument and a SELL are recorded as refusals with reason codes", async () => {
    const s = await channel(), t = (min: number) => at(min);
    const noEntry = await claim(await message(s, { ts: t(9) }), "claim", claimJson({ entry: { type: "unspecified" } }));
    const noStrike = await claim(await message(s, { ts: t(8) }), "claim", claimJson({ strike: null }));
    const sell = await claim(await message(s, { ts: t(7) }), "claim", claimJson({ action: "sell", intent: "unresolved" }));
    expect(await cycle([s])).toMatchObject({ examined: 3, created: 0, byOutcome: { INCOMPLETE: 2, UNSUPPORTED: 1 } });
    const rows = await all("select claim_id, outcome, reason_codes, candidate_id from telegram_claim_candidacy where claim_id = any($1::uuid[])", [[noEntry, noStrike, sell]]);
    const by = Object.fromEntries(rows.map((r) => [r["claim_id"] as string, r])); expect(by[noEntry]).toMatchObject({ outcome: "INCOMPLETE", reason_codes: ["ENTRY_NOT_STATED"], candidate_id: null }); expect(by[noStrike]!["reason_codes"]).toEqual(["STRIKE_MISSING"]); expect(by[sell]!["reason_codes"]).toEqual(["SELL_INTENT_UNRESOLVED"]);
    expect(Number((await one("select count(*)::int as n from opportunity_candidates where claim_id = any($1::uuid[])", [[noEntry, noStrike, sell]]))["n"])).toBe(0);
  });
  it("an expired claim does not enter research", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(180) }));
    expect(await cycle([s])).toMatchObject({ created: 0, byOutcome: { EXPIRED: 1 } });
    expect(await one("select outcome, reason_codes from telegram_claim_candidacy where claim_id = $1", [c])).toMatchObject({ outcome: "EXPIRED", reason_codes: ["CLAIM_VALIDITY_ELAPSED"] });
  });
  it("a stop-loss and targets that were not stated stay missing (NULL / empty), never defaulted", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(10) }), "claim", claimJson({ stopLoss: null, targets: [], levelBasis: "unspecified" }));
    await cycle([s]); const k = await one("select stop_loss, targets, missing_information from opportunity_candidates where claim_id = $1", [c]);
    expect(k["stop_loss"]).toBeNull(); expect(k["targets"]).toEqual([]); expect(k["missing_information"]).toEqual(expect.arrayContaining(["stopLoss", "targets", "levelBasis"]));
  });
});

describe("edits, repeats and contradictions", () => {
  it("an edited message: the original's candidate is superseded by version 2 (audited); the old revision is never a candidate again", async () => {
    const s = await channel(), o = await message(s, { ext: "700", origin: "700", ts: at(20) }), a = await claim(o);
    await cycle([s]); const v1 = await one("select id, state from opportunity_candidates where claim_id = $1", [a]); expect(v1["state"]).toBe("NEW");
    const e = await message(s, { ext: "700_edit_1", origin: "700", editDate: at(10), ts: at(20) }), b = await claim(e, "claim", claimJson({ stopLoss: 90 }));
    const r = await cycle([s]); expect(r).toMatchObject({ created: 1, superseded: 1 });
    const v2 = await one("select id, state, candidate_version, stop_loss from opportunity_candidates where claim_id = $1", [b]); expect(v2).toMatchObject({ state: "NEW", candidate_version: 2 }); expect(Number(v2["stop_loss"])).toBe(90);
    expect(await one("select state, superseded_by, state_reason from opportunity_candidates where id = $1", [v1["id"]])).toMatchObject({ state: "SUPERSEDED", superseded_by: v2["id"], state_reason: "MESSAGE_EDITED" });
    const events = await all("select to_state from opportunity_candidate_events where candidate_id = $1 order by occurred_at, id", [v1["id"]]); expect(events.map((x) => x["to_state"])).toEqual(["NEW", "SUPERSEDED"]);
  });
  it("when the original and its edit are both pending, only the current revision becomes a candidate", async () => {
    const s = await channel(), o = await message(s, { ext: "800", origin: "800", ts: at(20) }), a = await claim(o);
    const e = await message(s, { ext: "800_edit_1", origin: "800", editDate: at(10), ts: at(20) }), b = await claim(e, "claim", claimJson({ stopLoss: 91 }));
    expect(await cycle([s])).toMatchObject({ created: 1, byOutcome: { CREATED: 1, SUPERSEDED_REVISION: 1 } });
    expect((await one("select outcome from telegram_claim_candidacy where claim_id = $1", [a]))["outcome"]).toBe("SUPERSEDED_REVISION");
    expect(Number((await one("select count(*)::int as n from opportunity_candidates where claim_id = $1", [a]))["n"])).toBe(0);
    expect((await one("select state from opportunity_candidates where claim_id = $1", [b]))["state"]).toBe("NEW");
  });
  it("an exact repeat from another message is a DUPLICATE of the active candidate, not a second one", async () => {
    const s = await channel(), a = await claim(await message(s, { ts: at(15) })), b = await claim(await message(s, { ts: at(10) }));
    expect(await cycle([s])).toMatchObject({ created: 1, byOutcome: { CREATED: 1, DUPLICATE: 1 } });
    const first = await one("select id from opportunity_candidates where claim_id = $1", [a]);
    expect(await one("select outcome, candidate_id from telegram_claim_candidacy where claim_id = $1", [b])).toMatchObject({ outcome: "DUPLICATE", candidate_id: first["id"] });
    expect(Number((await one("select count(*)::int as n from opportunity_candidates where claim_id = $1", [b]))["n"])).toBe(0);
  });
  it("the opposite view of the same underlying by the same channel is held as CONTRADICTORY with the conflicting candidate named", async () => {
    const s = await channel(), a = await claim(await message(s, { ts: at(15) })), b = await claim(await message(s, { ts: at(10) }), "claim", claimJson({ optionType: "PE", impliedUnderlyingView: "bearish", strike: 24400 }));
    expect(await cycle([s])).toMatchObject({ created: 1, byOutcome: { CREATED: 1, CONTRADICTORY: 1 } });
    const first = await one("select id from opportunity_candidates where claim_id = $1", [a]);
    expect(await one("select outcome, reason_codes, detail, candidate_id from telegram_claim_candidacy where claim_id = $1", [b])).toMatchObject({ outcome: "CONTRADICTORY", reason_codes: ["CONTRADICTS_ACTIVE_CLAIM"], detail: { conflictingCandidateId: first["id"] }, candidate_id: null });
  });
  it("another channel's claims never count as duplicates or contradictions", async () => {
    const s1 = await channel(), s2 = await channel(); await claim(await message(s1, { ts: at(15) })); const b = await claim(await message(s2, { ts: at(10) }), "claim", claimJson({ optionType: "PE", impliedUnderlyingView: "bearish" }));
    await cycle([s1, s2]); expect((await one("select outcome from telegram_claim_candidacy where claim_id = $1", [b]))["outcome"]).toBe("CREATED");
  });
});

describe("database guarantees on candidates and the audit", () => {
  it("a candidate's thesis, provenance, missing information, timeframe and version never change; the candidacy audit is append-only", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(10) })); await cycle([s]); const id = String((await one("select id from opportunity_candidates where claim_id = $1", [c]))["id"]), o = await own();
    for (const set of ["thesis = 'changed'", "provenance = '{}'::jsonb", "missing_information = '[]'::jsonb", "timeframe = 'POSITIONAL'", "candidate_version = 5"]) await refused(() => o.query(`update opportunity_candidates set ${set} where id = $1`, [id]), /never change/);
    await refused(() => o.query("update telegram_claim_candidacy set outcome = 'EXPIRED', candidate_id = null where claim_id = $1", [c]), /append-only|not allowed|audit/i);
    await refused(() => o.query("delete from telegram_claim_candidacy where claim_id = $1", [c]), /append-only|not allowed|audit/i);
    await refused(() => o.query("truncate telegram_claim_candidacy"), /append-only|not allowed|audit/i);
    await refused(() => o.query("insert into telegram_claim_candidacy (id, claim_id, policy_version, outcome, reason_codes, candidate_id) values (gen_random_uuid(), $1, 'telegram-candidacy-v1', 'CREATED', '[]', null)", [randomUUID()]), /foreign key|candidacy_candidate_check|23503|23514/);
  });
  it("one candidate per claim and one decision per claim and policy version", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(10) })); await cycle([s]); const o = await own();
    await refused(() => o.query("insert into opportunity_candidates (id, source, claim_id, underlying, side, entry_kind, data_source, correlation_id, expires_at, thesis, provenance) values (gen_random_uuid(), 'TELEGRAM', $1, 'NIFTY', 'BUY', 'at', 'FIXTURE', gen_random_uuid(), now() + interval '1 hour', 't', '{\"messageId\":\"m\",\"channelId\":\"c\"}')", [c]), /claim_unique|duplicate key/);
    await refused(() => o.query("insert into telegram_claim_candidacy (id, claim_id, policy_version, outcome, reason_codes) values (gen_random_uuid(), $1, 'telegram-candidacy-v1', 'INCOMPLETE', '[\"X\"]')", [c]), /candidacy_claim_policy_unique|duplicate key/);
    await o.query("insert into telegram_claim_candidacy (id, claim_id, policy_version, outcome, reason_codes) values (gen_random_uuid(), $1, 'telegram-candidacy-v2-test', 'INCOMPLETE', '[\"X\"]')", [c]); // a new policy version re-evaluates deliberately
  });
  it("a Telegram candidate needs its provenance and thesis (check constraint)", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(10) })), o = await own();
    await refused(() => o.query("insert into opportunity_candidates (id, source, claim_id, underlying, side, entry_kind, data_source, correlation_id, expires_at) values (gen_random_uuid(), 'TELEGRAM', $1, 'NIFTY', 'BUY', 'at', 'FIXTURE', gen_random_uuid(), now() + interval '1 hour')", [c]), /telegram_provenance_check/);
  });
});

describe("workers: concurrency, safety state, isolation", () => {
  it("two cycles at once create exactly one candidate and one audit row per claim", async () => {
    const s = await channel(), ids: string[] = []; for (let i = 0; i < 6; i++) ids.push(await claim(await message(s, { ts: at(30 - i), text: `BUY NIFTY ${24500 + i * 50} CE ABOVE 118` }), "claim", claimJson({ strike: 24500 + i * 50 })));
    const res = await Promise.all([cycle([s]), cycle([s]), cycle([s])]);
    expect(Number((await one("select count(*)::int as n from opportunity_candidates where claim_id = any($1::uuid[])", [ids]))["n"])).toBeGreaterThanOrEqual(1);
    expect(Number((await one("select count(*)::int as n from telegram_claim_candidacy where claim_id = any($1::uuid[])", [ids]))["n"])).toBe(6);
    expect(Number((await one("select count(*)::int as n from (select claim_id from opportunity_candidates where claim_id = any($1::uuid[]) group by claim_id having count(*) > 1) d", [ids]))["n"])).toBe(0);
    expect(res.reduce((n, r) => n + r.created, 0)).toBe(Number((await one("select count(*)::int as n from opportunity_candidates where claim_id = any($1::uuid[])", [ids]))["n"])); // every candidate was created by exactly one worker
  });
  it("does nothing while the safety state stops it or while disabled", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(10) }));
    expect(await cycle([s], { allowed: async () => false })).toMatchObject({ skipped: "SAFETY_STOPPED", examined: 0 });
    expect(await cycle([s], { config: { ...cfg, enabled: false } })).toMatchObject({ skipped: "DISABLED" });
    expect(Number((await one("select count(*)::int as n from telegram_claim_candidacy where claim_id = $1", [c]))["n"])).toBe(0);
  });
  it("is bounded by its batch size and finishes the rest on the next run", async () => {
    const s = await channel(); for (let i = 0; i < 3; i++) await claim(await message(s, { ts: at(20 - i) }), "claim", claimJson({ strike: 25000 + i * 100 }));
    const first = await cycle([s], { config: { ...cfg, batch: 2 } }); expect(first.examined).toBe(2);
    const second = await cycle([s], { config: { ...cfg, batch: 2 } }); expect(second.examined).toBe(1); expect((await cycle([s])).examined).toBe(0);
  });
});

describe("the SHARED research dispatch picks Telegram candidates up, and they stay distinguishable and unapproved", () => {
  it("a Telegram candidate is claimed by the source-agnostic dispatcher and completed; nothing downstream is created", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(10) }), "claim", claimJson({ underlying: "BANKNIFTY", strike: 52000, optionType: "PE", impliedUnderlyingView: "bearish" })); await cycle([s]);
    const id = String((await one("select id from opportunity_candidates where claim_id = $1", [c]))["id"]), seen: Array<{ id: string; source: string }> = [];
    const queue = createCandidateQueue(db, { underlyings: ["BANKNIFTY"] });
    const r = await dispatchResearch({ queue, now: NOW, enabled: true, batchSize: 20, maxAttempts: 3, leaseMs: 600_000, research: async (cand) => { seen.push({ id: cand.id, source: cand.source }); return {}; } });
    expect(r.researched).toBeGreaterThanOrEqual(1); expect(seen.find((x) => x.id === id)).toEqual({ id, source: "TELEGRAM" });
    expect((await one("select state from opportunity_candidates where id = $1", [id]))["state"]).toBe("READY_FOR_DECISION");
    for (const t of ["user_decisions", "decision_approvals", "paper_orders", "execution_requests"]) expect(Number((await one(`select count(*)::int as n from ${t} where ${t === "user_decisions" ? "candidate_id" : "decision_id"} ${t === "user_decisions" ? "= $1" : "in (select id from user_decisions where candidate_id = $1)"}`, [id]))["n"]), t).toBe(0);
    expect(Number((await one("select count(*)::int as n from opportunity_candidates where source = 'TELEGRAM' and scan_id is not null"))["n"])).toBe(0); // Telegram and independent candidates are distinguishable by construction
    expect(Number((await one("select count(*)::int as n from opportunity_candidates where source = 'INDEPENDENT' and claim_id is not null"))["n"])).toBe(0);
  });
  it("an expired Telegram candidate is expired by the dispatcher and never researched", async () => {
    const s = await channel(), c = await claim(await message(s, { ts: at(85) })); await cycle([s]); const id = String((await one("select id from opportunity_candidates where claim_id = $1", [c]))["id"]);
    const seen: string[] = []; const queue = createCandidateQueue(db, { underlyings: ["NIFTY"] });
    await dispatchResearch({ queue, now: new Date(NOW.getTime() + 10 * 60_000), enabled: true, batchSize: 20, maxAttempts: 3, leaseMs: 600_000, research: async (cand) => { seen.push(cand.id); return {}; } });
    expect(seen).not.toContain(id); expect((await one("select state from opportunity_candidates where id = $1", [id]))["state"]).toBe("EXPIRED");
  });
});

describe("pipeline status and the read model", () => {
  it("channel overview counts claims and candidates; the claim view joins classification, candidacy and candidate", async () => {
    const { listChannelOverview, getClaimView, telegramPipelineStatus } = await import("../../../packages/database/src/index");
    const s = await channel(), c = await claim(await message(s, { ts: at(10) })); await cycle([s]);
    const [ov] = await listChannelOverview(db, NOW, { id: s, limit: 1 }); expect(ov).toMatchObject({ messages: 1, claims: { claim: 1, ambiguous: 0, unsupported: 0 }, candidates: { NEW: 1 } });
    const v = await getClaimView(db, c); expect(v).toMatchObject({ resultKind: "claim", candidacy: { outcome: "CREATED" }, candidate: { state: "NEW", validationStatus: "UNVERIFIED", version: 1 }, classification: { signalType: "OPTIONS_BUY" } });
    expect((await telegramPipelineStatus(db, "telegram-candidacy-v1", NOW)).byOutcome["CREATED"]).toBeGreaterThanOrEqual(1);
  });
});
