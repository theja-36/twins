import type { FastifyInstance } from "fastify";
import { PlatformError } from "@twins/types";
import type { AuthService } from "@twins/auth";
import { deriveResearchStatus, type ResearchStatus } from "@twins/agents";
import { getCandidate, getCandidateEvidence, getLatestResearchPackage, listCandidateEvents, listCandidates, listScans, type Db, type StoredCandidate, type StoredScan } from "@twins/database";
import { limit, query, uuid } from "./userApi.js";
import { iso, offsetOf, sharedGet } from "./telegramIntelApi.js";

/**
 * Opportunity read API (Stage 05, Module 16). Session-protected and READ-ONLY, like the other intelligence routes: candidates (BOTH sources, always labelled by `source`), their lifecycle history, evidence and research status,
 * and the recent scans with their recorded skip reasons are SHARED platform intelligence (no owner), so the shared permission `opportunities:read` applies. A candidate is a PROPOSAL for research: it carries no order, no approval and
 * no size, and nothing here can create, change, research, approve or execute anything. Missing values are null (never defaulted); the evidence is the parsed evidence the scan recorded, never message text.
 */
const STATES = ["NEW", "IN_RESEARCH", "READY_FOR_DECISION", "EXPIRED", "WITHDRAWN", "INVALIDATED", "SUPERSEDED"];
const SOURCES = ["TELEGRAM", "INDEPENDENT"] as const;
export interface OpportunityOps {
  candidates(o: { states?: readonly string[]; source?: (typeof SOURCES)[number]; limit: number; offset: number }): Promise<StoredCandidate[]>;
  candidate(id: string): Promise<StoredCandidate | null>;
  events(id: string): Promise<Array<{ fromState: string | null; toState: string; reason: string | null; occurredAt: Date }>>;
  evidence(id: string): Promise<unknown | null>;
  latestPackage(candidateId: string): Promise<{ id: string; version: number; assessment: string } | null>;
  scans(o: { limit: number; offset: number }): Promise<StoredScan[]>;
}
export function buildOpportunityOps(db: Db): OpportunityOps {
  return {
    candidates: (o) => listCandidates(db, o), candidate: (id) => getCandidate(db, id), events: (id) => listCandidateEvents(db, id), evidence: (id) => getCandidateEvidence(db, id),
    latestPackage: async (id) => { const p = await getLatestResearchPackage(db, id); return p ? { id: p.id, version: p.version, assessment: p.assessment } : null; }, scans: (o) => listScans(db, o),
  };
}
const candidateView = (c: StoredCandidate) => ({
  id: c.id, source: c.source, state: c.state, stateReason: c.stateReason, supersededBy: c.supersededBy, underlying: c.underlying, exchange: c.exchange, setup: c.setup, side: c.side, entryKind: c.entryKind, entryLow: c.entryLow, entryHigh: c.entryHigh,
  stopLoss: c.stopLoss, targets: c.targets, strike: c.strike, optionType: c.optionType, expiry: c.expiry, rankScore: c.rankScore, dataSource: c.dataSource, createdAt: iso(c.createdAt), expiresAt: iso(c.expiresAt), lastValidatedAt: iso(c.lastValidatedAt), researchAttempts: c.attempts,
});
const scanView = (s: StoredScan) => ({ id: s.id, kind: s.scanKind, slot: s.slotKey, status: s.status, dataSource: s.dataSource, detectorVersion: s.detectorVersion, universeSize: s.universeSize, candidates: s.candidateCount, errorKind: s.errorKind, skipped: s.skipped, parameters: s.parameters, startedAt: iso(s.startedAt), completedAt: iso(s.completedAt) });

export function registerOpportunityRoutes(app: FastifyInstance, deps: { auth: AuthService; ops: OpportunityOps; researchMaxAttempts?: number | null }): void {
  const { ops } = deps, get = sharedGet(app, deps.auth);
  get("/opportunities/candidates", "opportunities:read", async (req) => {
    const q = query(req as never, ["source", "state", "limit", "offset"]);
    if (q["source"] !== undefined && !(SOURCES as readonly string[]).includes(q["source"])) throw new PlatformError("VALIDATION", "unknown source");
    if (q["state"] !== undefined && !STATES.includes(q["state"])) throw new PlatformError("VALIDATION", "unknown state");
    const rows = await ops.candidates({ ...(q["source"] ? { source: q["source"] as (typeof SOURCES)[number] } : {}), ...(q["state"] ? { states: [q["state"]] } : {}), limit: limit(q["limit"], 50), offset: offsetOf(q["offset"]) });
    return { state: rows.length === 0 ? "EMPTY" : "OK", candidates: rows.map(candidateView), note: "Candidates are proposals for research. None carries an order, an approval or a size." };
  });
  get<{ id: string }>("/opportunities/candidates/:id", "opportunities:read", async (req) => {
    query(req as never, []); const id = uuid(req.params.id, "id"), c = await ops.candidate(id);
    if (!c) throw new PlatformError("NOT_FOUND", "not found");
    const [events, evidence, pkg] = await Promise.all([ops.events(id), ops.evidence(id), ops.latestPackage(id)]);
    const status: ResearchStatus | null = deriveResearchStatus({ candidateState: c.state, hasPackage: pkg !== null, assessment: (pkg?.assessment ?? null) as never, attempts: c.attempts, maxAttempts: deps.researchMaxAttempts ?? null });
    return { candidate: candidateView(c), lifecycle: events.map((e) => ({ from: e.fromState, to: e.toState, reason: e.reason, at: iso(e.occurredAt) })), evidence: Array.isArray(evidence) ? evidence : [], research: { status, packageId: pkg?.id ?? null, packageVersion: pkg?.version ?? null, assessment: pkg?.assessment ?? null } };
  });
  get("/opportunities/scans", "opportunities:read", async (req) => {
    const q = query(req as never, ["limit", "offset"]), rows = await ops.scans({ limit: limit(q["limit"], 50), offset: offsetOf(q["offset"]) });
    return { state: rows.length === 0 ? "EMPTY" : "OK", scans: rows.map(scanView) };
  });
}
