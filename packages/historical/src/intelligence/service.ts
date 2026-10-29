import { createHash } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { computeConfidence, CONFIDENCE_ALGORITHM_VERSION, resolveConfidenceConfig, type ConfidenceConfigOverride, type MarketContext, type SignalForConfidence } from "../patterns/confidence";
import { deriveFeatures, FEATURE_VERSION, patternKeys } from "../patterns/features";
import { latestPatternRun, loadPatternViews } from "../patterns/run";
import { canonicalSources, resolveSource } from "../scorecards/run";
import { TIER_LABELS, type Tier } from "../scorecards/tiers";

/**
 * Source intelligence (Stage 4 / Task 5): a READ-ONLY service over the stored scorecards, trust tiers and pattern library. It never writes, never throws for MISSING intelligence (it
 * returns an explicit UNKNOWN / UNAVAILABLE result), exposes identifiers, tiers and numbers only (no message text, no credentials), and is POINT-IN-TIME: a scorecard or pattern run
 * whose as-of is later than the instant being evaluated is never used. Database errors DO propagate: the caller (the risk flow) fails closed on them.
 */
export const INTELLIGENCE_ENGINE_VERSION = "source-intelligence-v1";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export type DataSufficiency = "SUFFICIENT" | "INSUFFICIENT" | "UNAVAILABLE";
export type IntelligenceStatus = "VALID" | "UNAVAILABLE";
export type IntelligenceReason = "OK" | "SOURCE_INTELLIGENCE_UNAVAILABLE" | "INSUFFICIENT_EVIDENCE" | "UNKNOWN_CONFIDENCE" | "UNTRUSTED_SOURCE" | "UNKNOWN_SOURCE_TRUST";

export interface SourceTrust {
  status: "AVAILABLE" | "UNKNOWN";
  tier: Tier;
  label: string;
  reason: "SCORECARD" | "SOURCE_NOT_REGISTERED" | "NO_SCORECARD" | "NO_SCORECARD_AT_SIGNAL_TIME" | "INSUFFICIENT_EVIDENCE" | "SOURCE_NOT_PROVIDED";
  scorecardRunId: string | null;
  /** The scorecard's as-of (its knowledge cutoff), never later than the instant evaluated. */
  asOf: string | null;
  algorithmVersion: string | null;
  configSha256: string | null;
  evaluable: number | null;
  dataSufficiency: DataSufficiency;
}
export interface IntelligenceSourceIdentity { label: string; registryId: string | null; members: string[]; registered: boolean }

/** Trust tier of a source as known at `asOf` (point in time). Unknown source / no scorecard / only later scorecards => UNKNOWN, never an exception. */
export async function getSourceTrustAsOf(db: Db, label: string, asOf: Date): Promise<{ identity: IntelligenceSourceIdentity; trust: SourceTrust }> {
  const unknown = (identity: IntelligenceSourceIdentity, reason: SourceTrust["reason"]): { identity: IntelligenceSourceIdentity; trust: SourceTrust } => ({
    identity, trust: { status: "UNKNOWN", tier: "UNKNOWN", label: TIER_LABELS.UNKNOWN, reason, scorecardRunId: null, asOf: null, algorithmVersion: null, configSha256: null, evaluable: null, dataSufficiency: "UNAVAILABLE" },
  });
  if (!label || !label.trim()) return unknown({ label: "", registryId: null, members: [], registered: false }, "SOURCE_NOT_PROVIDED");
  const src = await resolveSource(db, label);
  if (!src) return unknown({ label, registryId: null, members: [], registered: false }, "SOURCE_NOT_REGISTERED");
  const identity: IntelligenceSourceIdentity = { label, registryId: src.id, members: src.members, registered: true };
  const T = schema.historicalTrustTiers, R = schema.historicalScorecardRuns;
  const [t] = await db.select({ tier: T.tier, runId: T.runId, asOf: T.asOf, metrics: T.metricSnapshot, algorithm: R.algorithmVersion, configSha: R.configSha256 }).from(T).innerJoin(R, eq(R.id, T.runId))
    .where(and(eq(T.sourceId, src.id), lte(T.asOf, asOf))).orderBy(desc(T.asOf), desc(T.createdAt), desc(T.id)).limit(1);
  if (!t) {
    const [any] = await db.select({ id: T.id }).from(T).where(eq(T.sourceId, src.id)).limit(1);
    return unknown(identity, any ? "NO_SCORECARD_AT_SIGNAL_TIME" : "NO_SCORECARD");
  }
  const tier = t.tier as Tier;
  const evaluable = Number((t.metrics as { evaluable?: unknown } | null)?.evaluable ?? 0);
  return {
    identity,
    trust: { status: tier === "UNKNOWN" ? "UNKNOWN" : "AVAILABLE", tier, label: TIER_LABELS[tier], reason: tier === "UNKNOWN" ? "INSUFFICIENT_EVIDENCE" : "SCORECARD", scorecardRunId: t.runId, asOf: t.asOf.toISOString(), algorithmVersion: t.algorithm, configSha256: t.configSha, evaluable, dataSufficiency: tier === "UNKNOWN" ? "INSUFFICIENT" : "SUFFICIENT" },
  };
}

export interface SignalConfidenceSummary {
  score: number; tier: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"; evidenceQuality: string; sampleSize: number; primaryPatternKey: string | null; patternRunId: string | null; patternRunAsOf: string | null;
  patternRefs: Array<{ level: number; keyText: string; patternId: string; snapshotId: string; status: string; sampleSize: number }>;
  algorithmVersion: string; featureVersion: string;
}
export interface SignalIntelligence {
  engineVersion: string;
  status: IntelligenceStatus;
  reasonCode: IntelligenceReason;
  sourceIdentity: IntelligenceSourceIdentity;
  trust: SourceTrust;
  confidence: SignalConfidenceSummary;
  dataSufficiency: DataSufficiency;
  explanation: Array<{ rule: string; detail: string }>;
  limitations: string[];
  /** The instant intelligence was resolved FOR (the signal time): nothing later was used. */
  asOf: string;
  inputHash: string;
}
export interface IntelligenceRequest {
  sourceLabel: string;
  signal: SignalForConfidence;
  marketContext: MarketContext;
  /** Point-in-time instant; defaults to the signal's timestamp. */
  asOf?: Date;
  config?: ConfidenceConfigOverride;
}

export function reasonOf(trust: SourceTrust, confidence: SignalConfidenceSummary, identity: IntelligenceSourceIdentity): IntelligenceReason {
  if (!identity.registered || trust.reason === "NO_SCORECARD" || trust.reason === "NO_SCORECARD_AT_SIGNAL_TIME" || trust.reason === "SOURCE_NOT_PROVIDED" || confidence.evidenceQuality === "NO_LIBRARY") return "SOURCE_INTELLIGENCE_UNAVAILABLE";
  if (trust.tier === "D") return "UNTRUSTED_SOURCE";
  if (trust.tier === "UNKNOWN") return "UNKNOWN_SOURCE_TRUST";
  if (confidence.tier === "UNKNOWN") return confidence.evidenceQuality === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT_EVIDENCE" : "UNKNOWN_CONFIDENCE";
  return "OK";
}

/** Full intelligence for one signal: trust (as of the signal), deterministic confidence from the latest pattern run at or before the signal, and an explicit validity verdict. */
export async function getSignalIntelligence(db: Db, req: IntelligenceRequest): Promise<SignalIntelligence> {
  const asOf = req.asOf ?? req.signal.timestamp;
  const cfg = resolveConfidenceConfig(req.config);
  const { identity, trust } = await getSourceTrustAsOf(db, req.sourceLabel, asOf);
  const run = await latestPatternRun(db, asOf);
  const features = deriveFeatures(req.signal);
  let confidence: SignalConfidenceSummary;
  let explanation: SignalIntelligence["explanation"];
  let limitations: string[];
  if (!run) {
    confidence = { score: 0, tier: "UNKNOWN", evidenceQuality: "NO_LIBRARY", sampleSize: 0, primaryPatternKey: null, patternRunId: null, patternRunAsOf: null, patternRefs: [], algorithmVersion: CONFIDENCE_ALGORITHM_VERSION, featureVersion: FEATURE_VERSION };
    explanation = [{ rule: "NO_PATTERN_LIBRARY", detail: "no pattern metrics run exists at or before the signal time" }];
    limitations = ["HISTORICAL_ASSOCIATION_ONLY", "NO_CAUSAL_CLAIM"];
  } else {
    const views = await loadPatternViews(db, run.id, patternKeys(features).map((k) => k.keyText));
    const e = computeConfidence(req.signal, trust.tier, req.marketContext, (k) => views.get(k), cfg);
    confidence = { score: e.score, tier: e.tier, evidenceQuality: e.evidenceQuality, sampleSize: e.sampleSize, primaryPatternKey: e.primaryPatternKey, patternRunId: run.id, patternRunAsOf: run.asOf.toISOString(), patternRefs: e.patternRefs, algorithmVersion: CONFIDENCE_ALGORITHM_VERSION, featureVersion: FEATURE_VERSION };
    explanation = e.explanation;
    limitations = e.limitations;
  }
  const reasonCode = reasonOf(trust, confidence, identity);
  const status: IntelligenceStatus = reasonCode === "OK" ? "VALID" : "UNAVAILABLE";
  const dataSufficiency: DataSufficiency = reasonCode === "SOURCE_INTELLIGENCE_UNAVAILABLE" ? "UNAVAILABLE" : trust.dataSufficiency === "SUFFICIENT" && confidence.evidenceQuality === "SUFFICIENT" ? "SUFFICIENT" : "INSUFFICIENT";
  if (status !== "VALID") explanation = [{ rule: reasonCode, detail: "source intelligence is not valid for this signal; it cannot become approval-eligible" }, ...explanation];
  const inputHash = sha(JSON.stringify([INTELLIGENCE_ENGINE_VERSION, features, req.signal.stopLossValid, req.signal.dataQuality, req.marketContext.available, trust.scorecardRunId, confidence.patternRunId, cfg, identity.registryId, asOf.toISOString()]));
  return { engineVersion: INTELLIGENCE_ENGINE_VERSION, status, reasonCode, sourceIdentity: identity, trust, confidence, dataSufficiency, explanation, limitations, asOf: asOf.toISOString(), inputHash };
}

/** Source summary at an instant (default: the latest known). */
export async function getSourceIntelligenceSummary(db: Db, label: string, asOf: Date = new Date()): Promise<{ identity: IntelligenceSourceIdentity; trust: SourceTrust; patternLibrary: { available: boolean; patternRunId: string | null; asOf: string | null }; engineVersion: string }> {
  const { identity, trust } = await getSourceTrustAsOf(db, label, asOf);
  const run = await latestPatternRun(db, asOf);
  return { identity, trust, patternLibrary: { available: run !== undefined, patternRunId: run?.id ?? null, asOf: run?.asOf.toISOString() ?? null }, engineVersion: INTELLIGENCE_ENGINE_VERSION };
}

/** Every canonical source with its latest trust tier and whether a pattern library exists (operator listing). */
export async function listSourceIntelligence(db: Db, asOf: Date = new Date()): Promise<Array<{ label: string; members: string[]; tier: Tier; tierLabel: string; scorecardAsOf: string | null; evaluable: number | null; confidenceAvailable: boolean }>> {
  const run = await latestPatternRun(db, asOf);
  const out = [];
  for (const s of await canonicalSources(db)) {
    const { trust } = await getSourceTrustAsOf(db, s.channelLabel, asOf);
    out.push({ label: s.channelLabel, members: s.members, tier: trust.tier, tierLabel: trust.label, scorecardAsOf: trust.asOf, evaluable: trust.evaluable, confidenceAvailable: run !== undefined && trust.status === "AVAILABLE" });
  }
  return out;
}

/** Vocabulary the sizing engine understands: A->HIGH, B->MODERATE, C->LOW; D and UNKNOWN never size (UNTRUSTED / UNKNOWN). */
export function sizingTrustVocabulary(tier: Tier): string {
  return tier === "A" ? "HIGH" : tier === "B" ? "MODERATE" : tier === "C" ? "LOW" : tier === "D" ? "UNTRUSTED" : "UNKNOWN";
}
