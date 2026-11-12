import { describe, expect, it } from "vitest";
import { BROWSER_ROUTES, EXCLUDED_PLATFORM_PREFIXES, EXCLUDED_PLATFORM_ROUTES, SESSION_ROUTE_CATALOGUE } from "@twins/api-contracts";
import { WRITES_ENABLED, checkQuery, matchRoute, relayedRoutes } from "./allowlist";

const ID = "00000000-0000-4000-8000-000000000001";
describe("relay allow-list (generated from the browser-safe catalogue)", () => {
  it("writes are not relayed in Stage 09.2; every relayed route is a GET read from the catalogue", () => {
    expect(WRITES_ENABLED).toBe(false);
    for (const e of relayedRoutes()) { expect(e.method).toBe("GET"); expect(BROWSER_ROUTES).toContain(e); expect(e.scope === "PRIVATE" || e.scope === "SHARED").toBe(true); }
    expect(relayedRoutes().length).toBe(18 - 5 /* private POSTs */ + 11 + 17);
  });
  it("auth and admin routes are never relayed (the BFF owns auth; admin has no browser UI)", () => {
    for (const e of SESSION_ROUTE_CATALOGUE.filter((x) => x.scope === "PUBLIC" || x.scope === "SESSION" || x.scope === "ADMIN_ROLE")) expect(matchRoute(e.method, e.path), e.id).toBeNull();
    expect(matchRoute("POST", "/auth/login")).toBeNull(); expect(matchRoute("GET", "/auth/me")).toBeNull(); expect(matchRoute("POST", "/admin/users")).toBeNull();
  });
  it("write actions are refused until their screen stage", () => { for (const v of ["approve", "reject", "cancel", "watch", "unwatch"]) expect(matchRoute("POST", `/decisions/${ID}/${v}`), v).toBeNull(); });
  it("platform (shared service key) routes can never match", () => {
    for (const p of [...EXCLUDED_PLATFORM_ROUTES.map((x) => x.replace(":id", ID)), ...EXCLUDED_PLATFORM_PREFIXES.map((x) => `${x}anything`)]) expect(matchRoute("GET", p), p).toBeNull();
    for (const p of ["/health", "/system/config", "/intelligence/source", "/paper/state", "/telegram/status", "/market/regime", "/notifications"]) expect(matchRoute("GET", p), p).toBeNull();
  });
  it("matches catalogue reads with a UUID id and rejects anything else", () => {
    expect(matchRoute("GET", `/decisions/${ID}`)?.entry.id).toBe("decisions.get"); expect(matchRoute("GET", "/accounts")?.entry.id).toBe("accounts.list"); expect(matchRoute("GET", `/execution/positions/${ID}/events`)?.entry.id).toBe("positions.events");
    for (const p of ["/decisions/not-a-uuid", `/decisions/${ID}/extra`, "/decisions/../accounts", `/decisions/${ID}%2F..`, "/accounts/", "//accounts", "/Accounts", "/accounts%00", "/analytics/overview/..", ""]) expect(matchRoute("GET", p), p).toBeNull();
    expect(matchRoute("DELETE", "/accounts")).toBeNull(); expect(matchRoute("PUT", "/accounts")).toBeNull(); expect(matchRoute("HEAD", "/accounts")).toBeNull();
  });
  it("query keys must be exactly the entry's: required present, unknown refused, repeats refused, unsafe values refused", () => {
    const portfolio = matchRoute("GET", "/portfolio")!.entry, q = (s: string) => checkQuery(portfolio, new URLSearchParams(s));
    expect(q(`accountId=${ID}`)).toEqual({ ok: true, query: `?accountId=${ID}` }); expect(q("").ok).toBe(false); expect(q(`accountId=${ID}&x=1`).ok).toBe(false); expect(q(`accountId=${ID}&accountId=${ID}`).ok).toBe(false); expect(q("accountId=a/b").ok).toBe(false); expect(q("accountId=%0d%0a").ok).toBe(false);
    const decisions = matchRoute("GET", "/decisions")!.entry; expect(checkQuery(decisions, new URLSearchParams("state=PENDING&limit=20"))).toEqual({ ok: true, query: "?state=PENDING&limit=20" }); expect(checkQuery(decisions, new URLSearchParams("")).ok).toBe(true);
  });
});
