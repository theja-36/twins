/**
 * Browser API client. It talks ONLY to this app's own origin (/api/...), never to the backend. The session token is an HttpOnly cookie the page cannot read;
 * the only readable cookie is the CSRF double-submit token. Nothing is ever stored in localStorage or sessionStorage.
 */
import { ApiError } from "@/state/dataState";

function readCsrf(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) { const [k, ...v] = part.trim().split("="); if (k === "__Host-twins_csrf" || k === "twins_csrf") return v.join("="); }
  return null;
}
async function parse(res: Response): Promise<unknown> { const t = await res.text(); try { return t ? JSON.parse(t) : null; } catch { return null; } }
export async function apiFetch<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET", headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") { const c = readCsrf(); if (c) headers["x-csrf-token"] = c; if (init.body !== undefined) headers["content-type"] = "application/json"; }
  let res: Response;
  try { res = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store", ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }); }
  catch { throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "network unavailable"); }
  const body = await parse(res);
  if (!res.ok) { const b = (body ?? {}) as { error?: string; message?: string; reasons?: string[] }; throw new ApiError(res.status, b.error ?? "INTERNAL", b.message ?? "request failed", b.reasons ?? []); }
  return body as T;
}
export const getSessionRoute = <T,>(path: string): Promise<T> => apiFetch<T>(`/api/session${path}`);
