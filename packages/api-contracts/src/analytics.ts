/**
 * Analytics response contracts: MIRRORED from `packages/outcomes/src/contracts.ts` (`ResponseEnvelope`, `ANALYTICS_ENDPOINTS`, `ANALYTICS_CONTRACT_VERSION`, `PAPER_NOTICE`) and `packages/outcomes/src/snapshot.ts` (`SnapshotMeta`),
 * plus the response composition in apps/api/src/userApi.ts:163-195. Parity: tests/unit/api-contracts/analyticsParity.test.ts.
 *
 * VERIFIED composition (userApi.ts): every analytics response is `{ ...envelope, snapshot, freshness, state }` at the TOP LEVEL, with `data` inside the envelope.
 * The `data` payload of each section is NOT typed here (`unknown`): its inner shape is defined by `AnalyticsReport` in the outcomes package and no contract test asserts it yet.
 */
export const ANALYTICS_CONTRACT_VERSION = "analytics-contract-v1" as const;
export const ANALYTICS_NOTICE = "Simulated paper-trading results. Figures based on fixture data are not validated performance. Confidence is a strength score, not a probability. Nothing here changes any setting." as const;

/** `SnapshotMeta` (snapshot.ts:72). `algorithmVersions` is not guaranteed beyond being present. */
export interface SnapshotMetaView { id: string; asOf: string; createdAt: string; verifiedAt: string; evidenceHash: string; inputHash: string; configHash: string; algorithmVersions: unknown; createdBy: string; freshness: "CURRENT" | "STALE"; staleReason: string | null; complete: boolean; maxAgeSeconds: number }

export interface AnalyticsEnvelope<T> { contractVersion: typeof ANALYTICS_CONTRACT_VERSION; generatedAt: string; dataset: "PAPER"; mode: "PAPER"; liveStatus: "UNAVAILABLE"; notice: string; data: T }
/** What every analytics route returns (the 11 endpoints). */
export type AnalyticsResponse<T = unknown> = AnalyticsEnvelope<T> & { snapshot: SnapshotMetaView; freshness: "CURRENT" | "STALE"; state: "EMPTY" | "PARTIAL" | "OK" };

/** One row of GET /analytics/outcomes (userApi.ts mapping of `AttributionRow`). */
export interface OutcomeRowView {
  id: string; paperPositionId: string; decisionId: string; version: number; finality: "PARTIAL" | "FINAL"; mode: "PAPER" | "LIVE"; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; candidateSource: "TELEGRAM" | "INDEPENDENT";
  setup: string | null; instrument: string; side: "BUY" | "SELL"; grossPnl: string | null; costs: string | null; netPnl: string | null; rMultiple: string | null; holdingSeconds: number | null; exitReason: string | null;
  closedAt: string | null; dataQuality: unknown; missing: unknown; correctionReason: string | null;
}
/** One row of GET /analytics/insights (`InsightRow`, packages/database/src/stores/outcomeStore.ts:156). The route returns the rows as stored. */
export interface InsightRowView { id: string; insightKey: string; kind: string; scope: string; subject: string; outcomeCount: number; periodStart: string | null; periodEnd: string | null; provenance: unknown; method: string; algorithmVersion: string; evidenceRefs: unknown; reliability: string; severity: string; statement: string; metrics: unknown; limitations: string[]; recommendation: string | null; createdAt: string }
