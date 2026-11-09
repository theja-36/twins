/**
 * OpenAPI 3.0 description of the SESSION-protected Telegram intelligence read API (Stage 03): the routes registered by `registerTelegramIntelRoutes` and `registerHistoryIntelRoutes`.
 * The operator document (`openapi.ts`, shared bearer key) does not cover these; this one is its own contract so the two auth models are never mixed up.
 * Hand-written like the operator document; `tests/unit/api/openapiSession.test.ts` fails if a route exists that is not described here (or the reverse), if the committed `docs/api/openapi-session.json` is stale,
 * or if any operation is not a read. Shapes are the ones the handlers return and the web app's typed registry consumes (twins-frontend `src/api/contracts/types.ts`).
 */
import { archiveListKey } from "./intelligenceApi.js";

type Json = Record<string, unknown>;
const ref = (n: string): Json => ({ $ref: `#/components/schemas/${n}` });
const idParam: Json = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const lim = (max: number, def: number): Json => ({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: max, default: def } });
const off: Json = { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 } };
const errs: Json = {
  "401": { description: "UNAUTHENTICATED: no session, an expired or revoked session, or the shared service key (never accepted here)" },
  "403": { description: "FORBIDDEN: the session lacks the permission" },
  "404": { description: "NOT_FOUND: no such record (the same answer for every missing id)" },
  "422": { description: "VALIDATION: unknown or malformed parameter, limit or offset out of bounds" },
};
const read = (perm: string, summary: string, schema: Json, parameters: Json[] = []): Json => ({
  tags: ["telegram-intelligence"], summary, security: [{ sessionBearer: [] }], "x-required-permission": perm, parameters,
  responses: { "200": { description: "OK", content: { "application/json": { schema } } }, ...errs },
});
const arr = (n: string): Json => ({ type: "array", items: ref(n) });
const obj = (properties: Json, required: string[] = Object.keys(properties)): Json => ({ type: "object", properties, required });
const nullableStr: Json = { type: "string", nullable: true };
const count: Json = { type: "object", additionalProperties: { type: "integer" } };

export const sessionOpenApiDocument: Json = {
  openapi: "3.0.3",
  info: {
    title: "TWINS Telegram intelligence read API (session)", version: "1.0.0",
    description: "Read-only. Shared platform intelligence (channels, claims, candidates, playbooks): no owner, so the shared permissions apply. Authentication is a user session token (`tws_...`); the shared operator key is refused. Channel identifiers are masked (`***` + last four) and raw message text is never returned. Lists use `limit` (1-200 unless stated) and `offset` (0-100000) with a deterministic order. Reliability and outcome-based performance are always NOT_AVAILABLE until resolved real outcomes are linked (gaps G-30, M01-14). A candidate only enters research; it is not a decision.",
  },
  components: {
    securitySchemes: { sessionBearer: { type: "http", scheme: "bearer", description: "Opaque user session token from POST /auth/login" } },
    schemas: {
      ChannelHealth: obj({ status: { type: "string", enum: ["NO_DATA", "ACTIVE", "QUIET", "STALE", "SILENT"] }, lastMessageAgeSeconds: { type: "integer", nullable: true }, messages24h: { type: "integer" }, capture: { type: "string", enum: ["NO_DATA", "TIMELY", "DELAYED"] }, reasons: { type: "array", items: { type: "string" } }, reliability: { type: "string", enum: ["NOT_AVAILABLE"] } }),
      Channel: obj({ id: { type: "string", format: "uuid" }, channel: { type: "string", description: "masked identifier" }, name: nullableStr, messages: { type: "integer" }, messages24h: { type: "integer" }, claims: count, candidates: count, firstMessageAt: { type: "string", format: "date-time", nullable: true }, lastMessageAt: { type: "string", format: "date-time", nullable: true }, health: ref("ChannelHealth") }),
      Claim: obj({ id: { type: "string", format: "uuid" }, resultKind: { type: "string", enum: ["claim", "ambiguous", "unsupported"] }, parserVersion: { type: "string" }, channelId: { type: "string", format: "uuid" }, messageTimestamp: { type: "string", format: "date-time" }, capturedAt: { type: "string", format: "date-time" }, captureMethod: { type: "string" }, claim: { type: "object", nullable: true, description: "allow-listed parsed fields only" }, classification: { type: "object", nullable: true }, candidacy: { type: "object", nullable: true, description: "policyVersion, outcome (CREATED, DUPLICATE, EXPIRED, SUPERSEDED_REVISION, INCOMPLETE, CONTRADICTORY, UNSUPPORTED), reasons, candidateId, evaluatedAt" }, candidate: { type: "object", nullable: true } }),
      Candidate: obj({ id: { type: "string", format: "uuid" }, claimId: { type: "string", format: "uuid" }, state: { type: "string", enum: ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"] }, underlying: { type: "string" }, entryKind: { type: "string", enum: ["above", "below", "at", "range", "market"] }, missingInformation: { type: "array", items: { type: "string" } }, validationStatus: { type: "string", enum: ["UNVERIFIED"] }, candidateVersion: { type: "integer" }, createdAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" } }, ["id", "claimId", "state", "underlying", "entryKind", "missingInformation", "validationStatus", "candidateVersion", "createdAt", "expiresAt"]),
      Pipeline: obj({ policyVersion: { type: "string" }, claimsTotal: { type: "integer" }, claimsParsed: { type: "integer" }, byOutcome: count, candidates: count, oldestPendingMinutes: { type: "integer", nullable: true }, note: { type: "string" } }),
      HistoricalMatches: obj({ claimId: { type: "string", format: "uuid" }, state: { type: "string", enum: ["UNAVAILABLE", "NOT_APPLICABLE", "SUFFICIENT", "INSUFFICIENT_EVIDENCE", "NO_COMPARABLE_CASES"] }, source: { type: "string", enum: ["ARCHIVE_IMPORT"] }, asOf: { type: "string", format: "date-time" }, reason: { type: "string" }, casesConsidered: { type: "integer" }, limitations: { type: "array", items: { type: "string" } }, result: { type: "object", nullable: true, description: "version, aggregate (wins, losses, winRate with interval, status), matches (similarity, coverage, matched/differing/unknown dimensions, outcome, observedAt), excluded, temporal counters, notes" } }, ["claimId", "state", "result"]),
      ChannelPerformance: obj({ channel: { type: "object" }, funnel: { type: "object" }, outcomes: obj({ status: { type: "string", enum: ["NOT_AVAILABLE"] }, reason: { type: "string" } }), reliability: { type: "string", enum: ["NOT_AVAILABLE"] }, archive: obj({ linked: { type: "boolean", enum: [false] }, note: { type: "string" } }) }),
      PlaybookSummary: obj({ id: { type: "string", format: "uuid" }, sourceKind: { type: "string", enum: ["TELEGRAM_CHANNEL", "INDEPENDENT"] }, telegramSourceId: { type: "string", format: "uuid", nullable: true }, name: { type: "string" }, createdAt: { type: "string", format: "date-time" }, versions: { type: "integer" }, activeVersion: { type: "integer", nullable: true }, latestVersion: { type: "integer", nullable: true } }),
      PlaybookDetail: obj({ playbook: ref("PlaybookSummary"), versions: { type: "array", items: { type: "object", description: "version, state (DRAFT, EVALUATING, ACTIVE, RETIRED, ROLLED_BACK), sampleSize, confidence, limitations, performance, content, events[]" } }, drift: { type: "array", items: { type: "object" } }, note: { type: "string" } }),
      ArchiveScoreTables: obj({ source: { type: "string", enum: ["ARCHIVE_IMPORT"] }, state: { type: "string", enum: ["EMPTY", "OK"] }, [archiveListKey()]: { type: "array", items: { type: "object" } }, note: { type: "string" } }),
    },
  },
  paths: {
    "/intelligence/channels": { get: read("channels:read", "Channels with message, claim and candidate counts and a health assessment", obj({ channels: arr("Channel"), reliabilityNote: { type: "string" } }), [lim(200, 100)]) },
    "/intelligence/channels/{id}": { get: read("channels:read", "One channel with its 20 most recent claims", obj({ channel: ref("Channel"), recentClaims: arr("Claim") }), [idParam]) },
    "/intelligence/claims": { get: read("signals:read", "Parsed claims, newest first", obj({ claims: arr("Claim") }), [{ name: "channelId", in: "query", schema: { type: "string", format: "uuid" } }, { name: "kind", in: "query", schema: { type: "string", enum: ["claim", "ambiguous", "unsupported"] } }, lim(200, 50)]) },
    "/intelligence/claims/{id}": { get: read("signals:read", "One claim with its classification, candidacy decision and candidate", obj({ claim: ref("Claim") }), [idParam]) },
    "/intelligence/candidates": { get: read("opportunities:read", "Telegram candidates (unverified; they only enter research)", obj({ source: { type: "string", enum: ["TELEGRAM"] }, candidates: arr("Candidate") }), [{ name: "state", in: "query", schema: { type: "string" } }, lim(200, 50)]) },
    "/intelligence/pipeline": { get: read("opportunities:read", "Claim-to-candidate pipeline counts for the current policy version", ref("Pipeline")) },
    "/intelligence/claims/{id}/historical-matches": { get: read("signals:read", "Archived cases comparable with the claim, using only cases that existed and whose outcome was known at the claim's own message time (association, not prediction)", ref("HistoricalMatches"), [idParam]) },
    "/intelligence/channels/{id}/performance": { get: read("strategies:read", "What the channel claimed and what the pipeline did with it; outcomes and reliability are NOT_AVAILABLE", ref("ChannelPerformance"), [idParam]) },
    "/intelligence/playbooks": { get: read("strategies:read", "Playbooks with version counts", obj({ state: { type: "string", enum: ["EMPTY", "OK"] }, playbooks: arr("PlaybookSummary") }), [{ name: "channelId", in: "query", schema: { type: "string", format: "uuid" } }, lim(200, 50), off]) },
    "/intelligence/playbooks/{id}": { get: read("strategies:read", "One playbook: versions with audited state events, and drift events", ref("PlaybookDetail"), [idParam]) },
    "/intelligence/archive/channels": { get: read("strategies:read", "Imported-history score tables (not linked to live channels)", ref("ArchiveScoreTables"), [lim(100, 20), off]) },
  },
};

export function documentedSessionRoutes(): Set<string> {
  const out = new Set<string>();
  for (const [path, item] of Object.entries(sessionOpenApiDocument["paths"] as Record<string, Json>)) for (const m of Object.keys(item)) out.add(`${m.toUpperCase()} ${path}`);
  return out;
}
