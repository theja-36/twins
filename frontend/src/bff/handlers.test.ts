import { afterEach, describe, expect, it } from "vitest";
import { ADMIN, CSRF, ORIGIN, TOKEN, USER, cfgDev, cfgHost, counters, fakeFetch, get, post, sessionCookie, setCookies, devCookie } from "@/test/helpers";
import { login, logout, me, relay, serverSession } from "./handlers";

const LOGIN_OK = { token: TOKEN, expiresAt: "2031-01-06T13:00:00.000Z", user: { ...USER, extra: "must not pass" } };
const okLogin = () => fakeFetch(() => ({ status: 200, body: LOGIN_OK }));
afterEach(() => { delete process.env["TWINS_API_KEY"]; });

describe("POST /api/auth/login", () => {
  it("success: sets an HttpOnly Strict session cookie and a readable CSRF cookie, returns the user only (no token), strips undeclared fields", async () => {
    const f = okLogin(), res = await login(post("/api/auth/login", { email: " Trader@Example.test ", password: "pw" }), { cfg: cfgHost(), fetcher: f.fetcher, ...counters() });
    expect(res.status).toBe(200);
    const body = await res.json(); expect(body).toEqual({ user: USER }); expect(JSON.stringify(body)).not.toContain("tws_");
    const cookies = setCookies(res), session = cookies.find((c) => c.startsWith("__Host-twins_session="))!, csrf = cookies.find((c) => c.startsWith("__Host-twins_csrf="))!;
    expect(session).toContain(TOKEN); for (const a of ["HttpOnly", "Secure", "SameSite=strict", "Path=/"]) expect(session).toMatch(new RegExp(a, "i")); expect(session).not.toMatch(/Domain=/i);
    expect(csrf).not.toMatch(/HttpOnly/i); expect(csrf).toMatch(/Secure/i); expect(csrf).toMatch(/SameSite=strict/i);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(JSON.parse(f.seen[0]!.body!)).toEqual({ email: "trader@example.test", password: "pw" }); // email normalised; nothing else forwarded
  });
  it("dev mode uses plain cookie names and no Secure flag (http://localhost)", async () => {
    const res = await login(post("/api/auth/login", { email: "a@b.test", password: "x" }), { cfg: cfgDev(), fetcher: okLogin().fetcher, ...counters() });
    const s = setCookies(res).find((c) => c.startsWith("twins_session="))!; expect(s).toMatch(/HttpOnly/i); expect(s).not.toMatch(/Secure/i);
  });
  it("fails CLOSED on origin: a missing Origin, a foreign Origin or a cross-site fetch is refused before the backend is contacted", async () => {
    const cases: Array<Record<string, string>> = [{ origin: "" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site", origin: ORIGIN }, { "sec-fetch-site": "cross-site" }];
    for (const h of cases) {
      const headers: Record<string, string> = { "content-type": "application/json", ...h }; if (h["origin"] === "") delete headers["origin"];
      const f = okLogin(), r = new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ email: "a@b.test", password: "x" }) });
      const res = await login(r, { cfg: cfgHost(), fetcher: f.fetcher, ...counters() }); expect(res.status, JSON.stringify(h)).toBe(403); expect(f.seen).toHaveLength(0);
    }
  });
  it("validates the body strictly: unknown fields, wrong types, non-JSON and oversized bodies are refused (422) without contacting the backend", async () => {
    const f = okLogin(), d = { cfg: cfgHost(), fetcher: f.fetcher, ...counters() };
    for (const b of [{ email: "a@b.test", password: "x", role: "ADMIN" }, { email: "a@b.test" }, { email: 5, password: "x" }, "not json", { email: "a@b.test", password: "x".repeat(2000) }, { email: "a".repeat(300), password: "x" }]) expect((await login(post("/api/auth/login", b), d)).status, JSON.stringify(b).slice(0, 40)).toBe(422);
    expect((await login(new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" }), d)).status).toBe(422);
    expect(f.seen).toHaveLength(0);
  });
  it("wrong credentials and a lockout look IDENTICAL to the browser (neutral 401, no cookie)", async () => {
    const out: Array<[number, unknown, string[]]> = [];
    for (const status of [401, 403]) { const f = fakeFetch(() => ({ status, body: { error: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", message: status === 401 ? "invalid credentials" : "too many attempts, try again later", reasons: [] } })); const r = await login(post("/api/auth/login", { email: "a@b.test", password: "x" }), { cfg: cfgHost(), fetcher: f.fetcher, ...counters() }); out.push([r.status, await r.json(), setCookies(r)]); }
    expect(out[0]).toEqual(out[1]); expect(out[0]![0]).toBe(401); expect(out[0]![2]).toEqual([]); expect(JSON.stringify(out[0]![1])).not.toMatch(/credentials|too many|locked/i);
  });
  it("per-source throttle: after 5 failures for one source+email the 6th is refused WITHOUT reaching the backend; another source is unaffected", async () => {
    const c = counters(), f = fakeFetch(() => ({ status: 401, body: { error: "UNAUTHENTICATED", message: "invalid credentials", reasons: [] } })), mk = (ip: string) => post("/api/auth/login", { email: "a@b.test", password: "x" }, { "x-forwarded-for": ip });
    const d = { cfg: cfgHost(), fetcher: f.fetcher, ...c };
    for (let i = 0; i < 5; i++) expect((await login(mk("203.0.113.1"), d)).status).toBe(401);
    expect(f.seen).toHaveLength(5); const blocked = await login(mk("203.0.113.1"), d); expect(blocked.status).toBe(429); expect(f.seen).toHaveLength(5);
    expect((await login(mk("203.0.113.2"), d)).status).toBe(401); // a different source can still try (the backend's own per-email lockout is separate)
  });
  it("overall attempts per source are capped too", async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: "UNAUTHENTICATED", message: "x", reasons: [] } })), c = counters(); let last = 0;
    for (let i = 0; i < 31; i++) last = (await login(post("/api/auth/login", { email: `u${i}@b.test`, password: "x" }, { "x-forwarded-for": "198.51.100.7" }), { cfg: cfgHost(), fetcher: f.fetcher, ...c })).status;
    expect(last).toBe(429);
  });
  it("a backend outage is a neutral 503; a malformed backend answer is a neutral 502 and sets no cookie", async () => {
    const down = await login(post("/api/auth/login", { email: "a@b.test", password: "x" }), { cfg: cfgHost(), fetcher: fakeFetch(() => new Error("ECONNREFUSED")).fetcher, ...counters() }); expect(down.status).toBe(503);
    const bad = await login(post("/api/auth/login", { email: "a@b.test", password: "x" }), { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 200, body: { token: "not-a-token", expiresAt: "x", user: USER } })).fetcher, ...counters() }); expect(bad.status).toBe(502); expect(setCookies(bad)).toEqual([]);
  });
  it("sends ONLY accept/content-type to the backend: no browser header, no cookie, no service key", async () => {
    process.env["TWINS_API_KEY"] = "SERVICE-KEY-VALUE"; const f = okLogin();
    await login(post("/api/auth/login", { email: "a@b.test", password: "x" }, { cookie: sessionCookie, "x-api-key": "k", authorization: "Bearer browser" }), { cfg: cfgHost(), fetcher: f.fetcher, ...counters() });
    expect(Object.keys(f.seen[0]!.headers).sort()).toEqual(["accept", "content-type"]); expect(JSON.stringify(f.seen)).not.toContain("SERVICE-KEY-VALUE");
  });
});

describe("POST /api/auth/logout", () => {
  const h = { cookie: sessionCookie, "x-csrf-token": CSRF };
  it("requires same-origin AND the CSRF token; refused otherwise, nothing cleared, backend not contacted", async () => {
    const f = fakeFetch(() => ({ status: 204 }));
    const bad: Array<Record<string, string>> = [{ cookie: sessionCookie }, { cookie: sessionCookie, "x-csrf-token": "C".repeat(43) }, { "x-csrf-token": CSRF }];
    for (const hh of bad) { const res = await logout(post("/api/auth/logout", {}, hh), { cfg: cfgHost(), fetcher: f.fetcher }); expect(res.status).toBe(403); expect(setCookies(res)).toEqual([]); }
    expect((await logout(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: h }), { cfg: cfgHost(), fetcher: f.fetcher })).status).toBe(403); // no Origin
    expect(f.seen).toHaveLength(0);
  });
  it("ends the backend session with the token and clears both cookies", async () => {
    const f = fakeFetch(() => ({ status: 204 })), res = await logout(post("/api/auth/logout", {}, h), { cfg: cfgHost(), fetcher: f.fetcher });
    expect(res.status).toBe(204); expect(f.seen[0]).toMatchObject({ url: "http://api.invalid:3000/auth/logout", method: "POST" }); expect(f.seen[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    const c = setCookies(res); expect(c.some((x) => x.startsWith("__Host-twins_session=;") || /__Host-twins_session=; /.test(x))).toBe(true); expect(c.every((x) => /Max-Age=0/i.test(x))).toBe(true);
  });
  it("clears the cookies even when the backend is unreachable", async () => {
    const res = await logout(post("/api/auth/logout", {}, h), { cfg: cfgHost(), fetcher: fakeFetch(() => new Error("down")).fetcher }); expect(res.status).toBe(204); expect(setCookies(res).length).toBe(2);
  });
});

describe("GET /api/auth/me", () => {
  it("no cookie: 401 without contacting the backend", async () => { const f = fakeFetch(() => ({ status: 200, body: { user: USER } })); const r = await me(get("/api/auth/me"), { cfg: cfgHost(), fetcher: f.fetcher }); expect(r.status).toBe(401); expect(f.seen).toHaveLength(0); });
  it("a backend 401 ends the session: cookies cleared", async () => {
    const r = await me(get("/api/auth/me", { cookie: sessionCookie }), { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 401, body: { error: "UNAUTHENTICATED", message: "x", reasons: [] } })).fetcher });
    expect(r.status).toBe(401); expect(setCookies(r).length).toBe(2); expect(setCookies(r).every((x) => /Max-Age=0/i.test(x))).toBe(true);
  });
  it("returns the declared user fields only (an ADMIN stays an ADMIN; extra fields are stripped); never the token", async () => {
    const r = await me(get("/api/auth/me", { cookie: sessionCookie }), { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 200, body: { user: { ...ADMIN, passwordHash: "x" } } })).fetcher }); const b = await r.json();
    expect(b).toEqual({ user: ADMIN }); expect(JSON.stringify(b)).not.toMatch(/passwordHash|tws_/);
  });
  it("a malformed backend answer is a neutral 502; an outage is a neutral 503", async () => {
    expect((await me(get("/api/auth/me", { cookie: sessionCookie }), { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 200, body: { user: { id: 1 } } })).fetcher })).status).toBe(502);
    expect((await me(get("/api/auth/me", { cookie: sessionCookie }), { cfg: cfgHost(), fetcher: fakeFetch(() => new Error("x")).fetcher })).status).toBe(503);
  });
  it("issues a CSRF cookie when the session has none (e.g. a second tab)", async () => {
    const r = await me(get("/api/auth/me", { cookie: `__Host-twins_session=${TOKEN}` }), { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 200, body: { user: USER } })).fetcher }); expect(setCookies(r).some((c) => c.startsWith("__Host-twins_csrf="))).toBe(true);
    const r2 = await me(get("/api/auth/me", { cookie: sessionCookie }), { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 200, body: { user: USER } })).fetcher }); expect(setCookies(r2)).toEqual([]);
  });
});

describe("GET /api/session/* (allow-listed relay)", () => {
  const ID = "00000000-0000-4000-8000-000000000001", ACC = { id: ID, name: "paper", tradingMode: "paper", baseCurrency: "INR", isActive: true };
  const rel = (path: string, h: Record<string, string> = { cookie: sessionCookie }, method = "GET") => new Request(`${ORIGIN}/api/session${path}`, { method, headers: h });
  it("relays an allow-listed read with ONLY the Bearer token (no browser cookie, no service key), validated and stripped", async () => {
    process.env["TWINS_API_KEY"] = "SERVICE-KEY-VALUE"; const f = fakeFetch(() => ({ status: 200, body: { accounts: [{ ...ACC, secretField: "x" }], leak: "x" } }));
    const res = await relay(rel("/accounts", { cookie: sessionCookie, "x-api-key": "k", authorization: "Bearer browser" }), ["accounts"], { cfg: cfgHost(), fetcher: f.fetcher });
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ accounts: [ACC] }); expect(f.seen[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`); expect(Object.keys(f.seen[0]!.headers).sort()).toEqual(["accept", "authorization"]); expect(JSON.stringify(f.seen)).not.toContain("SERVICE-KEY-VALUE");
  });
  it("refuses every non-GET method with 405 and never contacts the backend", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) { const r = await relay(new Request(`${ORIGIN}/api/session/accounts`, { method: m, headers: { cookie: sessionCookie, origin: ORIGIN }, body: m === "POST" ? "{}" : null }), ["accounts"], { cfg: cfgHost(), fetcher: f.fetcher }); expect(r.status, m).toBe(405); expect(r.headers.get("allow")).toBe("GET"); }
    expect(f.seen).toHaveLength(0);
  });
  it("is not a proxy: unknown paths, platform routes, write actions and path tricks are 404 before any backend call", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    for (const p of [["health"], ["system", "config"], ["intelligence", "source"], ["paper", "state"], ["auth", "me"], ["admin", "users"], ["decisions", ID, "approve"], ["accounts", ".."], ["..", "accounts"], ["decisions", "not-a-uuid"], []]) expect((await relay(rel(`/${p.join("/")}`), p, { cfg: cfgHost(), fetcher: f.fetcher })).status, p.join("/")).toBe(404);
    expect(f.seen).toHaveLength(0);
  });
  it("validates the query against the catalogue before calling the backend", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} })); const d = { cfg: cfgHost(), fetcher: f.fetcher };
    expect((await relay(rel("/portfolio"), ["portfolio"], d)).status).toBe(422); expect((await relay(rel(`/portfolio?accountId=${ID}&userId=${ID}`), ["portfolio"], d)).status).toBe(422); expect(f.seen).toHaveLength(0);
    expect((await relay(rel(`/portfolio?accountId=${ID}`), ["portfolio"], d)).status).toBe(200); expect(f.seen[0]!.url).toBe(`http://api.invalid:3000/portfolio?accountId=${ID}`);
  });
  it("requires a session cookie; a backend 401 clears the session; error bodies pass through as fixed fields only", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} })); expect((await relay(rel("/accounts", {}), ["accounts"], { cfg: cfgHost(), fetcher: f.fetcher })).status).toBe(401); expect(f.seen).toHaveLength(0);
    const expired = await relay(rel("/accounts"), ["accounts"], { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 401, body: { error: "UNAUTHENTICATED", message: "x", reasons: [] } })).fetcher }); expect(expired.status).toBe(401); expect(setCookies(expired).length).toBe(2);
    const nf = await relay(rel(`/decisions/${ID}`), ["decisions", ID], { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [], stack: "SECRET TRACE" } })).fetcher });
    expect(nf.status).toBe(404); expect(await nf.json()).toEqual({ error: "NOT_FOUND", message: "not found", reasons: [] });
  });
  it("a schema failure (backend shape changed) is a neutral 502, never a partial render; an outage is a neutral 503", async () => {
    expect((await relay(rel("/accounts"), ["accounts"], { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 200, body: { accounts: [{ id: 1 }] } })).fetcher })).status).toBe(502);
    expect((await relay(rel("/accounts"), ["accounts"], { cfg: cfgHost(), fetcher: fakeFetch(() => new Error("x")).fetcher })).status).toBe(503);
  });
  it("dev-mode cookies work in dev mode only", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { accounts: [] } }));
    expect((await relay(rel("/accounts", { cookie: devCookie }), ["accounts"], { cfg: cfgDev(), fetcher: f.fetcher })).status).toBe(200);
    expect((await relay(rel("/accounts", { cookie: devCookie }), ["accounts"], { cfg: cfgHost(), fetcher: f.fetcher })).status).toBe(401);
  });
});

describe("serverSession (server components)", () => {
  it("returns the user, UNAUTHENTICATED for no/invalid session, UNAVAILABLE for an outage; never a token", async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { user: USER } }));
    expect(await serverSession(sessionCookie, { cfg: cfgHost(), fetcher: ok.fetcher })).toEqual({ user: USER });
    expect(await serverSession(null, { cfg: cfgHost(), fetcher: ok.fetcher })).toEqual({ error: "UNAUTHENTICATED" });
    expect(await serverSession(sessionCookie, { cfg: cfgHost(), fetcher: fakeFetch(() => ({ status: 401, body: null })).fetcher })).toEqual({ error: "UNAUTHENTICATED" });
    expect(await serverSession(sessionCookie, { cfg: cfgHost(), fetcher: fakeFetch(() => new Error("x")).fetcher })).toEqual({ error: "UNAVAILABLE" });
  });
});
