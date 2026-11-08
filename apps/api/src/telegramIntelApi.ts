import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PlatformError, authorize, toErrorBody, type Permission } from "@twins/types";
import type { AuthService } from "@twins/auth";
import { assessChannelHealth, TELEGRAM_CANDIDACY_POLICY_VERSION } from "@twins/signals";
import { getChannelFunnel, getClaimView, getPlaybookDetail, listArchiveScorecards, listChannelOverview, listClaimViews, listHistoricalCaseRows, listPlaybooks, listTelegramCandidates, telegramPipelineStatus, type ChannelOverview, type ClaimView, type Db } from "@twins/database";
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
  playbooks(o: { telegramSourceId?: string; limit: number; offset: number }): Promise<Awaited<ReturnType<typeof listPlaybooks>>>;
  playbook(id: string): Promise<Awaited<ReturnType<typeof getPlaybookDetail>>>;
  historicalRows(o: { before: Date; limit: number }): Promise<Awaited<ReturnType<typeof listHistoricalCaseRows>>>;
  archive(o: { limit: number; offset: number }): Promise<Awaited<ReturnType<typeof listArchiveScorecards>>>;
  funnel(sourceId: string): Promise<Awaited<ReturnType<typeof getChannelFunnel>>>;
}
export function buildTelegramIntelOps(db: Db): TelegramIntelOps {
  return { channels: (now, o) => listChannelOverview(db, now, o), claims: (o) => listClaimViews(db, o), claim: (id) => getClaimView(db, id), candidates: (o) => listTelegramCandidates(db, o), pipeline: (now) => telegramPipelineStatus(db, TELEGRAM_CANDIDACY_POLICY_VERSION, now), playbooks: (o) => listPlaybooks(db, o), playbook: (id) => getPlaybookDetail(db, id), historicalRows: (o) => listHistoricalCaseRows(db, o), archive: (o) => listArchiveScorecards(db, o), funnel: (id) => getChannelFunnel(db, id, TELEGRAM_CANDIDACY_POLICY_VERSION) };
}
export const mask = (s: string): string => `***${s.slice(-4)}`;
export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const CANDIDATE_STATES = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"];
const KINDS = ["claim", "ambiguous", "unsupported"];

/** A session-protected GET registrar for SHARED intelligence: authenticate, then the shared permission, then the handler; every error is a fixed code. */
export function sharedGet(app: FastifyInstance, auth: AuthService) {
  const send = (reply: FastifyReply, e: unknown): FastifyReply => { const { status, body } = toErrorBody(e); return reply.code(status).send(body); };
  return <P = Record<string, string>>(path: string, perm: Permission, h: (req: FastifyRequest<{ Params: P; Querystring: Record<string, string> }>) => Promise<unknown>): void => {
    app.get<{ Params: P; Querystring: Record<string, string> }>(path, async (req, reply) => {
      try { const a = await auth.authenticate(bearerSessionToken(req.headers.authorization)); authorize(a.principal, perm); return await h(req); } catch (e) { return send(reply, e); }
    });
  };
}
export const offsetOf = (v: string | undefined): number => { const x = v === undefined ? 0 : Number(v); if (!Number.isInteger(x) || x < 0 || x > 100_000) throw new PlatformError("VALIDATION", "offset must be an integer between 0 and 100000"); return x; };
export function registerTelegramIntelRoutes(app: FastifyInstance, deps: { auth: AuthService; ops: TelegramIntelOps; now?: () => Date }): void {
  const { auth, ops } = deps, now = deps.now ?? (() => new Date());
  const get = sharedGet(app, auth);
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


  // ── live channel performance: what the pipeline did with the channel's claims; no outcome-based claim without resolved real outcomes ──
  get<{ id: string }>("/intelligence/channels/:id/performance", "strategies:read", async (req) => {
    query(req as never, []); const id = uuid(req.params.id, "id"), [ch] = await ops.channels(now(), { id, limit: 1 });
    if (!ch) throw new PlatformError("NOT_FOUND", "not found");
    const f = await ops.funnel(id);
    return {
      channel: { id, channel: mask(ch.identifier), name: ch.name },
      funnel: { claims: f.claims, candidacy: f.candidacy, candidates: f.candidates, firstClaimAt: iso(f.firstClaimAt), lastClaimAt: iso(f.lastClaimAt) },
      outcomes: { status: "NOT_AVAILABLE", reason: "no resolved real outcome is linked to this channel; counts above describe what was claimed and what the pipeline did with it, never how good the calls were" },
      reliability: "NOT_AVAILABLE",
      archive: { linked: false, note: "imported-history score tables are keyed by the archive's own channel label and are not linked to live channels; see /intelligence/archive/channels" },
    };
  });
  // ── versioned playbooks (read-only; activation stays owner-run and database-guarded) ──
  get("/intelligence/playbooks", "strategies:read", async (req) => {
    const q = query(req as never, ["channelId", "limit", "offset"]);
    const rows = await ops.playbooks({ ...(q["channelId"] ? { telegramSourceId: uuid(q["channelId"], "channelId") } : {}), limit: limit(q["limit"], 50), offset: offsetOf(q["offset"]) });
    return { state: rows.length === 0 ? "EMPTY" : "OK", playbooks: rows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })) };
  });
  get<{ id: string }>("/intelligence/playbooks/:id", "strategies:read", async (req) => {
    query(req as never, []); const p = await ops.playbook(uuid(req.params.id, "id"));
    if (!p) throw new PlatformError("NOT_FOUND", "not found");
    return { playbook: { ...p.playbook, createdAt: p.playbook.createdAt.toISOString() }, versions: p.versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(), activatedAt: iso(v.activatedAt), events: v.events.map((x) => ({ ...x, at: x.at.toISOString() })) })), drift: p.drift.map((x) => ({ ...x, detectedAt: x.detectedAt.toISOString() })), note: "Read-only. A version's content never changes; only its state moves, by the owner, with an out-of-sample evaluation of at least 30 resolved cases and no drift." };
  });
}
