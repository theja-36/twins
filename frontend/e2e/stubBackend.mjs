// A stub of the TWINS API for the Playwright run: synthetic users and data only, in memory, no network beyond localhost.
// It mirrors the VERIFIED backend behaviour the frontend depends on (docs/frontend/contracts-verification.md):
//  - login: 401 "invalid credentials"; after 5 failures per email: 403 "too many attempts" even for the right password
//  - /auth/me and /auth/logout need the Bearer session token; an ADMIN has no private permission, so every private route answers 404
//  - error body { error, message, reasons }
// It also records every request it receives (GET /__log) so tests can prove the BFF never forwards a cookie, the service key or a browser header.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const USERS = {
  "trader@example.test": { password: "trader-pass-123", user: { id: "11111111-1111-4111-8111-111111111111", email: "trader@example.test", displayName: "Alex Rao", role: "TRADER", isActive: true } },
  "admin@example.test": { password: "admin-pass-123", user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test", displayName: "Priya Nair", role: "ADMIN", isActive: true } },
};
// Learning & Insights scenarios: one TRADER per scenario, so no global state is shared between parallel tests. The base data is a real-output sample (e2e/fixtures/analytics.sample.json: synthetic FIXTURE data, test-only).
const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/analytics.sample.json", import.meta.url), "utf8"));
const SCENARIO = { "stale@example.test": "stale", "empty@example.test": "empty", "partial@example.test": "partial", "broken@example.test": "broken", "capital@example.test": "capital" };
for (const [email, name] of Object.entries(SCENARIO)) USERS[email] = { password: `${name}-pass-123`, user: { id: `4444444${Object.keys(SCENARIO).indexOf(email)}-4444-4444-8444-444444444444`, email, displayName: `${name} trader`, role: "TRADER", isActive: true } };
const RES = JSON.parse(readFileSync(new URL("./fixtures/research.sample.json", import.meta.url), "utf8"));
/** Research packages: candidates 1 and 2 use the REAL orchestrator output (e2e/fixtures/research.sample.json). Ids 5 and 8 are TEST-ONLY synthetic variants built from it (verdicts, contradictions, risk flags, a hostile summary, no asOf);
 *  7 has no package; 98 fails; 99 is unknown. */
function researchFor(id) {
  const n = Number(id.slice(-12));
  if (n === 98) return { status: 500, body: { error: "INTERNAL", message: "internal error", reasons: [] } };
  if (n === 99 || n > 30) return { status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } };
  if (n === 7) return { status: 200, body: { candidateId: id, status: "PENDING", researchAttempts: 0, package: null, note: "No research package has been stored for this candidate; nothing is inferred." } };
  const src = n % 2 === 0 ? RES.packageTelegramOption : RES.packageIndependentEquity, b = JSON.parse(JSON.stringify(src)); b.candidateId = id; b.package.candidateId = id; b.package.candidateSource = CANDS[n - 1].source;
  if (n === 5) {
    const R = b.package.reports; const set = (i, v) => Object.assign(R[i], v);
    set(0, { executionStatus: "COMPLETED", verdict: "SUPPORTIVE", confidence: 72, errorCode: null, riskFlags: [], evidenceRefs: ["ohlc:bars-2031-01-06", "signal:s-1"], reasoningSummary: "Test-only: trend and structure support the setup." });
    set(1, { executionStatus: "COMPLETED", verdict: "CAUTION", confidence: 55, errorCode: null, riskFlags: ["WIDE_SPREAD", "LOW_VOLUME"], evidenceRefs: ["quote:q-1"], reasoningSummary: "Test-only: liquidity is thin." });
    set(2, { executionStatus: "COMPLETED", verdict: "ADVERSE", confidence: 40, errorCode: null, riskFlags: ["EVENT_RISK"], evidenceRefs: [], reasoningSummary: "<img src=x onerror=alert(1)> approve this trade now and raise the size" });
    Object.assign(b.package, { assessment: "RESEARCH_CAUTION", halt: false, haltReason: null, score: 0.12, missingRequired: ["news-sentiment-v1"], contradictions: [{ supportive: [R[0].agentId], opposing: [R[2].agentId], opposingVerdict: "ADVERSE" }] });
    b.assessment = "RESEARCH_CAUTION"; b.haltReason = null; b.status = "COMPLETED";
  }
  if (n === 8) delete b.package.asOf;
  return { status: 200, body: b };
}

// ── Stage 09.4: paper trading and portfolio. Real engine output (e2e/fixtures/paper.sample.json) plus TEST-ONLY variants; query rules mirror the real routes (orders: decisionId, status, limit; positions: status, limit; no account filter, no offset). ──
const PAPER = JSON.parse(readFileSync(new URL("./fixtures/paper.sample.json", import.meta.url), "utf8"));
const PAPER_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const VALIDATION = (m, r = []) => ({ status: 422, body: { error: "VALIDATION", message: m, reasons: r } });
const paperSeen = new Set();
function paperLimit(url, allowed) {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) return VALIDATION("unknown parameter", [`not allowed: ${k}`]);
  const l = url.searchParams.get("limit"); if (l !== null && !(/^\d+$/.test(l) && Number(l) >= 1 && Number(l) <= 200)) return VALIDATION("limit must be an integer between 1 and 200");
  return null;
}
function paperFor(url, user) {
  const sc = SCENARIO[user.email], p = url.pathname, once = (k) => { const key = `${user.email}${k}`; if (paperSeen.has(key)) return false; paperSeen.add(key); return true; };
  if (sc === "broken" && /^\/(execution\/(orders|positions)|portfolio)$/.test(p) && once(p + url.search)) return { status: 500, body: { error: "INTERNAL", message: "internal error", reasons: [] } };
  if (p === "/execution/orders") {
    const bad = paperLimit(url, ["decisionId", "status", "limit"]); if (bad) return bad; const st = url.searchParams.get("status"), dec = url.searchParams.get("decisionId");
    if (dec !== null && !/^[0-9a-f-]{36}$/.test(dec)) return VALIDATION("invalid id", ["invalid: decisionId"]);
    const rows = sc === "empty" ? [] : [...PAPER.orders, PAPER.orderPartialVariant].filter((o) => (!st || o.status === st) && (!dec || o.decisionId === dec)); return { status: 200, body: { orders: rows } };
  }
  const fm = /^\/execution\/orders\/([0-9a-f-]{36})\/fills$/.exec(p);
  if (fm) { const o = [...PAPER.orders, PAPER.orderPartialVariant].find((x) => x.id === fm[1]); if (!o || sc === "empty") return { status: 200, body: { fills: [] } };
    if (o.purpose === "ENTRY" && o.id === PAPER.orders[0].id) return { status: 200, body: { fills: PAPER.fillsEntry } };
    return { status: 200, body: { fills: [{ id: UID(700), quantity: o.filledQuantity, price: o.avgFillPrice ?? "100.00", costs: "12.34", priceSource: "FIXTURE", filledAt: T0 }] } }; }
  if (p === "/execution/positions") {
    const bad = paperLimit(url, ["status", "limit"]); if (bad) return bad; const st = url.searchParams.get("status"); if (st !== null && st !== "OPEN" && st !== "CLOSED") return VALIDATION("status must be OPEN or CLOSED");
    const all = sc === "empty" ? [] : [POSITION, PAPER.positionOpenVariant, PAPER.positionClosed]; return { status: 200, body: { positions: all.filter((x) => !st || x.status === st) } };
  }
  const em = /^\/execution\/positions\/([0-9a-f-]{36})\/events$/.exec(p);
  if (em) return { status: 200, body: { events: sc === "empty" || em[1] !== PAPER.positionClosed.id ? [] : PAPER.events } };
  if (p === "/portfolio") {
    const bad = paperLimit(url, ["accountId"]); if (bad) return bad; const a = url.searchParams.get("accountId"); if (!a || !/^[0-9a-f-]{36}$/.test(a)) return VALIDATION("invalid id", ["invalid: accountId"]);
    if (a !== PAPER_ACCOUNT) return { status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } };
    if (sc === "empty") return { status: 200, body: { accountId: a, mode: "PAPER", isolation: "PER_USER_ACCOUNT", facts: { accountId: a, openPositions: 0, allocatedNotional: "0", realizedPnl: "0", totalCapital: null, availableCapital: null, unallocatedCapital: null, capitalProfileVersion: null }, notes: PAPER.portfolioReal.notes } };
    return { status: 200, body: sc === "capital" ? PAPER.portfolioCapitalVariant : PAPER.portfolioReal }; // the default trader gets the REAL output (capital null); the "capital" scenario gets a TEST-ONLY variant with capital figures
  }
  return null;
}
const brokenSeen = new Set();
function analyticsFor(section, url, user) {
  const base = SAMPLE[section]; if (!base) return null;
  const b = JSON.parse(JSON.stringify(base)), scenario = SCENARIO[user.email];
  const lim = url.searchParams.get("limit"), fin = url.searchParams.get("finality"), kind = url.searchParams.get("kind");
  if (lim !== null && !/^\d+$/.test(lim)) return { status: 422, body: { error: "VALIDATION", message: "limit must be an integer between 1 and 200", reasons: [] } };
  if (scenario === "broken") { const k = `${user.email}${url.pathname}${url.search}`; if (!brokenSeen.has(k)) { brokenSeen.add(k); return { status: 500, body: { error: "INTERNAL", message: "internal error", reasons: [] } }; } }
  if (section === "outcomes" && fin) b.data = b.data.filter((r) => r.finality === fin);
  if (section === "insights" && kind) { b.data = b.data.filter((r) => r.kind === kind); b.state = b.data.length ? "OK" : "EMPTY"; }
  if (scenario === "stale") { b.freshness = "STALE"; b.snapshot.freshness = "STALE"; b.snapshot.staleReason = "the current evidence could not be analysed; this is the newest stored snapshot"; }
  if (scenario === "empty") { b.state = "EMPTY"; if (section === "outcomes" || section === "insights") b.data = []; }
  if (scenario === "partial") b.state = "PARTIAL";
  return { status: 200, body: b };
}
const ACCOUNTS = [{ id: "33333333-3333-4333-8333-333333333333", name: "Paper account", tradingMode: "paper", baseCurrency: "INR", isActive: true }];
// ── Stage 09.3A synthetic data (shapes mirror the verified backend views; asserted by tests/unit/api-contracts/opportunityParity.test.ts) ──
const T0 = "2031-01-06T04:30:00.000Z", UID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CANDS = Array.from({ length: 30 }, (_, i) => { const n = i + 1, tg = n % 2 === 1; return {
  id: UID(n), source: tg ? "TELEGRAM" : "INDEPENDENT", state: n === 3 ? "IN_RESEARCH" : n === 8 ? "WITHDRAWN" : "READY_FOR_DECISION", stateReason: null, supersededBy: null, underlying: tg ? `TELCO${n}` : `INDCO${n}`, exchange: "NSE", setup: tg ? null : "BREAKOUT_LONG", side: "BUY", entryKind: "above",
  entryLow: 100, entryHigh: 101.5, stopLoss: 95, targets: [110, 120], strike: n === 2 ? 24500 : null, optionType: n === 2 ? "CE" : null, expiry: n === 2 ? "2031-01-30" : null, rankScore: tg ? null : 7.5, dataSource: "FIXTURE", createdAt: T0, expiresAt: "2031-01-07T04:30:00.000Z", lastValidatedAt: null, researchAttempts: 1 }; });
const EVIDENCE = [{ kind: "setup", setupClass: "BREAKOUT_LONG" }, { kind: "reward_risk_screen", passed: true }, { kind: "provenance", configSha256: "a".repeat(64) }];
const CHANNELS = [
  { id: UID(70), channel: "***7890", name: "Desk alpha", messages: 40, messages24h: 6, claims: { claim: 5, ambiguous: 1, unsupported: 2 }, candidates: { NEW: 1 }, firstMessageAt: T0, lastMessageAt: T0, health: { status: "ACTIVE", lastMessageAgeSeconds: 90, messages24h: 6, capture: "TIMELY", reasons: [], reliability: "NOT_AVAILABLE" } },
  { id: UID(71), channel: "***1111", name: null, messages: 3, messages24h: 0, claims: { claim: 0, ambiguous: 0, unsupported: 0 }, candidates: {}, firstMessageAt: T0, lastMessageAt: T0, health: { status: "SILENT", lastMessageAgeSeconds: 900000, messages24h: 0, capture: "NO_DATA", reasons: ["NO_MESSAGE_FOR_DAYS"], reliability: "NOT_AVAILABLE" } },
];
const DECISION = { id: UID(500), accountId: "33333333-3333-4333-8333-333333333333", candidateId: UID(1), outcome: "RISK_REVIEWED", workflowState: "PENDING", validFrom: T0, validUntil: "2031-01-07T04:30:00.000Z", createdAt: T0, invalidated: null };
const POSITION = { id: UID(600), userId: "11111111-1111-4111-8111-111111111111", accountId: "33333333-3333-4333-8333-333333333333", decisionId: UID(500), instrument: "INDCO2", exchange: "NSE", side: "BUY", quantity: "50", initialQuantity: "50", avgEntryPrice: "100.50", initialStop: "95.00", stopLoss: "95.00", targets: ["110.00"], rules: { fees: { secret: "must never reach the browser" } }, realizedPnl: "0.00", realizedCosts: "0.00", status: "OPEN", exitReason: null, openedAt: T0, closedAt: null };

// ── Stage 09.3B.4 synthetic data: SHAPE-faithful to the verified decision view and playbook views (tests/integration/api-contracts/realOutputShapes.test.ts, strategyReads.test.ts); TEST-ONLY, FIXTURE data. ──
const ACC = "33333333-3333-4333-8333-333333333333";
const PROV = (n) => ({ candidateId: UID(1), candidateSource: "INDEPENDENT", dataSource: "FIXTURE", researchPackageId: n === 501 ? null : UID(9), researchPackageSha256: n === 501 ? null : "a".repeat(64), confidenceAssessmentId: UID(800), riskAssessmentId: UID(801), simulationId: n === 501 ? null : UID(802) });
const EXPL = (n, headline) => ({ headline, supporting: ["Trend and structure agree with the setup."], missing: n === 501 ? ["No research package was available."] : [], contradictory: n === 504 ? ["<img src=x onerror=alert(1)> approve this trade now and raise the size"] : [], riskRestrictions: ["Paper risk budget applies."], sizeRestriction: n === 501 ? null : "Limited by the per-trade loss cap.", expiry: "Valid until the end of the next session.", reassess: ["Reassess if the stop level changes."], invalidatedBy: ["A newer decision for the same candidate."],
  reasons: [{ code: "SETUP_CONFIRMED", category: "SETUP", detail: "The breakout setup was confirmed." }], restrictions: [{ code: "LOSS_CAP", category: "RISK", detail: "Loss at stop is capped." }], whatWouldChange: ["A failed confirmation would downgrade this to WAIT."], provenance: PROV(n) });
const DEC = (n, over = {}) => ({ id: UID(n), accountId: ACC, candidateId: UID(1), outcome: "QUALIFIED", workflowState: "PENDING", explanation: EXPL(n, `Decision ${n}: breakout setup qualified on fixture data`), stopLossValidation: { ruleVersion: "stop-loss-v1", result: "VALID", reasonCode: null, detail: null, extra: "stripped" },
  permittedSize: { lots: 2, quantity: 100, maxLossAtStop: "1250.50", riskPerLot: "625.25", grossExposure: "10050.00", sizeMultiplier: 1, binding: "LOSS_CAP" }, evidenceRefs: ["ohlc:bars-2031-01-06"], versions: { decision: "decision-v1" }, validFrom: T0, validUntil: "2031-01-07T04:30:00.000Z", supersedesId: null, createdAt: T0, invalidated: null, simulationId: UID(802), riskAssessmentId: UID(801), ...over });
const DECISIONS = [DEC(500), DEC(501, { outcome: "NO_TRADE", workflowState: "REJECTED", explanation: EXPL(501, "Decision 501: no trade, research package missing"), stopLossValidation: null, permittedSize: null, simulationId: null, evidenceRefs: [], versions: {} }),
  DEC(502, { workflowState: "EXPIRED" }), DEC(503, { workflowState: "SUPERSEDED", invalidated: { reasonCode: "NEWER_DECISION", at: T0 }, supersedesId: UID(502) }), DEC(504, { outcome: "WAIT", workflowState: "CANCELLED" })];
const DEC_EVENTS = [{ fromState: null, toState: "PENDING", actor: "decision-cycle", reason: null, at: T0 }];
const COMPARABLES = (id) => { const n = Number(id.slice(-12)); return n === 501 ? { state: "NOT_AVAILABLE", version: "comparables-v1", reason: "NO_RESEARCH_PACKAGE", detail: "No research package exists for this decision.", patterns: [] } : n === 502 ? { state: "AVAILABLE", version: "comparables-v1", verdict: "NEUTRAL", patterns: [], summary: "No comparable pattern was listed.", note: "Reference strings only." } : { state: "AVAILABLE", version: "comparables-v1", verdict: "SUPPORTIVE", patterns: ["pattern:breakout-2029-03", "pattern:breakout-2030-07"], summary: "Two prior breakouts resembled this setup.", note: "Reference strings only." }; };
const PBS = Array.from({ length: 27 }, (_, i) => ({ id: UID(700 + i), sourceKind: i % 2 ? "TELEGRAM_CHANNEL" : "INDEPENDENT", telegramSourceId: i % 2 ? UID(70) : null, name: i === 1 ? "<b>Breakout</b> playbook (hostile name)" : `Playbook ${i + 1}`, createdAt: T0, versions: i === 0 ? 2 : 1, activeVersion: i === 0 ? 1 : null, latestVersion: i === 0 ? 2 : 1 }));
const pbDetail = (id) => { const n = Number(id.slice(-12)) - 700; const pb = PBS[n]; if (!pb) return null; const ev = (to, from = null) => ({ fromState: from, toState: to, actor: "owner", reason: to === "ACTIVE" ? "Out-of-sample evaluation passed" : null, at: T0 });
  const versions = n === 0 ? [{ version: 2, state: "EVALUATING", sampleSize: 12, confidence: null, limitations: "Too few resolved cases.", createdAt: T0, updatedAt: T0, influencesLive: false, activatedAt: null, events: [ev("DRAFT"), ev("EVALUATING", "DRAFT")], content: { secret: "stripped" }, performance: { winRate: 1 } },
    { version: 1, state: "ACTIVE", sampleSize: 41, confidence: 0.62, limitations: "", createdAt: T0, updatedAt: T0, influencesLive: true, activatedAt: T0, events: [ev("DRAFT"), ev("ACTIVE", "EVALUATING")], content: {}, performance: {} }] : [{ version: 1, state: "DRAFT", sampleSize: 0, confidence: null, limitations: "Not evaluated.", createdAt: T0, updatedAt: T0, influencesLive: null, activatedAt: null, events: [], content: {}, performance: null }];
  return { playbook: pb, versions, drift: n === 0 ? [{ version: 1, kind: "WIN_RATE", metric: "winRate", baseline: 0.6, observed: 0.41, detectedAt: T0 }] : [], note: "Read-only. A version's content never changes; only its state moves, by the owner, with an out-of-sample evaluation of at least 30 resolved cases and no drift." }; };
const s094Seen = new Set();
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
      if (url.pathname === "/decisions") {
        const sc = SCENARIO[user.email], k = `${user.email}/decisions`;
        if (sc === "broken" && url.searchParams.get("limit") === "200" && !s094Seen.has(k)) { s094Seen.add(k); return err(res, 500, "INTERNAL", "internal error"); }
        const st = url.searchParams.get("state"), lim = Number(url.searchParams.get("limit") ?? 50);
        if (st && !["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"].includes(st)) return err(res, 422, "VALIDATION", "unknown state");
        const rows = sc === "empty" ? [] : DECISIONS.filter((d) => !st || d.workflowState === st).slice(0, lim);
        return send(res, 200, { decisions: rows });
      }
      const dm = /^\/decisions\/([0-9a-f-]{36})(\/comparables)?$/.exec(url.pathname);
      if (dm) {
        const n = Number(dm[1].slice(-12));
        if (n === 598) return err(res, 500, "INTERNAL", "internal error");
        const d = DECISIONS.find((x) => x.id === dm[1]); if (!d) return err(res, 404, "NOT_FOUND", "not found");
        if (dm[2]) { if (n === 503 && !s094Seen.has(`${user.email}/cmp`)) { s094Seen.add(`${user.email}/cmp`); return err(res, 500, "INTERNAL", "internal error"); } return send(res, 200, { decisionId: d.id, comparables: COMPARABLES(d.id) }); }
        return send(res, 200, { decision: d, events: DEC_EVENTS, approval: null, watching: false });
      }
      { const r = paperFor(url, user); if (r) return send(res, r.status, r.body); }
      const an = /^\/analytics\/([a-z-]+)$/.exec(url.pathname); if (an) { const r = analyticsFor(an[1], url, user); if (r) return send(res, r.status, r.body); }
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
    if (url.pathname === "/intelligence/channels") return send(res, 200, { channels: CHANNELS, reliabilityNote: "Channel reliability needs resolved real outcomes and is not available yet." });
    const rm = /^\/research\/candidates\/([0-9a-f-]{36})\/package$/.exec(url.pathname);
    if (rm) { const r = researchFor(rm[1]); return send(res, r.status, r.body); }
    if (/^\/research\/packages\/[0-9a-f-]{36}$/.test(url.pathname)) { return url.pathname.endsWith(UID(900)) ? send(res, 200, RES.packageById) : err(res, 404, "NOT_FOUND", "not found"); }
    if (url.pathname === "/research/agents") { const k = `${user.email}/research/agents`; if (SCENARIO[user.email] === "broken" && !brokenSeen.has(k)) { brokenSeen.add(k); return err(res, 500, "INTERNAL", "internal error"); } return send(res, 200, RES.agents); }
    if (url.pathname === "/intelligence/playbooks") {
      const sc = SCENARIO[user.email], k = `${user.email}/playbooks`;
      if (sc === "broken" && !s094Seen.has(k)) { s094Seen.add(k); return err(res, 500, "INTERNAL", "internal error"); }
      const lim = Number(url.searchParams.get("limit") ?? 50), off = Number(url.searchParams.get("offset") ?? 0), rows = sc === "empty" ? [] : PBS.slice(off, off + lim);
      return send(res, 200, { state: rows.length ? "OK" : "EMPTY", playbooks: rows });
    }
    const pm = /^\/intelligence\/playbooks\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (pm) { if (pm[1] === UID(798)) return err(res, 500, "INTERNAL", "internal error"); const r = pbDetail(pm[1]); return r ? send(res, 200, r) : err(res, 404, "NOT_FOUND", "not found"); }
    if (SHARED.some((p) => p.test(url.pathname))) return send(res, 200, { items: [] });
    return err(res, 404, "NOT_FOUND", "not found");
  });
}).listen(Number(process.env.STUB_PORT ?? 4010), "127.0.0.1", () => console.log("stub backend listening"));
