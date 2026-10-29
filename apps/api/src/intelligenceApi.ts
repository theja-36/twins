import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@twins/database";
import { getSignalIntelligence, getSourceIntelligenceSummary, type SignalForConfidence } from "@twins/historical";
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
