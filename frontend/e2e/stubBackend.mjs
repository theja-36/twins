// A stub of the TWINS API for the Playwright run: synthetic users and data only, in memory, no network beyond localhost.
// It mirrors the VERIFIED backend behaviour the frontend depends on (docs/frontend/contracts-verification.md):
//  - login: 401 "invalid credentials"; after 5 failures per email: 403 "too many attempts" even for the right password
//  - /auth/me and /auth/logout need the Bearer session token; an ADMIN has no private permission, so every private route answers 404
//  - error body { error, message, reasons }
// It also records every request it receives (GET /__log) so tests can prove the BFF never forwards a cookie, the service key or a browser header.
import http from "node:http";
import { randomBytes } from "node:crypto";

const USERS = {
  "trader@example.test": { password: "trader-pass-123", user: { id: "11111111-1111-4111-8111-111111111111", email: "trader@example.test", displayName: "Alex Rao", role: "TRADER", isActive: true } },
  "admin@example.test": { password: "admin-pass-123", user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test", displayName: "Priya Nair", role: "ADMIN", isActive: true } },
};
const ACCOUNTS = [{ id: "33333333-3333-4333-8333-333333333333", name: "Paper account", tradingMode: "paper", baseCurrency: "INR", isActive: true }];
// ── Stage 09.3A synthetic data (shapes mirror the verified backend views; asserted by tests/unit/api-contracts/opportunityParity.test.ts) ──
const T0 = "2031-01-06T04:30:00.000Z", UID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CANDS = Array.from({ length: 30 }, (_, i) => { const n = i + 1, tg = n % 2 === 1; return {
  id: UID(n), source: tg ? "TELEGRAM" : "INDEPENDENT", state: n === 3 ? "IN_RESEARCH" : "READY_FOR_DECISION", stateReason: null, supersededBy: null, underlying: tg ? `TELCO${n}` : `INDCO${n}`, exchange: "NSE", setup: tg ? null : "BREAKOUT_LONG", side: "BUY", entryKind: "above",
  entryLow: 100, entryHigh: 101.5, stopLoss: 95, targets: [110, 120], strike: n === 2 ? 24500 : null, optionType: n === 2 ? "CE" : null, expiry: n === 2 ? "2031-01-30" : null, rankScore: tg ? null : 7.5, dataSource: "FIXTURE", createdAt: T0, expiresAt: "2031-01-07T04:30:00.000Z", lastValidatedAt: null, researchAttempts: 1 }; });
const EVIDENCE = [{ kind: "setup", setupClass: "BREAKOUT_LONG" }, { kind: "reward_risk_screen", passed: true }, { kind: "provenance", configSha256: "a".repeat(64) }];
const CHANNELS = [
  { id: UID(70), channel: "***7890", name: "Desk alpha", messages: 40, messages24h: 6, claims: { claim: 5, ambiguous: 1, unsupported: 2 }, candidates: { NEW: 1 }, firstMessageAt: T0, lastMessageAt: T0, health: { status: "ACTIVE", lastMessageAgeSeconds: 90, messages24h: 6, capture: "TIMELY", reasons: [], reliability: "NOT_AVAILABLE" } },
  { id: UID(71), channel: "***1111", name: null, messages: 3, messages24h: 0, claims: { claim: 0, ambiguous: 0, unsupported: 0 }, candidates: {}, firstMessageAt: T0, lastMessageAt: T0, health: { status: "SILENT", lastMessageAgeSeconds: 900000, messages24h: 0, capture: "NO_DATA", reasons: ["NO_MESSAGE_FOR_DAYS"], reliability: "NOT_AVAILABLE" } },
];
const DECISION = { id: UID(500), accountId: "33333333-3333-4333-8333-333333333333", candidateId: UID(1), outcome: "RISK_REVIEWED", workflowState: "PENDING", validFrom: T0, validUntil: "2031-01-07T04:30:00.000Z", createdAt: T0, invalidated: null };
const POSITION = { id: UID(600), accountId: "33333333-3333-4333-8333-333333333333", instrument: "INDCO2", exchange: "NSE", side: "BUY", quantity: "50", avgEntryPrice: "100.50", stopLoss: "95.00", realizedPnl: "0.00", status: "OPEN", openedAt: T0 };
const sessions = new Map(); const failures = new Map(); const log = [];
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(body)); };
const err = (res, status, error, message) => send(res, status, { error, message, reasons: [] });
const token = () => `tws_${randomBytes(32).toString("base64url")}`;
const PRIVATE = [/^\/accounts$/, /^\/approvals$/, /^\/decisions/, /^\/portfolio$/, /^\/capital\//, /^\/risk\//, /^\/execution\//, /^\/analytics\//];
const SHARED = [/^\/opportunities\//, /^\/research\//, /^\/intelligence\//];

http.createServer((req, res) => {
  const url = new URL(req.url, "http://stub"); let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    log.push({ method: req.method, path: url.pathname, headers: Object.keys(req.headers).sort(), hasCookie: "cookie" in req.headers, hasApiKey: "x-api-key" in req.headers });
    if (url.pathname === "/__log") return send(res, 200, { log });
    if (url.pathname === "/__reset") { log.length = 0; failures.clear(); return send(res, 200, {}); }
    if (url.pathname === "/__expire") { sessions.clear(); return send(res, 200, {}); }
    if (url.pathname === "/auth/login" && req.method === "POST") {
      let b; try { b = JSON.parse(raw); } catch { return err(res, 422, "VALIDATION", "a JSON object is required"); }
      const email = String(b.email ?? "").toLowerCase(), u = USERS[email], n = failures.get(email) ?? 0;
      if (n >= 5) return err(res, 403, "FORBIDDEN", "too many attempts, try again later");
      if (!u || u.password !== b.password) { failures.set(email, n + 1); return err(res, 401, "UNAUTHENTICATED", "invalid credentials"); }
      const t = token(); sessions.set(t, u.user); return send(res, 200, { token: t, expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(), user: u.user });
    }
    const bearer = /^Bearer (tws_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? ""), user = bearer ? sessions.get(bearer[1]) : undefined;
    if (url.pathname === "/auth/logout" && req.method === "POST") { if (bearer) sessions.delete(bearer[1]); return send(res, 204); }
    if (!user) return err(res, 401, "UNAUTHENTICATED", "authentication required");
    if (url.pathname === "/auth/me") return send(res, 200, { user });
    if (PRIVATE.some((p) => p.test(url.pathname))) {
      if (user.role !== "TRADER") return err(res, 404, "NOT_FOUND", "not found"); // an ADMIN holds no private permission
      if (url.pathname === "/accounts") return send(res, 200, { accounts: ACCOUNTS });
      if (url.pathname === "/approvals") return send(res, 200, { pending: [{ ...DECISION, expired: false, action: { available: true } }], history: [] });
      if (url.pathname === "/decisions") return send(res, 200, { decisions: [DECISION] });
      if (url.pathname === "/execution/positions") return send(res, 200, { positions: [POSITION] });
      return send(res, 200, {});
    }
    if (url.pathname === "/opportunities/candidates") {
      const src = url.searchParams.get("source"), st = url.searchParams.get("state"), lim = Number(url.searchParams.get("limit") ?? 50), off = Number(url.searchParams.get("offset") ?? 0);
      const rows = CANDS.filter((c) => (!src || c.source === src) && (!st || c.state === st)).slice(off, off + lim);
      return send(res, 200, { state: rows.length ? "OK" : "EMPTY", candidates: rows, note: "Candidates are proposals for research. None carries an order, an approval or a size." });
    }
    const cm = /^\/opportunities\/candidates\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (cm) {
      if (cm[1] === UID(98)) return err(res, 500, "INTERNAL", "internal error");
      const c = CANDS.find((x) => x.id === cm[1]); if (!c) return err(res, 404, "NOT_FOUND", "not found");
      return send(res, 200, { candidate: c, lifecycle: [{ from: null, to: "NEW", reason: null, at: T0 }], evidence: EVIDENCE, research: { status: "READY", packageId: UID(9), packageVersion: 1, assessment: "RESEARCH_CAUTION" } });
    }
    if (url.pathname === "/opportunities/scans") return send(res, 200, { state: "OK", scans: [{ id: UID(50), kind: "TECHNICAL_UNIVERSE", slot: "slot", status: "COMPLETED", dataSource: "FIXTURE", detectorVersion: "v1", universeSize: 30, candidates: 15, errorKind: null, skipped: [{ underlying: "ZZZ", reason: "NO_DATA" }], parameters: {}, startedAt: T0, completedAt: T0 }] });
    if (/^\/research\/candidates\/[0-9a-f-]{36}\/package$/.test(url.pathname)) return send(res, 200, { packageId: UID(9), candidateId: UID(1), version: 1, assessment: "RESEARCH_CAUTION", haltReason: null, status: "READY", researchAttempts: 1, createdAt: T0, package: { grantsApproval: false, reports: [] } });
    if (url.pathname === "/intelligence/channels") return send(res, 200, { channels: CHANNELS, reliabilityNote: "Channel reliability needs resolved real outcomes and is not available yet." });
    if (SHARED.some((p) => p.test(url.pathname))) return send(res, 200, { items: [] });
    return err(res, 404, "NOT_FOUND", "not found");
  });
}).listen(Number(process.env.STUB_PORT ?? 4010), "127.0.0.1", () => console.log("stub backend listening"));
