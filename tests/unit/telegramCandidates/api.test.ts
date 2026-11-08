import Fastify from "fastify";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerTelegramIntelRoutes, type TelegramIntelOps } from "../../../apps/api/src/telegramIntelApi";

const PW = "correct horse battery staple", NOW = new Date("2031-01-06T05:00:00Z"), ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claimView = { claimId: ID(7), resultKind: "claim", parserVersion: "p", claim: { action: "buy", underlying: "NIFTY", strike: 24500, optionType: "CE", entry: { type: "above", price: 118 }, stopLoss: 96, targets: [140], levelBasis: "premium", expiry: { status: "day_month", day: 12, month: 11, raw: "12 NOVEMBER SECRETRAW" }, raw: "RAW MESSAGE FRAGMENT" }, messageTimestamp: NOW, receivedAt: NOW, sourceId: ID(1), captureMethod: "bot_webhook", classification: { signalType: "OPTIONS_BUY", horizon: "INTRADAY", setup: "BREAKOUT", confidence: 0.8, classifierVersion: "v1", structureValid: true }, candidacy: { policyVersion: "telegram-candidacy-v1", outcome: "CREATED", reasons: [], candidateId: ID(9), evaluatedAt: NOW }, candidate: { id: ID(9), state: "NEW", version: 1, expiresAt: NOW, missingInformation: ["contractVerification"], validationStatus: "UNVERIFIED" } };
const seen: string[] = [];
const ops: TelegramIntelOps = {
  async channels(_n, o) { seen.push(`channels:${o.id ?? "*"}`); return o.id && o.id !== ID(1) ? [] : [{ id: ID(1), identifier: "-1001234567892544", name: "Chan", messages: 10, messages24h: 4, claims: { claim: 3, ambiguous: 1, unsupported: 0 }, candidates: { NEW: 1 }, firstMessageAt: new Date(NOW.getTime() - 86_400_000), lastMessageAt: new Date(NOW.getTime() - 60_000), delayedShare24h: 0, medianCaptureDelaySeconds24h: 2 }]; },
  async claims(o) { seen.push(`claims:${o.kind ?? "*"}`); return [claimView as never]; }, async claim(id) { return id === ID(7) ? (claimView as never) : null; },
  async candidates(o) { seen.push(`candidates:${o.states?.[0] ?? "*"}`); return []; }, async pipeline() { return { claimsTotal: 5, claimsParsed: 3, byOutcome: { CREATED: 1 }, candidates: { NEW: 1 }, oldestPendingMinutes: null }; },
};
async function build() {
  const store = memoryAuthStore(), auth = new AuthService({ store, audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerTelegramIntelRoutes(app, { auth, ops, now: () => NOW });
  await auth.register({ email: "t@example.com", password: PW }); const token = (await auth.login({ email: "t@example.com", password: PW })).token;
  await auth.bootstrapAdmin({ email: "a@example.com", password: PW }); const admin = (await auth.login({ email: "a@example.com", password: PW })).token;
  const call = (url: string, t?: string) => app.inject({ method: "GET", url, headers: t ? { authorization: `Bearer ${t}` } : {} });
  return { call, token, admin, app };
}
const URLS = ["/intelligence/channels", `/intelligence/channels/${ID(1)}`, "/intelligence/claims", `/intelligence/claims/${ID(7)}`, "/intelligence/candidates", "/intelligence/pipeline"];

describe("Telegram intelligence API", () => {
  it("requires a session on every route; the service key and garbage are refused", async () => {
    const b = await build(); seen.length = 0;
    for (const u of URLS) for (const t of [undefined, "", "test-api-key-default", "tws_short"]) expect((await b.call(u, t)).statusCode, `${u} ${t}`).toBe(401);
    expect(seen).toEqual([]);
  });
  it("serves shared intelligence to a trader and an admin (shared permissions), read-only", async () => {
    const b = await build();
    for (const t of [b.token, b.admin]) for (const u of URLS) expect((await b.call(u, t)).statusCode, u).toBe(200);
    expect((await b.app.inject({ method: "POST", url: "/intelligence/claims", headers: { authorization: `Bearer ${b.token}` } })).statusCode).toBe(404);
  });
  it("masks channel identifiers, adds health, and never claims a reliability", async () => {
    const b = await build(), j = (await b.call("/intelligence/channels", b.token)).json();
    expect(j.channels[0]).toMatchObject({ channel: "***2544", health: { status: "ACTIVE", capture: "TIMELY", reliability: "NOT_AVAILABLE" } });
    expect((await b.call("/intelligence/channels", b.token)).body).not.toContain("1001234567892544");
  });
  it("exposes parsed fields only: no raw text, no raw fragments", async () => {
    const b = await build(), r = await b.call(`/intelligence/claims/${ID(7)}`, b.token);
    expect(r.json().claim.claim).toMatchObject({ action: "buy", underlying: "NIFTY", strike: 24500 });
    for (const leak of ["RAW MESSAGE FRAGMENT", "SECRETRAW"]) expect(r.body).not.toContain(leak);
    expect(r.json().claim).toMatchObject({ candidacy: { outcome: "CREATED" }, candidate: { state: "NEW", validationStatus: "UNVERIFIED" }, classification: { signalType: "OPTIONS_BUY" } });
  });
  it("validates its inputs and reports unknown ids as 404", async () => {
    const b = await build();
    for (const u of ["/intelligence/claims?kind=nope", "/intelligence/claims?limit=0", "/intelligence/claims?bogus=1", "/intelligence/candidates?state=NOPE", "/intelligence/channels/not-a-uuid", "/intelligence/claims?channelId=x"]) expect((await b.call(u, b.token)).statusCode, u).toBe(422);
    expect((await b.call(`/intelligence/channels/${ID(2)}`, b.token)).statusCode).toBe(404); expect((await b.call(`/intelligence/claims/${ID(8)}`, b.token)).statusCode).toBe(404);
  });
});

describe("static guarantees", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  it("the candidate pipeline cannot reach risk, decision or execution code, and the independent engine cannot reach Telegram", () => {
    for (const f of ["packages/signals/src/telegramCandidate.ts", "packages/signals/src/telegramCandidateCycle.ts", "packages/database/src/stores/telegramCandidateStore.ts"]) for (const bad of ["@twins/decision", "@twins/execution", "@twins/planning", "@twins/risk", "@twins/opportunity", "user_decisions", "paper_orders"]) expect(readFileSync(f, "utf8"), `${f} ${bad}`).not.toContain(bad);
    for (const f of walk("packages/opportunity/src")) expect(readFileSync(f, "utf8"), f).not.toMatch(/telegram_messages|options_claims|telegramCandidate|OptionsClaim|@twins\/ingestion|@twins\/database\/.*telegram/i);
  });
  it("no pipeline file writes a decision, approval, order or capital table", () => { const sql = ["packages/database/src/stores/telegramCandidateStore.ts", "packages/signals/src/telegramCandidateCycle.ts"].map((f) => readFileSync(f, "utf8")).join("\n"); expect(sql).not.toMatch(/insert into (user_decisions|decision_approvals|paper_|execution_requests|user_capital|user_risk)/i); });
  it("the Telegram routes are read-only and never read raw text", () => { const c = readFileSync("apps/api/src/telegramIntelApi.ts", "utf8"); expect(c).not.toMatch(/app\.(post|put|patch|delete)/); expect(c).not.toMatch(/raw_text|rawText|rawPayload/); expect(c).toContain("safeClaimView"); });
  it("the store never persists raw message text", () => { const c = readFileSync("packages/database/src/stores/telegramCandidateStore.ts", "utf8"); expect(c).not.toMatch(/insert[^;]*raw_text/i); expect(c).not.toMatch(/telegramClaimCandidacy\)\.values\([^)]*rawText/); expect(c).toContain("never stored by the pipeline"); });
  it("migration 0042: candidacy is append-only, a Telegram candidate needs a parsed claim, the thesis never changes", () => {
    const sql = readFileSync("packages/database/drizzle/0042_telegram_candidates.sql", "utf8");
    expect(sql).toContain('"telegram_claim_candidacy_no_update_delete"'); expect(sql).toContain("twins_telegram_candidate_origin_guard"); expect(sql).toMatch(/c\.result_kind = 'claim'/); expect(sql).toContain("twins_candidate_thesis_guard"); expect(sql).toContain("opportunity_candidates_telegram_provenance_check");
  });
});
