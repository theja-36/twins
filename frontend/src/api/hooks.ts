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
