"use client";
/**
 * Research reads (shared intelligence, GET only, through the authenticated relay). A package never changes once stored and the registry is static metadata, so reads are cached for minutes;
 * nothing polls and nothing refetches on focus. The package request is made once per opened candidate: there is no per-row package request anywhere.
 */
import { useQuery } from "@tanstack/react-query";
import { getSessionRoute } from "./client";
import type { AgentRegistry, ResearchResponse } from "./researchTypes";

export const RESEARCH_QUERY = { staleTime: 5 * 60_000, gcTime: 30 * 60_000, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false } as const;
export const useResearchWorkspace = (candidateId: string) => useQuery({ queryKey: ["research", "package", candidateId], queryFn: () => getSessionRoute<ResearchResponse>(`/research/candidates/${candidateId}/package`), ...RESEARCH_QUERY });
export const useAgentRegistry = () => useQuery({ queryKey: ["research", "agents"], queryFn: () => getSessionRoute<AgentRegistry>("/research/agents"), ...RESEARCH_QUERY });
