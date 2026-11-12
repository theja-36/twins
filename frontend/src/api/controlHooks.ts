"use client";
/**
 * Paper-trading and portfolio reads (GET only, through the authenticated relay; private to the trader, an ADMIN receives 404 so screens are never mounted for one).
 * Orders and positions take only `limit` (1 to 200) and, respectively, `status`: there is NO account filter, NO offset, NO total, so a response is "the latest N" and never a complete history.
 * Fills and events are requested only for the one row the reader opens. Nothing polls and nothing refetches on focus.
 */
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useAccounts } from "./hooks";
import { getSessionRoute } from "./client";
import type { FillsResponse, OrdersResponse, PortfolioResponse, PositionEventsResponse, PositionsResponse } from "./controlTypes";

export const CONTROL_QUERY = { staleTime: 30_000, gcTime: 10 * 60_000, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false } as const;
/** The backend's own maximum for `limit` on both lists. */
export const PAPER_LIST_LIMIT = 200;
const qs = (o: Record<string, string | number | undefined>): string => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ""; };

export const usePortfolio = (accountId: string) => useQuery({ queryKey: ["portfolio", accountId], queryFn: () => getSessionRoute<PortfolioResponse>(`/portfolio${qs({ accountId })}`), enabled: accountId !== "", ...CONTROL_QUERY });
export const usePaperOrders = (f: { status?: string }) => useQuery({ queryKey: ["paper-orders", f], queryFn: () => getSessionRoute<OrdersResponse>(`/execution/orders${qs({ ...f, limit: PAPER_LIST_LIMIT })}`), ...CONTROL_QUERY });
export const usePaperPositions = (f: { status?: "OPEN" | "CLOSED" }, enabled = true) => useQuery({ queryKey: ["paper-positions", f], enabled, queryFn: () => getSessionRoute<PositionsResponse>(`/execution/positions${qs({ ...f, limit: PAPER_LIST_LIMIT })}`), ...CONTROL_QUERY });
export const useOrderFills = (orderId: string | null) => useQuery({ queryKey: ["paper-fills", orderId], queryFn: () => getSessionRoute<FillsResponse>(`/execution/orders/${orderId}/fills`), enabled: orderId !== null, ...CONTROL_QUERY });
export const usePositionEvents = (positionId: string | null) => useQuery({ queryKey: ["paper-events", positionId], queryFn: () => getSessionRoute<PositionEventsResponse>(`/execution/positions/${positionId}/events`), enabled: positionId !== null, ...CONTROL_QUERY });
/** Orders of one decision (the route's own `decisionId` filter; still the latest N). */
export const useDecisionOrders = (decisionId: string, enabled: boolean) => useQuery({ queryKey: ["paper-orders-decision", decisionId], queryFn: () => getSessionRoute<OrdersResponse>(`/execution/orders${qs({ decisionId, limit: PAPER_LIST_LIMIT })}`), enabled, ...CONTROL_QUERY });

/** The account chosen in the topbar (`?account=`), or the first account, exactly as the switcher shows it. */
export function useSelectedAccount() {
  const params = useSearchParams(), q = useAccounts(), accounts = q.data?.accounts ?? [], chosen = params.get("account");
  const account = accounts.find((a) => a.id === chosen) ?? accounts[0] ?? null;
  return { query: q, accounts, account, accountId: account?.id ?? "" };
}
