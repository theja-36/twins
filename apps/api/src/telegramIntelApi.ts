import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PlatformError, authorize, toErrorBody, type Permission } from "@twins/types";
import type { AuthService } from "@twins/auth";
import { assessChannelHealth, TELEGRAM_CANDIDACY_POLICY_VERSION } from "@twins/signals";
import { getClaimView, listChannelOverview, listClaimViews, listTelegramCandidates, telegramPipelineStatus, type ChannelOverview, type ClaimView, type Db } from "@twins/database";
import { bearerSessionToken } from "./authApi.js";
import { limit, query, uuid } from "./userApi.js";
import { safeClaimView } from "./liveApi.js";

/**
 * Telegram intelligence read API (Stage 03, section J). Session-protected like the user routes, but the data is SHARED platform intelligence (channels, claims, candidates), so the permissions are the shared ones
 * (`channels:read`, `signals:read`, `opportunities:read`), which a TRADER and an ADMIN hold; no private trading data is reachable from here.
 * What is exposed: counts, parsed claim fields through the existing field allow-list (`safeClaimView`), classification codes, candidacy decisions with reason codes, candidate state. NEVER raw message text or payloads;
 * channel identifiers are masked to their last four characters. Read-only: no route writes.
 */
export interface TelegramIntelOps {
  channels(now: Date, o: { id?: string; limit: number }): Promise<ChannelOverview[]>;
  claims(o: { sourceId?: string; kind?: string; limit: number }): Promise<ClaimView[]>;
  claim(id: string): Promise<ClaimView | null>;
  candidates(o: { states?: readonly string[]; limit: number }): Promise<Awaited<ReturnType<typeof listTelegramCandidates>>>;
  pipeline(now: Date): Promise<Awaited<ReturnType<typeof telegramPipelineStatus>>>;
}
export function buildTelegramIntelOps(db: Db): TelegramIntelOps {
  return { channels: (now, o) => listChannelOverview(db, now, o), claims: (o) => listClaimViews(db, o), claim: (id) => getClaimView(db, id), candidates: (o) => listTelegramCandidates(db, o), pipeline: (now) => telegramPipelineStatus(db, TELEGRAM_CANDIDACY_POLICY_VERSION, now) };
}
const mask = (s: string): string => `***${s.slice(-4)}`;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const CANDIDATE_STATES = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"];
const KINDS = ["claim", "ambiguous", "unsupported"];

export function registerTelegramIntelRoutes(app: FastifyInstance, deps: { auth: AuthService; ops: TelegramIntelOps; now?: () => Date }): void {
  const { auth, ops } = deps, now = deps.now ?? (() => new Date());
  const send = (reply: FastifyReply, e: unknown): FastifyReply => { const { status, body } = toErrorBody(e); return reply.code(status).send(body); };
  const get = <P = Record<string, string>>(path: string, perm: Permission, h: (req: FastifyRequest<{ Params: P; Querystring: Record<string, string> }>) => Promise<unknown>): void => {
    app.get<{ Params: P; Querystring: Record<string, string> }>(path, async (req, reply) => {
      try { const a = await auth.authenticate(bearerSessionToken(req.headers.authorization)); authorize(a.principal, perm); return await h(req); } catch (e) { return send(reply, e); }
    });
  };
  const channelView = (c: ChannelOverview) => ({ id: c.id, channel: mask(c.identifier), name: c.name, messages: c.messages, messages24h: c.messages24h, claims: c.claims, candidates: c.candidates, firstMessageAt: iso(c.firstMessageAt), lastMessageAt: iso(c.lastMessageAt), health: assessChannelHealth({ lastMessageAt: c.lastMessageAt, messages24h: c.messages24h, delayedShare24h: c.delayedShare24h, medianCaptureDelaySeconds24h: c.medianCaptureDelaySeconds24h, now: now() }) });
  const claimView = (c: ClaimView) => ({ id: c.claimId, resultKind: c.resultKind, parserVersion: c.parserVersion, channelId: c.sourceId, messageTimestamp: c.messageTimestamp.toISOString(), capturedAt: c.receivedAt.toISOString(), captureMethod: c.captureMethod, claim: safeClaimView(c.claim), classification: c.classification, candidacy: c.candidacy ? { ...c.candidacy, evaluatedAt: c.candidacy.evaluatedAt.toISOString() } : null, candidate: c.candidate ? { ...c.candidate, expiresAt: c.candidate.expiresAt.toISOString() } : null });

  get("/intelligence/channels", "channels:read", async (req) => { query(req as never, ["limit"]); const l = limit((req.query as Record<string, string>)["limit"], 100); return { channels: (await ops.channels(now(), { limit: l })).map(channelView), reliabilityNote: "Channel reliability needs resolved real outcomes and is not available yet." }; });
  get<{ id: string }>("/intelligence/channels/:id", "channels:read", async (req) => {
    query(req as never, []); const id = uuid(req.params.id, "id"), [c] = await ops.channels(now(), { id, limit: 1 });
    if (!c) throw new PlatformError("NOT_FOUND", "not found");
    return { channel: channelView(c), recentClaims: (await ops.claims({ sourceId: id, limit: 20 })).map(claimView) };
  });
  get("/intelligence/claims", "signals:read", async (req) => {
    const q = query(req as never, ["channelId", "kind", "limit"]);
    if (q["kind"] !== undefined && !KINDS.includes(q["kind"])) throw new PlatformError("VALIDATION", "unknown kind");
    return { claims: (await ops.claims({ ...(q["channelId"] ? { sourceId: uuid(q["channelId"], "channelId") } : {}), ...(q["kind"] ? { kind: q["kind"] } : {}), limit: limit(q["limit"]) })).map(claimView) };
  });
  get<{ id: string }>("/intelligence/claims/:id", "signals:read", async (req) => { query(req as never, []); const c = await ops.claim(uuid(req.params.id, "id")); if (!c) throw new PlatformError("NOT_FOUND", "not found"); return { claim: claimView(c) }; });
  get("/intelligence/candidates", "opportunities:read", async (req) => {
    const q = query(req as never, ["state", "limit"]);
    if (q["state"] !== undefined && !CANDIDATE_STATES.includes(q["state"])) throw new PlatformError("VALIDATION", "unknown state");
    const rows = await ops.candidates({ ...(q["state"] ? { states: [q["state"]] } : {}), limit: limit(q["limit"]) });
    return { source: "TELEGRAM", candidates: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString() })) };
  });
  get("/intelligence/pipeline", "opportunities:read", async (req) => { query(req as never, []); return { policyVersion: TELEGRAM_CANDIDACY_POLICY_VERSION, ...(await ops.pipeline(now())), note: "A candidate only enters research; research, stop-loss validation, risk, decision and approval still apply." }; });
}
