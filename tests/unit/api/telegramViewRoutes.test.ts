import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLiveRoutes, safeClaimView, safeReasons } from "../../../apps/api/src/liveApi";

const authorized = (h: string | undefined) => h === "Bearer ok";
const auth = { authorization: "Bearer ok" };
const NOW = new Date("2031-01-05T10:00:00Z");

/** A fake database that answers by looking at the SQL text of each query. */
function fakeDb(answers: { channels?: unknown[]; claimsByKind?: unknown[]; claims?: unknown[] }) {
  const seen: string[] = [];
  const db = { execute: async (q: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(q);
    seen.push(text);
    if (text.includes("telegram_sources s left join")) return { rows: answers.channels ?? [] };
    if (text.includes("group by 1, 2")) return { rows: answers.claimsByKind ?? [] };
    return { rows: answers.claims ?? [] };
  } };
  return { db: db as never, seen };
}
function app(answers: Parameters<typeof fakeDb>[0], extra: { isChatApproved?: (c: string) => boolean } = {}) {
  const f = fakeDb(answers);
  const a = Fastify();
  registerLiveRoutes(a, { db: f.db, authorized, snapshotDir: "/nonexistent", providersDir: "/nonexistent", adminConfigured: false, readSafety: () => ({}), now: () => NOW, ...extra });
  return { a, seen: f.seen };
}
const claimRow = (claim: unknown, o: Record<string, unknown> = {}) => ({ id: "aaaaaaaa-1111-4111-8111-111111111111", parser_version: "telegram-regex-v3", result_kind: "claim", assessment_outcome: "INSUFFICIENT_EVIDENCE", claim, reasons: [{ code: "contract.unverified", severity: "insufficient", description: "SECRET DESCRIPTION" }, { code: "BAD CODE with spaces", severity: "x" }], message_timestamp: "2031-01-05T08:00:00Z", channel_identifier: "-1001234567892544", ...o });
const CLAIM = { action: "buy", intent: "long_entry_presumed", underlying: "SENSEX", strike: 80000, optionType: "CE", entry: { type: "above", price: 300 }, stopLoss: 250, targets: [350, 400], levelBasis: "premium", levelBasisConflict: false, levelBasisInference: { rule: "source-default-premium-v1" }, expiry: { status: "day_month", day: 12, month: 11, raw: "12 NOVEMBER SECRETRAW" }, raw: "RAW MESSAGE FRAGMENT" };

describe("GET /telegram/channels", () => {
  it("needs the bearer token and rejects writes", async () => {
    const { a } = app({});
    expect((await a.inject({ method: "GET", url: "/telegram/channels" })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/telegram/channels", headers: auth })).statusCode).toBe(404);
  });
  it("returns masked channels with counts, claim kinds and capture permission; no content", async () => {
    const { a } = app({
      channels: [{ id: "bbbbbbbb-2222-4222-8222-222222222222", channel_identifier: "-1001234567892544", display_name: "My Channel/<b>", chat_id: "-1001234567892544", messages: 109, revisions: 2, first_at: "2031-01-01T00:00:00Z", last_at: "2031-01-05T08:00:00Z" },
                 { id: "cccccccc-3333-4333-8333-333333333333", channel_identifier: "abc", display_name: null, chat_id: null, messages: 0, revisions: 0, first_at: null, last_at: null }],
      claimsByKind: [{ sid: "bbbbbbbb-2222-4222-8222-222222222222", result_kind: "claim", n: 100 }, { sid: "bbbbbbbb-2222-4222-8222-222222222222", result_kind: "unsupported", n: 3 }],
    }, { isChatApproved: (c) => c === "-1001234567892544" });
    const r = await a.inject({ method: "GET", url: "/telegram/channels", headers: auth });
    expect(r.statusCode).toBe(200);
    const [first, second] = r.json().channels;
    expect(first).toMatchObject({ id: "bbbbbbbb", channel: "***2544", name: "My Channel__b_", messages: 109, revisions: 2, claims: { claim: 100, ambiguous: 0, unsupported: 3 }, captureAllowed: true, lastMessageAgeSeconds: 7200 });
    expect(second).toMatchObject({ channel: "***", messages: 0, captureAllowed: null, lastMessageAt: null, lastMessageAgeSeconds: null });
    expect(r.body).not.toContain("1001234567892544");
  });
  it("captureAllowed is unknown when no policy is supplied", async () => {
    const { a } = app({ channels: [{ id: "bbbbbbbb-2222-4222-8222-222222222222", channel_identifier: "-100999", display_name: null, chat_id: "-100999", messages: 1, revisions: 0, first_at: null, last_at: null }] });
    expect((await a.inject({ method: "GET", url: "/telegram/channels", headers: auth })).json().channels[0].captureAllowed).toBeNull();
  });
});

describe("GET /telegram/claims", () => {
  it("needs the bearer token and validates its inputs", async () => {
    const { a } = app({});
    expect((await a.inject({ method: "GET", url: "/telegram/claims" })).statusCode).toBe(401);
    for (const url of ["/telegram/claims?limit=0", "/telegram/claims?limit=101", "/telegram/claims?limit=abc", "/telegram/claims?channel=2544", "/telegram/claims?channel=***25%27%3B", "/telegram/claims?channel=***toolong"]) {
      expect((await a.inject({ method: "GET", url, headers: auth })).statusCode, url).toBe(400);
    }
  });
  it("returns the explicit field allow-list only: never raw fragments, descriptions or bad codes", async () => {
    const { a, seen } = app({ claims: [claimRow(CLAIM)] });
    const r = await a.inject({ method: "GET", url: "/telegram/claims?channel=***2544&limit=5", headers: auth });
    expect(r.statusCode).toBe(200);
    const c = r.json().claims[0];
    expect(c).toMatchObject({ id: "aaaaaaaa", channel: "***2544", parserVersion: "telegram-regex-v3", resultKind: "claim", assessmentOutcome: "INSUFFICIENT_EVIDENCE", ageSeconds: 7200 });
    expect(c.claim).toMatchObject({ action: "buy", underlying: "SENSEX", strike: 80000, optionType: "CE", entry: { type: "above", price: 300 }, stopLoss: 250, targets: [350, 400], levelBasis: "premium", levelBasisInferred: true, expiry: { status: "day_month", day: 12, month: 11, year: null } });
    expect(c.blockers).toEqual([{ code: "contract.unverified", severity: "insufficient" }]);
    for (const leak of ["RAW MESSAGE FRAGMENT", "SECRETRAW", "SECRET DESCRIPTION", "1001234567892544", "BAD CODE"]) expect(r.body).not.toContain(leak);
    expect(seen.join(" ")).toContain("2544"); // the channel filter reaches the query
  });
  it("handles claims without a parsed claim and unknown values safely", async () => {
    const { a } = app({ claims: [claimRow(null, { result_kind: "unsupported", assessment_outcome: null, parser_version: "weird version!" }), claimRow({ action: "hold", underlying: "X", strike: "80000", targets: ["a", 5], entry: { type: "weird" }, expiry: { status: "nope" } })] });
    const body = (await a.inject({ method: "GET", url: "/telegram/claims", headers: auth })).json();
    expect(body.claims[0]).toMatchObject({ claim: null, resultKind: "unsupported", assessmentOutcome: null, parserVersion: "unknown" });
    expect(body.claims[1].claim).toMatchObject({ action: null, underlying: null, strike: null, targets: [5], entry: { type: null }, expiry: { status: null } });
  });
  it("rejects writes", async () => { expect((await app({}).a.inject({ method: "DELETE", url: "/telegram/claims", headers: auth })).statusCode).toBe(404); });
});

describe("view helpers", () => {
  it("safeClaimView returns null for non-objects and never copies unknown keys", () => {
    expect(safeClaimView("x")).toBeNull();
    expect(safeClaimView([])).toBeNull();
    expect(Object.keys(safeClaimView({ foo: "bar" }) as object).sort()).toEqual(["action", "entry", "expiry", "levelBasis", "levelBasisConflict", "levelBasisInferred", "optionType", "stopLoss", "strike", "targets", "underlying"]);
  });
  it("safeReasons caps the list and drops malformed entries", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ code: `c.${i}`, severity: "info" }));
    expect(safeReasons(many)).toHaveLength(16);
    expect(safeReasons("x")).toEqual([]);
    expect(safeReasons([{ code: "Has Space" }, 5, null])).toEqual([]);
  });
});
