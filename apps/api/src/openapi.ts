import type { FastifyInstance } from "fastify";
import { guardWith, type Authorizer } from "./apiSupport.js";

/**
 * OpenAPI 3.0 description of the operator / frontend API (the routes registered by riskApi, intelligenceApi, paperApi, agentsApi, notificationsApi, systemApi, adminApi, plus health).
 * Hand-written on purpose (no runtime dependency); a unit test registers every route module and fails if a route exists that is not described here, or the reverse.
 * Excluded by design: the Telegram webhook, the internal capture ingest and the per-signal validation / revision lookups (machine-to-machine; see their own docs).
 */
type Json = Record<string, unknown>;
const uuid = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const limit = (max: number, def: number) => ({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: max, default: def } });
const ok = (description: string, schema: Json = { type: "object" }): Json => ({ description, content: { "application/json": { schema } } });
const errs: Json = { "400": { description: "invalid_input" }, "401": { description: "Unauthorized (missing or wrong bearer token)" }, "500": { description: "internal_error (fixed body; details are in the server log)" } };
const read = (tag: string, summary: string, response: Json, parameters: Json[] = []): Json => ({ tags: [tag], summary, security: [{ bearerAuth: [] }], parameters, responses: { "200": response, ...errs } });

export const openApiDocument: Json = {
  openapi: "3.0.3",
  info: { title: "TWINS operator API", version: "1.0.0", description: "Internal, bearer-protected API for the operator frontend. Everything here is READ-ONLY except the human approval door (`/risk/decisions/{id}/approval*`, which records a decision but creates no order) and the separately-authenticated admin switch for paper trading. No route places, changes or cancels an order: no order path exists. Paper trading is simulation only." },
  servers: [{ url: "http://127.0.0.1:4400", description: "staging API through an SSH tunnel: ssh -L 4400:127.0.0.1:4110 hostinger-vps (the API listens on the VPS loopback port 4110, port 4000 inside its container)" }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "TWINS_API_KEY" }, adminBearer: { type: "http", scheme: "bearer", description: "TWINS_ADMIN_API_KEY (a different, longer token; the admin route does not exist unless it is configured)" } } },
  paths: {
    "/health": { get: { tags: ["health"], summary: "Liveness (no auth)", responses: { "200": ok("status, service, appEnv, tradingMode, liveTradingEnabled") } } },
    "/health/status": { get: read("health", "Database, Redis, runtime controls, outbox counts, last backup and audit verification", ok("status document")) },
    "/risk/decisions": { get: read("risk", "Recent risk decisions (newest first)", ok("{ decisions: DecisionSummary[] }"), [limit(200, 50), { name: "status", in: "query", schema: { type: "string", enum: ["PENDING", "APPROVED_FOR_REVIEW", "REJECTED", "EXPIRED", "SUPERSEDED"] } }]) },
    "/risk/decisions/{id}/summary": { get: read("risk", "One decision (safe fields only)", ok("DecisionSummary"), [uuid]) },
    "/risk/decisions/{id}/approval-eligibility": { get: read("risk", "Whether the decision may be approved now, with reasons", ok("SafeEligibility"), [uuid]) },
    "/risk/decisions/{id}/intelligence": { get: read("intelligence", "Source intelligence recorded for the decision", ok("intelligence summary"), [uuid]) },
    "/risk/approvals": { get: read("risk", "Recent human approvals and rejections (approver masked)", ok("{ approvals: ApprovalSummary[] }"), [limit(200, 50)]) },
    "/risk/decisions/{id}/approval-card": { post: { tags: ["risk"], summary: "Create the approval card (does not send it; the approval bot delivers it)", security: [{ bearerAuth: [] }], parameters: [uuid], responses: { "200": ok("card already existed"), "201": ok("card created"), "409": { description: "not_approval_eligible, with reasons" }, ...errs } } },
    "/risk/decisions/{id}/approval": { post: { tags: ["risk"], summary: "Record APPROVE or REJECT of the decision version (the database re-checks every gate). Creates NO order.", security: [{ bearerAuth: [] }], parameters: [uuid], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["action", "actor"], properties: { action: { enum: ["APPROVE", "REJECT"] }, actor: { type: "string", pattern: "^operator:[A-Za-z0-9._-]{1,64}$" }, reason: { type: "string", maxLength: 500 } } } } } }, responses: { "201": ok("recorded"), "409": { description: "duplicate or refused" }, ...errs } } },
    "/intelligence/source": { get: read("intelligence", "Source scorecard / trust tier lookup", ok("source intelligence"), [{ name: "label", in: "query", schema: { type: "string" } }, { name: "asOf", in: "query", schema: { type: "string", format: "date-time" } }]) },
    "/intelligence/estimate": { post: { tags: ["intelligence"], summary: "Calibrated confidence estimate for a hypothetical signal (read-only computation)", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("estimate"), ...errs } } },
    "/paper/status": { get: read("paper", "Paper trading: effective state, host arming, audited switch and its history, configuration and P&L summary", ok("PaperStatus")) },
    "/paper/summary": { get: read("paper", "Open / pending / closed counts, exposure, realised and unrealised P&L", ok("PnlSummary")) },
    "/paper/positions": { get: read("paper", "Simulated trades with stop, targets, last price, P&L and R", ok("{ positions: PositionView[] }"), [limit(500, 100), { name: "state", in: "query", schema: { type: "string", enum: ["PENDING_ENTRY", "OPEN", "CLOSED", "CANCELLED"] } }]) },
    "/paper/trades/{id}/events": { get: read("paper", "Append-only event history of one simulated trade", ok("{ events: [] }"), [uuid, limit(500, 200)]) },
    "/paper/outcomes": { get: read("paper", "Recent closed-trade outcomes (learning-loop input)", ok("{ outcomes: TradeOutcome[] }"), [limit(500, 100)]) },
    "/paper/outcomes/stats": { get: read("paper", "Win rate, expectancy, profit factor, drawdown and breakdowns; says when the sample is too small", ok("OutcomeStats")) },
    "/risk/decisions/{id}/decision-card": { get: read("risk", "Read-only explainable decision card built from the stored synthesis and decision (assessment, decided-by rule, agent verdicts, close calls, sizing facts); 404 when no assessment is stored; never an approval", ok("DecisionCard"), [uuid]) },
    "/agents/status": { get: read("agents", "Research agents (contract metadata), engine mode and recent PERSISTED runs (shadow results are logged, not stored)", ok("AgentsStatus"), [limit(100, 20)]) },
    "/notifications": { get: read("notifications", "Merged newest-first feed of audited system events (not the Telegram alert history); a source the runtime role cannot read is listed in unavailableSources", ok("{ notifications: Notification[], unavailableSources: string[], note: string }"), [limit(200, 50)]) },
    "/system/config": { get: read("system", "Safe configuration snapshot as the API process sees it (limits, switches, modes; no credentials). runtimeControls = { tradingEnabled, intakeEnabled, killSwitchActive, versions } (camelCase) or null when unreadable", ok("SystemConfig")) },
    "/admin/paper/switch": { post: { tags: ["admin"], summary: "Turn the audited paper-trading switch on or off (needs the admin token; has no effect unless the host has armed paper trading; enabling is refused while the live-trading guard fails)", security: [{ adminBearer: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled", "actor", "reason"], properties: { enabled: { type: "boolean" }, actor: { type: "string", pattern: "^(operator|service):[A-Za-z0-9._-]{1,64}$" }, reason: { type: "string", minLength: 3, maxLength: 500 } } } } } }, responses: { "200": ok("unchanged"), "201": ok("enabled or disabled"), "400": { description: "invalid_input" }, "401": { description: "Unauthorized" }, "409": { description: "live_trading_guard_failed" }, "500": { description: "internal_error" } } } },
    "/intake/status": { get: read("intake", "Telegram intake: counts by status, oldest open item, last received / completed, recent items (type, status, attempts, times, masked channel; never message text)", ok("IntakeStatus"), [limit(100, 25)]) },
    "/telegram/channels": { get: read("telegram", "Captured Telegram channels (masked identifier) with message, revision and claim counts, last message time and whether capture is allowed; no message content", ok("{ channels: ChannelSummary[] }")) },
    "/telegram/claims": { get: read("telegram", "Parsed options claims, newest first (underlying, strike, type, action, entry, stop with basis and whether it was inferred, targets, expiry status, blocker codes). Never message text or raw fragments", ok("{ claims: ClaimView[] }"), [limit(100, 25), { name: "channel", in: "query", schema: { type: "string", description: "masked channel as returned by /telegram/channels, e.g. ***2544" } }]) },
    "/market/sources": { get: read("market", "Source health profile of the provider data files (status, reasons, data and export age, usable); read-only evidence, never an approval", ok("SourceHealthProfile")) },
    "/market/snapshot": { get: read("market", "The Kite snapshot generation (status, per-file age), index prices with one-day change, quote counts, and the provider data files (present, as-of, age, count)", ok("MarketSnapshot")) },
    "/paper/readiness": { get: read("paper", "The paper-trading ENABLE checklist: each condition with pass / fail / info / manual, the blockers, readyToEnable and enabledNow. Turns nothing on", ok("Readiness")) },
    "/openapi.json": { get: read("meta", "This document", ok("OpenAPI 3 document")) },
  },
};

export function documentedRoutes(): Set<string> {
  const out = new Set<string>();
  for (const [path, item] of Object.entries(openApiDocument["paths"] as Record<string, Json>)) for (const m of Object.keys(item)) out.add(`${m.toUpperCase()} ${path}`);
  return out;
}

export function registerOpenApiRoute(app: FastifyInstance, deps: { authorized: Authorizer }): void {
  const guard = guardWith(deps.authorized);
  app.get("/openapi.json", async (request, reply) => (guard(request, reply) ? openApiDocument : reply));
}
