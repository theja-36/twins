import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@twins/database";
import { dimensionsOfClaim, getSignalIntelligence, getSourceIntelligenceSummary, historicalCaseFromRow, matchSimilar, type SignalForConfidence, type SimilarityTarget } from "@twins/historical";
import { PlatformError } from "@twins/types";
import type { AuthService } from "@twins/auth";
import { limit, query, uuid } from "./userApi.js";
import { mask, offsetOf, sharedGet, type TelegramIntelOps } from "./telegramIntelApi.js";
import { safeClaimView } from "./liveApi.js";
import { getRiskDecision, intelligenceOf, isIntelligenceValid } from "@twins/risk";

/**
 * Source intelligence API (Stage 4 / Task 5). INTERNAL and READ-ONLY: every route requires the bearer token (the same TWINS_API_KEY authentication as the other protected routes);
 * there is no unauthenticated route and nothing is written. Responses carry identifiers, tiers, numbers and fixed codes only - never message text, the decision's input snapshot,
 * credentials or the approver's identity. The estimate endpoint evaluates a normalized signal AS OF its own timestamp (point in time); missing intelligence is an explicit UNKNOWN
 * result, not an error. It creates no risk decision, approval card, order, fill or position.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

function parseSignal(body: unknown): { sourceLabel: string; signal: SignalForConfidence; marketContextAvailable: boolean } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const s = b["signal"];
  if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
  const x = s as Record<string, unknown>;
  const sourceLabel = str(b["sourceLabel"], 200);
  const ts = typeof x["timestamp"] === "string" && ISO.test(x["timestamp"]) ? new Date(x["timestamp"]) : null;
  if (!sourceLabel || !ts || Number.isNaN(ts.getTime())) return null;
  const targets = x["targets"] === undefined ? [] : x["targets"];
  if (!Array.isArray(targets) || targets.length > 3 || targets.some((t) => !fin(t))) return null;
  const stopLoss = x["stopLoss"] === undefined || x["stopLoss"] === null ? null : x["stopLoss"];
  if (stopLoss !== null && !fin(stopLoss)) return null;
  const entryRaw = x["entry"] === undefined || x["entry"] === null ? null : x["entry"];
  let entry: SignalForConfidence["entry"] = null;
  if (entryRaw !== null) {
    if (typeof entryRaw !== "object" || Array.isArray(entryRaw)) return null;
    const e = entryRaw as Record<string, unknown>;
    if (typeof e["type"] !== "string" || !["at", "above", "below", "near", "range", "market", "unspecified"].includes(e["type"])) return null;
    for (const k of ["price", "low", "high"]) if (e[k] !== undefined && !fin(e[k])) return null;
    entry = { type: e["type"], ...(fin(e["price"]) ? { price: e["price"] } : {}), ...(fin(e["low"]) ? { low: e["low"] } : {}), ...(fin(e["high"]) ? { high: e["high"] } : {}) };
  }
  const dq = x["dataQuality"];
  if (typeof x["stopLossValid"] !== "boolean" || !["GOOD", "DEGRADED", "INSUFFICIENT", "UNKNOWN"].includes(dq as string)) return null;
  const expiryDate = x["expiryDate"] === undefined || x["expiryDate"] === null ? null : str(x["expiryDate"], 10);
  if (x["expiryDate"] !== undefined && x["expiryDate"] !== null && (expiryDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate))) return null;
  return {
    sourceLabel, marketContextAvailable: b["marketContextAvailable"] === true,
    signal: {
      market: str(x["market"], 20), instrumentType: str(x["instrumentType"], 20), underlying: str(x["underlying"], 40), optionType: str(x["optionType"], 4), side: str(x["side"], 4), entry, stopLoss: stopLoss as number | null,
      targets: targets as number[], expiryDate, timestamp: ts, stopLossValid: x["stopLossValid"], dataQuality: dq as SignalForConfidence["dataQuality"],
    },
  };
}

export function registerIntelligenceRoutes(app: FastifyInstance, deps: { db: Db; authorized: (header: string | undefined) => boolean }): void {
  const { db } = deps;
  const guard = (header: string | undefined, reply: FastifyReply): boolean => {
    if (deps.authorized(header)) return true;
    void reply.code(401).send({ error: "Unauthorized" });
    return false;
  };
  const fail = (reply: FastifyReply): FastifyReply => reply.code(500).send({ error: "internal_error" }); // a fixed code, never a driver message

  /** Source summary: latest trust tier (as of `asOf`, default now), scorecard reference, data sufficiency and algorithm / config versions. */
  app.get<{ Querystring: { label?: string; asOf?: string } }>("/intelligence/source", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    const label = str(request.query.label, 200);
    const asOfRaw = request.query.asOf;
    if (!label || (asOfRaw !== undefined && (!ISO.test(asOfRaw) || Number.isNaN(Date.parse(asOfRaw))))) return reply.code(400).send({ error: "invalid_input" });
    try {
      return await getSourceIntelligenceSummary(db, label, asOfRaw ? new Date(asOfRaw) : new Date());
    } catch {
      return fail(reply);
    }
  });

  /** Confidence estimate (and trust, sufficiency, explanation) for a normalized signal. Read-only. */
  app.post("/intelligence/estimate", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    const parsed = parseSignal(request.body);
    if (!parsed) return reply.code(400).send({ error: "invalid_input" });
    try {
      return await getSignalIntelligence(db, { sourceLabel: parsed.sourceLabel, signal: parsed.signal, marketContext: { available: parsed.marketContextAvailable } });
    } catch {
      return fail(reply);
    }
  });

  /** The intelligence snapshot recorded on a risk decision version (null when the version carries none). */
  app.get<{ Params: { id: string } }>("/risk/decisions/:id/intelligence", async (request, reply) => {
    if (!guard(request.headers.authorization, reply)) return reply;
    if (!UUID.test(request.params.id)) return reply.code(400).send({ error: "invalid_input" });
    try {
      const d = await getRiskDecision(db, request.params.id);
      if (!d) return reply.code(404).send({ error: "not_found" });
      const i = intelligenceOf(d);
      return { decisionId: d.id, decisionVersion: d.decisionVersion, effectiveStatus: d.effectiveStatus, current: d.supersededById === null, valid: isIntelligenceValid(i), intelligence: i };
    } catch {
      return fail(reply);
    }
  });
}

/**
 * Session-protected, read-only HISTORY routes (Stage 03 closure): similar archived cases for a claim, and the archive's channel score tables.
 * They live in this module because the historical research code may be reached from the API only here (the architecture tests allow-list exactly this file). They read the archive through bounded, deterministically ordered queries and never write.
 * Temporal integrity: a claim is compared only with archived cases dated before the claim whose outcome was already known at the claim's time (`matchSimilar` with `requireResolvedAt`).
 */
/** The response key of the archive list (shared with the session OpenAPI document so the contract cannot drift from the handler). */
export const archiveListKey = (): string => "scorecards";
export function registerHistoryIntelRoutes(app: FastifyInstance, deps: { auth: AuthService; ops: TelegramIntelOps }): void {
  const { auth, ops } = deps, get = sharedGet(app, auth);
  // ── historical matches: the claim is compared ONLY with archived cases that existed, and whose outcome was already known, at the claim's own message time ──
  get<{ id: string }>("/intelligence/claims/:id/historical-matches", "signals:read", async (req) => {
    query(req as never, []); const c = await ops.claim(uuid(req.params.id, "id"));
    if (!c) throw new PlatformError("NOT_FOUND", "not found");
    if (c.resultKind !== "claim") return { claimId: c.claimId, state: "NOT_APPLICABLE", reason: "only a parsed claim can be compared with history", result: null };
    const safe = safeClaimView(c.claim) as { underlying?: string | null; entry?: { type?: string | null; price?: number | null; low?: number | null; high?: number | null }; stopLoss?: number | null; targets?: number[]; expiry?: { status?: string | null; day?: number | null; month?: number | null; year?: number | null } } | null;
    const e = safe?.entry, ex = safe?.expiry;
    const expiryDate = ex?.status === "full" && ex.year && ex.month && ex.day ? `${ex.year}-${String(ex.month).padStart(2, "0")}-${String(ex.day).padStart(2, "0")}` : null;
    const target: SimilarityTarget = { id: c.claimId, at: c.messageTimestamp, dimensions: dimensionsOfClaim({ underlying: safe?.underlying ?? null, entry: e && e.type ? { type: e.type, ...(e.price != null ? { price: e.price } : {}), ...(e.low != null ? { low: e.low } : {}), ...(e.high != null ? { high: e.high } : {}) } : null, stopLoss: safe?.stopLoss ?? null, targets: safe?.targets ?? [], expiryDate, setup: c.classification?.setup ?? null, horizon: c.classification?.horizon ?? null }, c.messageTimestamp) };
    const rows = await ops.historicalRows({ before: c.messageTimestamp, limit: 2000 });
    const cases = rows.map(historicalCaseFromRow);
    if (cases.length === 0) return { claimId: c.claimId, asOf: c.messageTimestamp.toISOString(), state: "UNAVAILABLE", reason: "no archived historical case exists before this claim: missing evidence, not a neutral signal", casesConsidered: 0, result: null };
    const r = matchSimilar(target, cases, { requireResolvedAt: true });
    return {
      claimId: c.claimId, asOf: c.messageTimestamp.toISOString(), source: "ARCHIVE_IMPORT", state: r.aggregate.status, casesConsidered: cases.length, targetDimensions: target.dimensions,
      result: { version: r.version, aggregate: r.aggregate, matches: r.matches.slice(0, 20).map((m) => ({ ...m, observedAt: m.observedAt.toISOString() })), excluded: r.excluded, temporal: r.temporal, notes: r.notes },
      limitations: ["historical association only: not a prediction and not a probability of success", "only archived cases dated before the claim, whose outcome was already known at the claim's time, count as resolved", "archived cases do not carry setup, regime or volatility, so those dimensions are unknown and never match"],
    };
  });


  get("/intelligence/archive/channels", "strategies:read", async (req) => {
    const q = query(req as never, ["limit", "offset"]), lim = limit(q["limit"], 20);
    if (lim > 100) throw new PlatformError("VALIDATION", "limit must be an integer between 1 and 100");
    const rows = await ops.archive({ limit: lim, offset: offsetOf(q["offset"]) });
    const label = (s: string): string => (/^-?\d{6,}$/.test(s) ? mask(s) : s);
    return { source: "ARCHIVE_IMPORT", state: rows.length === 0 ? "EMPTY" : "OK", [archiveListKey()]: rows.map((r) => ({ sourceId: r.sourceId, channelLabel: label(r.channelLabel), asOf: r.asOf.toISOString(), algorithmVersion: r.algorithmVersion, trustTier: r.trustTier, windows: r.metrics.map((m) => ({ ...m, windowStart: m.windowStart.toISOString(), windowEnd: m.windowEnd.toISOString() })), snapshot: r.sourceSnapshot })), note: "Archive evidence from imported history only. Small windows carry their own caveats and are not a reliability claim." };
  });

}
