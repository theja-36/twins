/**
 * Stage 09.3B.1: STRICT schemas for the shapes proven against real backend output (tests/integration/api-contracts/realOutputShapes.test.ts). Not yet wired into the relay: each screen stage (09.3B.2 to 09.3B.4) attaches
 * the schema for the route it uses. Rules: undeclared fields are STRIPPED; money stays an exact decimal STRING (never a number); a value the backend states as null stays null; nothing here computes or defaults.
 * Left deliberately loose (unknown): optionsRisk, insight provenance / metrics / evidenceRefs, stop-loss fields beyond the four guaranteed ones, and anything not proven in 09.3B.1.
 */
import { z } from "zod";

const txt = (n = 400) => z.string().max(n), ts = z.string().max(40), hash = z.string().regex(/^[0-9a-f]{64}$/), id = z.string().max(64);
export const AgentReport = z.object({
  agentId: txt(80), agentVersion: txt(40), role: txt(60).nullable(), supplementsRoles: z.array(txt(60)).max(20).optional(), verdict: z.enum(["SUPPORTIVE", "CAUTION", "NEUTRAL", "ADVERSE", "INCOMPLETE", "BLOCKING"]), executionStatus: txt(40),
  confidence: z.number().nullable(), evidenceRefs: z.array(txt(200)).max(200), riskFlags: z.array(txt(120)).max(100), reasoningSummary: txt(600), inputSnapshotRef: txt(80), errorCode: txt(80).nullable(),
});
export const ResearchPackageBody = z.object({
  packageVersion: txt(40), candidateId: id, candidateSource: z.enum(["TELEGRAM", "INDEPENDENT"]), dataSource: txt(20), asOf: ts.optional(), version: z.number(), assessment: txt(60), halt: z.boolean(), haltReason: txt(120).nullable(), score: z.number().nullable(),
  synthesisAlgorithmVersion: txt(80), reports: z.array(AgentReport).max(50), contradictions: z.array(z.object({ supportive: z.array(txt(80)).max(50), opposing: z.array(txt(80)).max(50), opposingVerdict: z.enum(["ADVERSE", "BLOCKING"]) })).max(10),
  roleCoverage: z.object({ coveredRoles: z.array(txt(60)).max(30), missingRoles: z.array(txt(60)).max(30), unmappedAgents: z.array(txt(80)).max(30) }), optionsRisk: z.unknown().optional(),
  agentVersions: z.record(z.string(), txt(40)), evidenceIndex: z.array(txt(200)).max(500), missingRequired: z.array(txt(80)).max(50), grantsApproval: z.literal(false), synthesisInputSha256: hash, packageSha256: hash,
});
const Reason = z.object({ code: txt(80), category: txt(40), detail: txt(600) });
export const DecisionExplanation = z.object({
  headline: txt(400), supporting: z.array(txt(600)).max(50), missing: z.array(txt(600)).max(50), contradictory: z.array(txt(600)).max(50), riskRestrictions: z.array(txt(600)).max(50), sizeRestriction: txt(600).nullable(), expiry: txt(300),
  reassess: z.array(txt(600)).max(50), invalidatedBy: z.array(txt(600)).max(50), reasons: z.array(Reason).max(100), restrictions: z.array(Reason).max(100), whatWouldChange: z.array(txt(600)).max(50),
  provenance: z.object({ candidateId: id, candidateSource: txt(20), dataSource: txt(20), researchPackageId: id.nullable(), researchPackageSha256: txt(64).nullable(), confidenceAssessmentId: id.nullable(), riskAssessmentId: id.nullable(), simulationId: id.nullable() }),
});
export const StopLossValidation = z.object({ ruleVersion: txt(40), result: txt(40), reasonCode: txt(80).nullable(), detail: txt(200).nullable() });
export const PermittedSize = z.object({ lots: z.number(), quantity: z.number(), maxLossAtStop: z.string(), riskPerLot: z.string(), grossExposure: z.string(), sizeMultiplier: z.number(), binding: txt(40) });
export const Comparables = z.discriminatedUnion("state", [
  z.object({ state: z.literal("AVAILABLE"), version: txt(40), verdict: txt(40), patterns: z.array(txt(200)).max(20), summary: txt(600), note: txt(300) }),
  z.object({ state: z.literal("NOT_AVAILABLE"), version: txt(40), reason: z.enum(["NO_RESEARCH_PACKAGE", "NO_PATTERN_REPORT", "PATTERN_AGENT_INCOMPLETE", "NO_PATTERN_REFERENCE"]), detail: txt(300), patterns: z.array(z.never()).max(0) }),
]);
const Metric = <T extends z.ZodType>(v: T) => z.object({ value: v.nullable(), n: z.number(), definition: txt(600), note: txt(300).optional() });
const Interval = z.object({ lower: z.number(), upper: z.number() }).nullable();
export const PerformanceMetrics = z.object({
  version: txt(40), eligible: z.number(), reliability: txt(40), status: z.enum(["SUFFICIENT", "INSUFFICIENT_DATA"]), wins: z.number(), losses: z.number(), breakeven: z.number(),
  winRate: Metric(z.number()).extend({ interval: Interval }), lossRate: Metric(z.number()).extend({ interval: Interval }),
  grossPnl: z.string(), costs: z.string(), netPnl: z.string(), avgWin: Metric(z.string()), avgLoss: Metric(z.string()), payoffRatio: Metric(z.number()).extend({ exact: z.string().nullable() }),
  rMultiple: z.object({ n: z.number(), mean: z.number().nullable(), total: z.number().nullable(), definition: txt(600) }),
  expectancyR: Metric(z.number()).extend({ exact: z.string().nullable(), interval95: Interval, intervalMethod: txt(200), degreesOfFreedom: z.number().nullable() }),
  expectancyMoney: Metric(z.string()), profitFactor: Metric(z.number()).extend({ exact: z.string().nullable(), interval: z.null(), intervalNote: txt(300) }),
  maxDrawdown: Metric(z.string()).extend({ basis: txt(300) }), maxDrawdownPct: z.object({ value: z.null(), status: z.literal("NOT_AVAILABLE"), reason: txt(400), definition: txt(400) }),
  holdingSeconds: z.object({ n: z.number(), mean: z.number().nullable(), min: z.number().nullable(), p25: z.number().nullable(), median: z.number().nullable(), p75: z.number().nullable(), max: z.number().nullable() }),
  costImpact: Metric(z.number()), slippage: Metric(z.string()), dataSources: z.record(z.string(), z.number()), modes: z.record(z.string(), z.number()), periodStart: ts.nullable(), periodEnd: ts.nullable(),
});
export const SnapshotMeta = z.object({
  id, asOf: ts, createdAt: ts, verifiedAt: ts, evidenceHash: hash, inputHash: hash, configHash: hash, algorithmVersions: z.record(z.string(), txt(80)), createdBy: txt(20), freshness: z.enum(["CURRENT", "STALE"]), staleReason: txt(300).nullable(), complete: z.boolean(), maxAgeSeconds: z.number(),
});
/** The envelope every analytics route shares; `data` is attached per section by the screen stage. */
export const AnalyticsEnvelope = <T extends z.ZodType>(data: T) => z.object({
  contractVersion: txt(40), generatedAt: ts, dataset: z.literal("PAPER"), mode: z.literal("PAPER"), liveStatus: z.literal("UNAVAILABLE"), notice: txt(400), data, snapshot: SnapshotMeta, freshness: z.enum(["CURRENT", "STALE"]), state: z.enum(["EMPTY", "PARTIAL", "OK"]),
});
export const OverviewData = z.object({ all: PerformanceMetrics, validatedOnly: PerformanceMetrics, fixtureOnly: PerformanceMetrics });
export const InsightRow = z.object({
  id, insightKey: txt(200), kind: txt(40), scope: txt(60), subject: txt(200), outcomeCount: z.number(), periodStart: ts.nullable(), periodEnd: ts.nullable(), provenance: z.unknown(), method: txt(600), algorithmVersion: txt(80), evidenceRefs: z.unknown(), reliability: txt(40), severity: txt(20),
  statement: txt(1200), metrics: z.unknown(), limitations: z.array(txt(400)).max(50), recommendation: z.literal("REVIEW").nullable(), createdAt: ts,
});
