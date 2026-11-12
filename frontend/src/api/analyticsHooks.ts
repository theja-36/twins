"use client";
/**
 * Analytics reads. A GET of an analytics route may make the backend store ONE immutable snapshot when none is current, so these reads are deliberate:
 * long stale time, no refetch on focus, mount or reconnect, no polling, no retry, and one request per section (all datasets and dimensions arrive in that one response and are switched in the browser).
 * Nothing here writes: every call is a GET through the authenticated relay.
 */
import { useQuery } from "@tanstack/react-query";
import { getSessionRoute } from "./client";
import type { AgentsEnv, CalibrationEnv, ChannelsEnv, DataQualityEnv, DecisionsEnv, DriftEnv, IndependentEnv, InsightsEnv, OutcomesEnv, OverviewEnv, StrategiesEnv } from "./analyticsTypes";

export const ANALYTICS_QUERY = { staleTime: 5 * 60_000, gcTime: 30 * 60_000, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false, refetchInterval: false } as const;
const run = <T,>(section: string, path: string) => ({ queryKey: ["analytics", section, path], queryFn: () => getSessionRoute<T>(path), ...ANALYTICS_QUERY });
export const useOverview = () => useQuery(run<OverviewEnv>("overview", "/analytics/overview"));
export const useStrategies = () => useQuery(run<StrategiesEnv>("strategies", "/analytics/strategies"));
export const useChannelsAnalytics = () => useQuery(run<ChannelsEnv>("channels", "/analytics/channels"));
export const useIndependent = () => useQuery(run<IndependentEnv>("independent", "/analytics/independent"));
export const useAgents = () => useQuery(run<AgentsEnv>("agents", "/analytics/agents"));
export const useDecisionQuality = () => useQuery(run<DecisionsEnv>("decisions", "/analytics/decisions"));
export const useDrift = () => useQuery(run<DriftEnv>("drift", "/analytics/drift"));
export const useDataQuality = () => useQuery(run<DataQualityEnv>("data-quality", "/analytics/data-quality"));
export const useCalibration = () => useQuery(run<CalibrationEnv>("calibration", "/analytics/calibration"));
/** `finality` and `limit` are the verified parameters. The backend accepts a `cursor` but its handler never uses it and returns no next cursor, so there is no paging beyond `limit`. */
export const useOutcomes = (o: { finality?: "FINAL" | "PARTIAL"; limit: number }) => { const q = new URLSearchParams({ limit: String(o.limit), ...(o.finality ? { finality: o.finality } : {}) }).toString(); return useQuery(run<OutcomesEnv>("outcomes", `/analytics/outcomes?${q}`)); };
export const useInsights = (o: { kind?: string; limit: number }) => { const q = new URLSearchParams({ limit: String(o.limit), ...(o.kind ? { kind: o.kind } : {}) }).toString(); return useQuery(run<InsightsEnv>("insights", `/analytics/insights?${q}`)); };
