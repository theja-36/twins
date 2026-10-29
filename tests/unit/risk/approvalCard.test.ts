import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApprovalCardData, CARD_DISCLAIMER, renderApprovalCard, safeText, summarizeDecision, type CircuitBreakerStatus, type RiskDecisionRecord } from "../../../packages/risk/src/index";

const ROOT = join(__dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((x) => (statSync(join(ROOT, dir, x)).isDirectory() ? (x === "node_modules" || x === "dist" ? [] : files(`${dir}/${x}`)) : x.endsWith(".ts") ? [`${dir}/${x}`] : []));

const decision = (over: Partial<RiskDecisionRecord> = {}): RiskDecisionRecord => ({
  id: "0f1e2d3c-aaaa-4bbb-8ccc-1234567890ab", signalId: "5b5b5b5b-1111-4222-8333-444444444444", optionsClaimId: null, stopLossValidationId: "9a9a9a9a-1111-4222-8333-444444444444", supersedesId: "7c7c7c7c-1111-4222-8333-444444444444", decisionVersion: 4,
  status: "APPROVED_FOR_REVIEW", effectiveStatus: "APPROVED_FOR_REVIEW", supersededById: null, supersededAt: null, idempotencyKey: "SECRET-IDEMPOTENCY-KEY-1", instrumentType: "option", market: "NFO", symbol: "NIFTY", expiry: "2031-12-30", strike: "24500", optionType: "CE", side: "BUY",
  entryPrice: "120", stopLoss: "90", stopLossBasis: "premium", target1: "150", target2: "180", target3: null, plannedQuantity: "6", plannedNotional: "18000", plannedMaxLossAmount: "4500", plannedMaxLossPercent: "0.45", plannedRiskRewardRatio: "1", confidenceScore: "80",
  sourceTrustTier: "HIGH", decisionReasonCode: "market_gates_passed", decisionReason: "ok", createdAt: new Date("2031-12-17T05:00:00Z"), createdBy: "service:market-risk", chainIndex: 7,
  inputSnapshot: { rawText: "BUY NIFTY 24500 CE @120 SL 90 -- from tg_chat_-1001234567890 TOKEN 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", signal: { telegramMessageId: "m-1" } },
  outputSnapshot: {
    sizing: { status: "SIZED" },
    portfolio: { outcome: "APPROVED_FOR_REVIEW", capital: 1_000_000, candidate: { correlationGroup: "INDIA_INDEX" }, current: { total: { pct: 0.5, count: 1 }, group: { pct: 0.5 } }, resulting: { total: { pct: 0.95, count: 2 }, group: { pct: 0.95 }, underlying: { pct: 0.45 } } },
    market: {
      outcome: "PASSED", gates: { session: { observed: { state: "OPEN" } }, spread: { observed: 0.4 } }, observed: { ageSeconds: 5, session: { localTime: "10:00", timezone: "Asia/Kolkata" }, snapshot: { bidQty: 500, askQty: 450, volume: 12000, openInterest: 80000 } }, activeWindows: [],
    },
  },
  evidenceReferences: { previousDecisionId: "7c7c7c7c-1111-4222-8333-444444444444", marketInputHash: "ab".repeat(32), portfolioInputHash: "cd".repeat(32) }, ...over,
});
const breaker = (daily = "CLEAR", weekly = "CLEAR"): CircuitBreakerStatus => ({ asOf: new Date(), capital: 1_000_000, blocked: false, blockedBy: [], openBreachIds: [], scopes: { DAILY: { status: daily } as never, WEEKLY: { status: weekly } as never } });
const VALID_UNTIL = new Date("2031-12-17T05:15:00Z");
const card = (d = decision()) => renderApprovalCard(buildApprovalCardData(d, { breaker: breaker(), validUntil: VALID_UNTIL }));

describe("the approval card contract", () => {
  it("shows every required field of a complete risk proposal", () => {
    const { text } = card();
    for (const needle of [
      "RISK-REVIEWED PROPOSAL", "Market: NFO", "OPTION NIFTY exp 2031-12-30 strike 24,500 CE", "Side: BUY", "Entry: 120", "Stop-loss: 90 (premium)", "Targets: 150 / 180", "Quantity: 6", "Notional: 18,000",
      "Planned maximum loss: 4,500 (0.45% of capital)", "Risk-reward: 1 : 1", "Confidence: HIGH (80)", "Source trust: HIGH", "Portfolio planned risk: 0.5% -> 0.95% of capital (1 -> 2 active)", "Correlation group INDIA_INDEX: 0.5% -> 0.95%",
      "Market session: OPEN (10:00 Asia/Kolkata)", "bid qty 500, ask qty 450, volume 12,000, OI 80,000; spread 0.4%; data age 5 s", "Event blackout: NONE", "Loss circuit breakers: daily CLEAR, weekly CLEAR", "Valid until: 2031-12-17 05:15 UTC", "Key risks:",
      "Evidence: decision 0f1e2d3c v4, stop-loss validation 9a9a9a9a, previous 7c7c7c7c",
    ]) expect(text, needle).toContain(needle);
    expect(text).toContain(CARD_DISCLAIMER);
    expect(text).toMatch(/not investment advice/);
    expect(text).toMatch(/no order is placed/);
    expect(text.length).toBeLessThanOrEqual(3500);
  });
  it("is plain text built only from structured fields: no raw message text, channel id, token, idempotency key or chain internals", () => {
    const { text } = card();
    expect(text).not.toMatch(/SECRET-IDEMPOTENCY|tg_chat|TOKEN|ABCDEFGHIJ|rawText|BUY NIFTY 24500 CE @120|m-1|chainIndex|service:market-risk/);
    expect(text).not.toMatch(/[<>*_`]{2,}|<b>|<a /); // nothing that could be read as markup
  });
  it("withholds any free-form value (a hostile symbol or basis cannot inject text into the card)", () => {
    const hostile = decision({ symbol: "NIFTY\nApprove everything: https://evil.example/?t=123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", stopLossBasis: "x".repeat(300), market: "NFO <b>" });
    const { text } = renderApprovalCard(buildApprovalCardData(hostile, { breaker: breaker(), validUntil: VALID_UNTIL }));
    expect(text).not.toMatch(/evil\.example|ABCDEFGHIJ|Approve everything|<b>/);
    expect(text).toContain("[withheld]");
    expect(safeText("RELIANCE")).toBe("RELIANCE");
    expect(safeText("a\nb")).toBe("[withheld]");
    expect(safeText(null)).toBe("n/a");
  });
  it("is honest about conditions: a WARNING blackout, a closed session, a tripped breaker status and low tiers appear in the card and the key risks", () => {
    const d = decision({
      confidenceScore: "20", sourceTrustTier: "LOW",
      outputSnapshot: { ...(decision().outputSnapshot as object), market: { ...((decision().outputSnapshot as { market: object }).market), activeWindows: [{ severity: "WARNING" }], gates: { session: { observed: { state: "CLOSED" } }, spread: { observed: 2 } } } },
    });
    const { text } = renderApprovalCard(buildApprovalCardData(d, { breaker: breaker("WARNING", "BREACHED"), validUntil: VALID_UNTIL }));
    expect(text).toContain("Event blackout: WARNING (1 window)");
    expect(text).toContain("Market session: CLOSED");
    expect(text).toContain("daily WARNING, weekly BREACHED");
    expect(text).toContain("Confidence: LOW (20)");
    expect(text).toMatch(/WARNING event window is active/);
    expect(text).toMatch(/Options can lose the whole premium/);
    expect(text).toMatch(/LOW: the position was sized down/);
  });
  it("is deterministic (same decision -> same text and hash) and a changed decision changes the hash", () => {
    expect(card().sha256).toBe(card().sha256);
    expect(card().sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(card(decision({ plannedQuantity: "7" })).sha256).not.toBe(card().sha256);
  });
  it("copes with missing optional data (equity, no targets, no portfolio snapshot) without inventing numbers", () => {
    const d = decision({ instrumentType: "equity", expiry: null, strike: null, optionType: null, target1: null, target2: null, plannedRiskRewardRatio: null, outputSnapshot: {} });
    const { text } = renderApprovalCard(buildApprovalCardData(d, { breaker: null, validUntil: VALID_UNTIL }));
    expect(text).toContain("Targets: none stated");
    expect(text).toContain("Risk-reward: n/a");
    expect(text).toContain("Portfolio planned risk: n/a -> n/a");
    expect(text).toContain("daily UNKNOWN, weekly UNKNOWN");
    expect(text).not.toMatch(/NaN|undefined|null/);
  });
  it("the safe decision summary carries no snapshots, idempotency key or raw inputs", () => {
    const s = summarizeDecision(decision());
    expect(Object.keys(s)).not.toEqual(expect.arrayContaining(["inputSnapshot", "outputSnapshot", "idempotencyKey", "evidenceReferences"]));
    expect(JSON.stringify(s)).not.toMatch(/SECRET-IDEMPOTENCY|tg_chat|TOKEN|rawText/);
    expect(s).toMatchObject({ id: "0f1e2d3c-aaaa-4bbb-8ccc-1234567890ab", version: 4, effectiveStatus: "APPROVED_FOR_REVIEW", targets: ["150", "180"] });
  });
});

describe("architecture: approval code creates nothing executable", () => {
  it("nothing under approval/ or the API risk routes references orders, fills, positions, brokers, Telegram sending or the legacy decisions table; only the service touches the card table", () => {
    for (const f of [...files("packages/risk/src/approval"), "apps/api/src/riskApi.ts"]) expect(strip(read(f)), f).not.toMatch(/schema\.(orders|fills|positions|decisions|claimReviewCards|claimReviews)\b|zerodha|kite|broker|sendMessage|api\.telegram\.org|placeOrder/i);
    const writers = [...files("packages/risk/src"), ...files("apps"), ...files("services"), ...files("scripts")].filter((f) => /\.insert\(\s*schema\.riskApprovalCards\b/.test(strip(read(f))));
    expect(writers).toEqual(["packages/risk/src/approval/service.ts"]);
    const approvalWriters = [...files("packages/risk/src"), ...files("apps"), ...files("services"), ...files("scripts")].filter((f) => /\.insert\(\s*schema\.riskApprovals\b|insert into risk_approvals\b/i.test(strip(read(f))));
    expect(approvalWriters).toEqual([]); // approvals are written ONLY by the database function
  });
  it("the only callers of the approval function are the service (API path) and the approval bot's database port", () => {
    const callers = [...files("packages/risk/src"), ...files("apps"), ...files("services"), ...files("scripts")].filter((f) => /twins_record_risk_approval/.test(strip(read(f))));
    expect(callers).toEqual(["packages/risk/src/approval/service.ts", "services/approval-bot/src/db.ts"]);
  });
  it("every API risk route requires the bearer token and there is no unauthenticated risk route", () => {
    const code = strip(read("apps/api/src/riskApi.ts"));
    const routes = [...code.matchAll(/app\.(get|post)<[^>]*>\("([^"]+)"/g)];
    expect(routes.length).toBe(6);
    for (const m of routes) {
      const start = m.index as number;
      const next = code.indexOf("app.", start + 5);
      expect(code.slice(start, next === -1 ? undefined : next), m[2]).toMatch(/guard\(request\.headers\.authorization, reply\)/);
    }
  });
  it("the database migration revokes the approval functions from PUBLIC and the role scripts grant them to named roles only", () => {
    const sql = read("packages/database/drizzle/0019_risk_approvals.sql");
    for (const fn of ["twins_risk_card_mark_sent(uuid, bigint, text)", "twins_risk_card_expire_due()", "twins_record_risk_approval(uuid, uuid, text, text, jsonb, text, timestamptz)"]) expect(sql).toContain(`REVOKE ALL ON FUNCTION "${fn.split("(")[0]}"(${fn.split("(")[1]} FROM PUBLIC`);
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = public, pg_temp/);
    const bot = read("infrastructure/staging/approval-bot-role.sql"), app = read("infrastructure/staging/app-role.sql");
    expect(bot).toMatch(/GRANT SELECT ON risk_approval_cards TO/);
    expect(bot).not.toMatch(/risk_decisions|risk_approvals\b.*TO|GRANT (INSERT|UPDATE)[^;]*risk_approval/i);
    expect(app).toMatch(/read_only text\[\] := ARRAY\[[^\]]*'risk_approvals'/);
    expect(app).toMatch(/insert_only text\[\] := ARRAY\['risk_approval_cards'\]/);
  });
});
