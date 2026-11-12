/**
 * The one place the BFF talks to the TWINS API (a private-network address). It sends ONLY: the session token as a Bearer header, JSON content type, and (for the few
 * write routes) a body the BFF built itself. It never forwards a browser header or cookie, never sends the shared service key, never follows a redirect, and bounds time and size.
 */
import type { BffConfig } from "./config";

export const UPSTREAM_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export interface UpstreamResult { status: number; json: unknown | null; networkError: boolean }
export type Fetcher = typeof fetch;

export async function callUpstream(cfg: BffConfig, path: string, o: { method?: "GET" | "POST"; token?: string | null; body?: unknown; fetcher?: Fetcher } = {}): Promise<UpstreamResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await (o.fetcher ?? fetch)(`${cfg.apiBase}${path}`, { method: o.method ?? "GET", headers, body: o.body === undefined ? null : JSON.stringify(o.body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (res.status === 204) return { status: 204, json: null, networkError: false };
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return { status: 502, json: null, networkError: false };
    let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { return { status: res.status >= 400 ? res.status : 502, json: null, networkError: false }; }
    return { status: res.status, json, networkError: false };
  } catch { return { status: 503, json: null, networkError: true }; }
}
