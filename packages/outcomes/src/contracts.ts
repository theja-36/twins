import type { AnalyticsReport } from "./analytics";

/**
 * Stable API contracts for the analytics (Stage 08 §10). These are TYPES and a route table, not routes: every endpoint is user-scoped and requires an authenticated session with the `analytics:read` permission, and the
 * authentication / session / per-route permission architecture (Stage 01) does not exist yet. So no route is registered and none may be added behind the shared bearer token (it cannot say whose analytics to return). The data
 * is available now through the internal services (`analyzeUser`, the stores) and the worker. Stage 09 builds the frontend on these shapes.
 */
export const ANALYTICS_CONTRACT_VERSION = "analytics-contract-v1";
export const ANALYTICS_PERMISSION = "analytics:read" as const;
export type AnalyticsSection = "overview" | "strategy" | "channels" | "independent" | "agents" | "decisionQuality" | "outcomes" | "insights" | "drift" | "dataQuality" | "calibration";
export interface AnalyticsEndpoint { method: "GET"; path: string; section: AnalyticsSection; permission: typeof ANALYTICS_PERMISSION; auth: "SESSION_REQUIRED"; ownerScoped: true; query: string[]; response: string }
export const ANALYTICS_ENDPOINTS: readonly AnalyticsEndpoint[] = [
  { method: "GET", path: "/analytics/overview", section: "overview", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: ["accountId?", "dataset=ALL|VALIDATED|FIXTURE"], response: "OverviewResponse" },
  { method: "GET", path: "/analytics/strategies", section: "strategy", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: ["dimension=strategy|version|instrument|timeframe|regime|exit|stop|target"], response: "StrategyResponse" },
  { method: "GET", path: "/analytics/channels", section: "channels", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: [], response: "ChannelResponse" },
  { method: "GET", path: "/analytics/independent", section: "independent", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: [], response: "IndependentResponse" },
  { method: "GET", path: "/analytics/agents", section: "agents", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: [], response: "AgentResponse" },
  { method: "GET", path: "/analytics/decisions", section: "decisionQuality", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: [], response: "DecisionQualityResponse" },
  { method: "GET", path: "/analytics/outcomes", section: "outcomes", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: ["finality=FINAL|PARTIAL", "limit<=200", "cursor?"], response: "OutcomeHistoryResponse" },
  { method: "GET", path: "/analytics/insights", section: "insights", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: ["kind?", "limit<=200"], response: "InsightResponse" },
  { method: "GET", path: "/analytics/drift", section: "drift", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: [], response: "DriftResponse" },
  { method: "GET", path: "/analytics/data-quality", section: "dataQuality", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: [], response: "DataQualityResponse" },
  { method: "GET", path: "/analytics/calibration", section: "calibration", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true, query: [], response: "CalibrationResponse" },
];
/** Every response carries these fields so a client can never show a figure without its provenance and limits. */
export interface ResponseEnvelope<T> { contractVersion: string; generatedAt: string; dataset: "PAPER"; mode: "PAPER"; liveStatus: "UNAVAILABLE"; notice: string; data: T }
export const PAPER_NOTICE = "Simulated paper-trading results. Figures based on fixture data are not validated performance. Confidence is a strength score, not a probability. Nothing here changes any setting.";
export function envelope<T>(report: Pick<AnalyticsReport, "generatedAt">, data: T): ResponseEnvelope<T> { return { contractVersion: ANALYTICS_CONTRACT_VERSION, generatedAt: report.generatedAt, dataset: "PAPER", mode: "PAPER", liveStatus: "UNAVAILABLE", notice: PAPER_NOTICE, data }; }
/** The typed section views of a report (a pure projection: no new computation, no new permission). */
export function sectionOf(report: AnalyticsReport, section: Exclude<AnalyticsSection, "outcomes" | "insights">): ResponseEnvelope<unknown> {
  const P = report.modes.PAPER;
  switch (section) {
    case "overview": return envelope(report, { all: P.overview, validatedOnly: P.validatedOnly, fixtureOnly: P.fixtureOnly });
    case "strategy": return envelope(report, P.strategy);
    case "channels": return envelope(report, P.telegram);
    case "independent": return envelope(report, P.independent);
    case "agents": return envelope(report, P.agents);
    case "decisionQuality": return envelope(report, P.decisionQuality);
    case "drift": return envelope(report, report.drift);
    case "dataQuality": return envelope(report, report.dataQuality);
    case "calibration": return envelope(report, report.calibration);
  }
}
/** Validates the common list query parameters; anything unknown is refused rather than ignored. */
export function parseListQuery(q: Record<string, unknown>): { ok: true; limit: number; kind?: string; finality?: "FINAL" | "PARTIAL" } | { ok: false; error: string } {
  const allowed = new Set(["limit", "kind", "finality", "cursor", "accountId", "dataset", "dimension"]);
  for (const k of Object.keys(q)) if (!allowed.has(k)) return { ok: false, error: `unknown parameter ${k.slice(0, 20)}` };
  const limit = q["limit"] === undefined ? 50 : Number(q["limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: "limit must be an integer between 1 and 200" };
  if (q["finality"] !== undefined && q["finality"] !== "FINAL" && q["finality"] !== "PARTIAL") return { ok: false, error: "finality must be FINAL or PARTIAL" };
  if (q["kind"] !== undefined && !/^[A-Z_]{3,30}$/.test(String(q["kind"]))) return { ok: false, error: "kind is malformed" };
  return { ok: true, limit, ...(q["kind"] !== undefined ? { kind: String(q["kind"]) } : {}), ...(q["finality"] !== undefined ? { finality: q["finality"] as "FINAL" | "PARTIAL" } : {}) };
}
