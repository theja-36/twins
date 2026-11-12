"use client";
/**
 * Decision and playbook reads (GET only, through the authenticated relay). Decisions are owner-scoped (an ADMIN receives 404, so callers pass `enabled: false`); playbooks are shared intelligence.
 * Nothing polls and nothing refetches on focus. The comparables request is made only when the reader asks for it, once per decision.
 */
import { useQuery } from "@tanstack/react-query";
import { getSessionRoute } from "./client";
import type { ComparablesResponse, DecisionDetail, DecisionList, PlaybookDetail, PlaybookList } from "./strategyTypes";

export const STRATEGY_QUERY = { staleTime: 60_000, gcTime: 10 * 60_000, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false } as const;
/** The backend's own bounds: `/decisions` has a limit (1 to 200) and NO offset. */
export const DECISION_HISTORY_LIMIT = 200;
export const PLAYBOOK_PAGE_SIZE = 25;
const qs = (o: Record<string, string | number | undefined>): string => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ""; };

export const useDecisionHistory = (f: { state?: string }) => useQuery({ queryKey: ["decision-history", f], queryFn: () => getSessionRoute<DecisionList>(`/decisions${qs({ ...f, limit: DECISION_HISTORY_LIMIT })}`), ...STRATEGY_QUERY });
export const useDecisionDetail = (id: string) => useQuery({ queryKey: ["decision-detail", id], queryFn: () => getSessionRoute<DecisionDetail>(`/decisions/${id}`), ...STRATEGY_QUERY });
export const useDecisionComparables = (id: string, enabled: boolean) => useQuery({ queryKey: ["decision-comparables", id], queryFn: () => getSessionRoute<ComparablesResponse>(`/decisions/${id}/comparables`), enabled, ...STRATEGY_QUERY });
export const usePlaybooks = (f: { limit: number; offset: number }) => useQuery({ queryKey: ["playbooks", f], queryFn: () => getSessionRoute<PlaybookList>(`/intelligence/playbooks${qs(f)}`), placeholderData: (prev) => prev, ...STRATEGY_QUERY });
export const usePlaybook = (id: string) => useQuery({ queryKey: ["playbook", id], queryFn: () => getSessionRoute<PlaybookDetail>(`/intelligence/playbooks/${id}`), ...STRATEGY_QUERY });
