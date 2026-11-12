"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { AccountsResponse, MeResponse, PublicUser } from "@twins/api-contracts";
import { ApiError } from "@/state/dataState";
import { apiFetch, getSessionRoute } from "./client";

/** The session probe: polled every minute; a 401 ends the session (all cached data dropped, back to sign-in). */
export function useSession(initial: PublicUser) {
  const router = useRouter(), qc = useQueryClient();
  const q = useQuery({ queryKey: ["me"], queryFn: () => apiFetch<MeResponse>("/api/auth/me"), initialData: { user: initial }, refetchInterval: 60_000, retry: false });
  useEffect(() => { if (q.error instanceof ApiError && q.error.status === 401) { qc.clear(); router.replace("/login?expired=1"); } }, [q.error, qc, router]);
  return q.data.user;
}
export function useAccounts() { return useQuery({ queryKey: ["accounts"], queryFn: () => getSessionRoute<AccountsResponse>("/accounts") }); }
export async function signOut(): Promise<void> { try { await apiFetch<null>("/api/auth/logout", { method: "POST" }); } catch { /* the server clears the cookies even when the backend is unreachable; a failure here is shown by staying signed in */ throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "sign-out failed"); } }

// ── Stage 09.3A reads. Every hook reads through the BFF relay allow-list; none writes. Query strings carry only catalogue-declared keys. ──
import type { ApprovalsResponse, CandidateDetailResponse, CandidatesResponse, ChannelsResponse, DecisionsResponse, PositionsResponse, ResearchPackageAbsentResponse, ResearchPackageResponse, ScansResponse } from "@twins/api-contracts";
const qs = (o: Record<string, string | number | undefined>): string => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ""; };
const READ = { retry: false, staleTime: 15_000 } as const;
export function useCandidates(f: { source?: string; state?: string; limit: number; offset: number }) { return useQuery({ queryKey: ["candidates", f], queryFn: () => getSessionRoute<CandidatesResponse>(`/opportunities/candidates${qs(f)}`), placeholderData: (prev) => prev, ...READ }); }
export function useCandidate(id: string) { return useQuery({ queryKey: ["candidate", id], queryFn: () => getSessionRoute<CandidateDetailResponse>(`/opportunities/candidates/${id}`), ...READ }); }
export function useScans(limit = 5) { return useQuery({ queryKey: ["scans", limit], queryFn: () => getSessionRoute<ScansResponse>(`/opportunities/scans${qs({ limit })}`), ...READ }); }
export function useResearchPackage(candidateId: string) { return useQuery({ queryKey: ["research-package", candidateId], queryFn: () => getSessionRoute<ResearchPackageResponse | ResearchPackageAbsentResponse>(`/research/candidates/${candidateId}/package`), ...READ }); }
export function useChannels(limit = 50) { return useQuery({ queryKey: ["channels", limit], queryFn: () => getSessionRoute<ChannelsResponse>(`/intelligence/channels${qs({ limit })}`), ...READ }); }
/** Trader-only (private routes): an ADMIN would receive 404, so callers pass `enabled: false` for them. */
export function useApprovals(enabled = true) { return useQuery({ queryKey: ["approvals"], queryFn: () => getSessionRoute<ApprovalsResponse>("/approvals"), enabled, ...READ }); }
export function useDecisions(limit: number, enabled = true) { return useQuery({ queryKey: ["decisions", limit], queryFn: () => getSessionRoute<DecisionsResponse>(`/decisions${qs({ limit })}`), enabled, ...READ }); }
export function useOpenPositions(limit = 10, enabled = true) { return useQuery({ queryKey: ["positions", "OPEN", limit], queryFn: () => getSessionRoute<PositionsResponse>(`/execution/positions${qs({ status: "OPEN", limit })}`), enabled, ...READ }); }
