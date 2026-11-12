/**
 * Zod schemas for what crosses the BFF: request bodies (strict: unknown keys are refused) and the upstream responses the BFF itself consumes or relays.
 * Response schemas STRIP undeclared fields, so only declared data reaches the browser. A relayed route with no verified schema yet passes through as "a JSON object"
 * (listed in docs/frontend/contracts-verification.md §4); each screen stage adds the schema for the routes it uses.
 */
import { z } from "zod";
import { APPROVAL_ERROR_CODES, PLATFORM_ERROR_CODES } from "@twins/api-contracts";

export const LoginBody = z.strictObject({ email: z.string().min(3).max(254), password: z.string().min(1).max(1024) });
export type LoginBody = z.infer<typeof LoginBody>;

export const PublicUser = z.object({ id: z.string().min(1).max(64), email: z.string().max(254), displayName: z.string().max(200).nullable(), role: z.enum(["TRADER", "ADMIN"]), isActive: z.boolean() });
export type PublicUser = z.infer<typeof PublicUser>;
export const MeResponse = z.object({ user: PublicUser });
export const UpstreamLogin = z.object({ token: z.string().regex(/^tws_[A-Za-z0-9_-]{43}$/), expiresAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), "expiresAt must be a timestamp"), user: PublicUser });

export const AccountsResponse = z.object({ accounts: z.array(z.object({ id: z.string(), name: z.string(), tradingMode: z.string(), baseCurrency: z.string(), isActive: z.boolean() })).max(500) });

const ERROR_CODES = [...PLATFORM_ERROR_CODES, ...APPROVAL_ERROR_CODES] as [string, ...string[]];
/** Platform and approval error bodies: fixed fields only. */
export const UpstreamError = z.object({ error: z.enum(ERROR_CODES), message: z.string().max(300), reasons: z.array(z.string().max(200)).max(50).default([]), state: z.string().max(40).optional() });
const AnyJsonObject = z.record(z.string(), z.unknown());

// ── Stage 09.3A: shared-intelligence and desk reads. Key sets are asserted against the real routes by tests/unit/api-contracts/opportunityParity.test.ts (and, for the
//    desk reads, by wireShapes.test.ts); each schema here declares ONLY what a screen displays, so every other field is stripped before it reaches the browser. ──
const ts = z.string().max(40), id = z.string().max(64), short = z.string().max(200), nullShort = short.nullable();
export const CandidateView = z.object({
  id, source: z.enum(["TELEGRAM", "INDEPENDENT"]), state: z.string().max(40), stateReason: nullShort, supersededBy: id.nullable(), underlying: short, exchange: z.string().max(20), setup: nullShort, side: z.enum(["BUY", "SELL"]), entryKind: z.string().max(20),
  entryLow: z.number().nullable(), entryHigh: z.number().nullable(), stopLoss: z.number().nullable(), targets: z.array(z.number()).max(10), strike: z.number().nullable(), optionType: z.enum(["CE", "PE"]).nullable(), expiry: z.string().max(10).nullable(),
  rankScore: z.number().nullable(), dataSource: z.string().max(20), createdAt: ts, expiresAt: ts, lastValidatedAt: ts.nullable(), researchAttempts: z.number(),
});
export const CandidatesResponse = z.object({ state: z.enum(["EMPTY", "OK"]), candidates: z.array(CandidateView).max(200), note: short });
export const CandidateDetailResponse = z.object({
  candidate: CandidateView, lifecycle: z.array(z.object({ from: z.string().max(40).nullable(), to: z.string().max(40), reason: nullShort, at: ts })).max(200),
  evidence: z.array(z.unknown()).max(100), research: z.object({ status: z.string().max(40).nullable(), packageId: id.nullable(), packageVersion: z.number().nullable(), assessment: z.string().max(60).nullable() }),
});
export const ScansResponse = z.object({
  state: z.enum(["EMPTY", "OK"]),
  scans: z.array(z.object({ id, kind: z.string().max(60), slot: nullShort, status: z.string().max(40), dataSource: z.string().max(20), detectorVersion: z.string().max(80), universeSize: z.number(), candidates: z.number(), errorKind: nullShort, skipped: z.unknown(), startedAt: ts, completedAt: ts.nullable() })).max(200),
});
/** The agent results (`package`) are passed through as data but never interpreted: their inner shape is not contract-verified. */
export const ResearchPackageResponse = z.object({ packageId: id.optional(), candidateId: id, version: z.number().optional(), assessment: z.string().max(60).optional(), haltReason: nullShort.optional(), status: z.string().max(40).nullable(), researchAttempts: z.number().nullable(), createdAt: ts.optional(), note: short.optional() });
export const ChannelsResponse = z.object({
  channels: z.array(z.object({
    id, channel: z.string().max(40), name: nullShort, messages: z.number(), messages24h: z.number(), claims: z.object({ claim: z.number(), ambiguous: z.number(), unsupported: z.number() }), candidates: z.record(z.string(), z.number()),
    firstMessageAt: ts.nullable(), lastMessageAt: ts.nullable(),
    health: z.object({ status: z.string().max(20), lastMessageAgeSeconds: z.number().nullable(), messages24h: z.number(), capture: z.enum(["NO_DATA", "TIMELY", "DELAYED"]), reasons: z.array(z.string().max(60)).max(10), reliability: z.literal("NOT_AVAILABLE") }),
  })).max(200),
  reliabilityNote: short,
});
const DecisionLite = z.object({ id, candidateId: id, accountId: id, outcome: z.string().max(60), workflowState: z.string().max(40), validFrom: ts, validUntil: ts, createdAt: ts, invalidated: z.object({ reasonCode: z.string().max(80), at: ts }).nullable() });
export const DecisionsResponse = z.object({ decisions: z.array(DecisionLite).max(500) });
export const ApprovalsResponse = z.object({ pending: z.array(DecisionLite.extend({ expired: z.boolean(), action: z.object({ available: z.boolean() }) })).max(500), history: z.array(DecisionLite).max(500) });
export const PositionsResponse = z.object({
  positions: z.array(z.object({ id, accountId: id, instrument: short, exchange: z.string().max(20), side: z.enum(["BUY", "SELL"]), quantity: z.string().max(40), avgEntryPrice: z.string().max(40), stopLoss: z.string().max(40), realizedPnl: z.string().max(40), status: z.enum(["OPEN", "CLOSED"]), openedAt: ts })).max(500),
});

/** Relay response schema per catalogue route id. Absent = pass-through JSON object (no verified schema yet). */
export const RELAY_RESPONSE_SCHEMAS: Readonly<Record<string, z.ZodType | undefined>> = {
  "accounts.list": AccountsResponse, "opportunities.candidates": CandidatesResponse, "opportunities.candidate": CandidateDetailResponse, "opportunities.scans": ScansResponse,
  "research.package": ResearchPackageResponse, "intelligence.channels": ChannelsResponse, "decisions.list": DecisionsResponse, "approvals.list": ApprovalsResponse, "positions.list": PositionsResponse,
};
export const relaySchemaFor = (routeId: string): z.ZodType => RELAY_RESPONSE_SCHEMAS[routeId] ?? AnyJsonObject;
export const hasVerifiedSchema = (routeId: string): boolean => RELAY_RESPONSE_SCHEMAS[routeId] !== undefined;
