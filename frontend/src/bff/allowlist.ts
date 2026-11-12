/**
 * The relay allow-list: the ONLY backend routes a browser request can reach, generated from the browser-safe route catalogue (packages/api-contracts).
 * There is no generic proxy: method, path shape, query keys and query values are all matched against a catalogue entry, and anything else is refused here without contacting the backend.
 *
 * Stage 09.2 relays GET reads only. The write actions in the catalogue (approve, reject, cancel, watch, unwatch) are NOT relayed yet (WRITES_ENABLED = false):
 * they arrive with the Approval Center in Stage 09.3, together with their request validation and tests.
 * Platform (shared service key) routes are not in the catalogue and can never match.
 */
import { BROWSER_ROUTES, UUID_PATTERN, type RouteEntry } from "@twins/api-contracts";

export const WRITES_ENABLED = false;
const RELAYED: readonly RouteEntry[] = BROWSER_ROUTES.filter((e) => (e.scope === "PRIVATE" || e.scope === "SHARED") && (e.method === "GET" || WRITES_ENABLED));
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = RELAYED.map((entry) => ({ entry, re: new RegExp(`^${entry.path.split("/").map((seg) => (seg === ":id" ? "([0-9a-fA-F-]{36})" : escape(seg))).join("/")}$`) }));

export interface Match { entry: RouteEntry; params: string[] }
export function matchRoute(method: string, path: string): Match | null {
  if (method !== "GET" && !(WRITES_ENABLED && method === "POST")) return null;
  for (const { entry, re } of patterns) {
    if (entry.method !== method) continue;
    const m = re.exec(path); if (!m) continue;
    const params = m.slice(1); if (!params.every((p) => UUID_PATTERN.test(p))) return null;
    return { entry, params };
  }
  return null;
}
const VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Query keys must be exactly the entry's (required present, none unknown, none repeated) and values safe characters. Returns the rebuilt query string. */
export function checkQuery(entry: RouteEntry, search: URLSearchParams): { ok: true; query: string } | { ok: false } {
  const allowed = new Set([...entry.query.required, ...entry.query.optional]), seen = new Set<string>(), out = new URLSearchParams();
  for (const [k, v] of search) { if (!allowed.has(k) || seen.has(k) || !VALUE.test(v)) return { ok: false }; seen.add(k); out.set(k, v); }
  for (const r of entry.query.required) if (!seen.has(r)) return { ok: false };
  const q = out.toString(); return { ok: true, query: q ? `?${q}` : "" };
}
export const relayedRoutes = (): readonly RouteEntry[] => RELAYED;
