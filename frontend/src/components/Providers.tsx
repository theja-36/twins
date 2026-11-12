"use client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ToastProvider } from "@/ui/toast";
import { ThemeProvider } from "./ThemeProvider";

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: (n, e) => { const s = (e as { status?: number }).status; return !(s === 401 || s === 403 || s === 404 || s === 422) && n < 1; } } } });
}
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return <QueryClientProvider client={client}><ThemeProvider><ToastProvider>{children}</ToastProvider></ThemeProvider></QueryClientProvider>;
}
/**
 * Per-user cache isolation: when the signed-in user id changes (or the session ends), EVERYTHING cached for the previous user is dropped before any screen can read it.
 * The same applies at sign-out and session expiry (see useSession).
 */
export function UserCacheGuard({ userId }: { userId: string | null }) {
  const qc = useQueryClient(), prev = useRef<string | null | undefined>(undefined);
  useEffect(() => { if (prev.current !== undefined && prev.current !== userId) qc.clear(); prev.current = userId; }, [userId, qc]);
  return null;
}
