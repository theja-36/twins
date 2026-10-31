import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { advisoryExpiry, computeChecksum, describeKiteConfig, KiteClient, KiteError, loadKiteConfig, loginUrl, RateLimiter, redact, Session } from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, API_KEY, API_SECRET, REQUEST_TOKEN, clientWith, fakeFetch, instantClock, json, ok } from "./helpers";

const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: unknown) => (e instanceof KiteError ? e.code : `other:${String(e)}`));

describe("session exchange", () => {
  it("builds the official login URL and the documented SHA-256 checksum", () => {
    expect(loginUrl(API_KEY)).toBe(`https://kite.zerodha.com/connect/login?v=3&api_key=${API_KEY}`);
    expect(computeChecksum(API_KEY, REQUEST_TOKEN, API_SECRET)).toBe(createHash("sha256").update(`${API_KEY}${REQUEST_TOKEN}${API_SECRET}`).digest("hex"));
  });
  it("POSTs only /session/token with api_key, request_token and checksum (no Authorization), and stores the token as UNVERIFIED", async () => {
    const { client, session, calls } = clientWith([ok({ access_token: ACCESS_TOKEN, api_key: API_KEY })]);
    await client.exchangeRequestToken(REQUEST_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.kite.trade/session/token");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["X-Kite-Version"]).toBe("3");
    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(Object.fromEntries(form)).toEqual({ api_key: API_KEY, request_token: REQUEST_TOKEN, checksum: computeChecksum(API_KEY, REQUEST_TOKEN, API_SECRET) });
    expect(session.state().status).toBe("unverified"); // a token in hand is not a verified session
  });
  it("a refused, malformed or mismatched exchange stores nothing", async () => {
    for (const res of [json({ status: "error", error_type: "TokenException", message: "bad" }, 403), ok({}), ok({ access_token: "short" }), ok({ access_token: ACCESS_TOKEN, api_key: "someoneelse" }), ok(null)]) {
      const { client, session } = clientWith([res]);
      expect(await code(client.exchangeRequestToken(REQUEST_TOKEN))).toBe("AUTH_FAILED");
      expect(session.state().status).toBe("none");
    }
  });
  it("rejects a request_token with an odd shape before any request, and needs the secret", async () => {
    const { client, calls } = clientWith([]);
    expect(await code(client.exchangeRequestToken("../etc"))).toBe("CONFIG");
    const noSecret = clientWith([], { apiSecret: undefined as unknown as string });
    expect(await code(noSecret.client.exchangeRequestToken(REQUEST_TOKEN))).toBe("CONFIG");
    expect(calls).toHaveLength(0);
    expect(noSecret.calls).toHaveLength(0);
  });
});

describe("server-side validity (never inferred)", () => {
  it("sends nothing without a session", async () => {
    const { client, calls } = clientWith([]);
    expect(await code(client.getJson("/quote", { i: "NSE:INFY" }))).toBe("NO_SESSION");
    expect(calls).toHaveLength(0);
  });
  it("a token that looks right and whose advisory expiry is in the future is still only 'unverified'; the SERVER verifies it", async () => {
    const { client, session, calls } = clientWith([ok({ user_id: "AB1234" })]);
    session.setToken(ACCESS_TOKEN);
    expect(advisoryExpiry(new Date("2026-11-02T04:00:00Z")).toISOString()).toBe("2026-11-03T00:30:00.000Z"); // 06:00 IST
    expect(session.state().status).toBe("unverified");
    await client.verifySession();
    expect(calls[0]?.url).toBe("https://api.kite.trade/user/profile");
    expect(session.state().status).toBe("verified");
  });
  it("an 'expired-looking' token is still sent: only the server decides", async () => {
    const { client, session, calls } = clientWith([ok([])]);
    session.setToken(ACCESS_TOKEN);
    await client.getJson("/quote/ltp", { i: "NSE:INFY" });
    expect(calls).toHaveLength(1);
  });
  it("a server TokenException / 403 invalidates the session, drops the token, and later calls send nothing until a new exchange", async () => {
    const { client, session, calls } = clientWith([json({ status: "error", error_type: "TokenException", message: `Incorrect api_key or access_token ${ACCESS_TOKEN}` }, 403), ok({ access_token: `${ACCESS_TOKEN}2`, api_key: API_KEY }), ok([])]);
    session.setToken(ACCESS_TOKEN);
    await client.verifySession().then(() => undefined, () => undefined);
    expect(session.state()).toMatchObject({ status: "invalid", reason: "server_rejected" });
    expect(session.usableToken()).toBeUndefined();
    expect(await code(client.getJson("/quote", { i: "x" }))).toBe("SESSION_INVALID");
    expect(calls).toHaveLength(1);
    await client.exchangeRequestToken(REQUEST_TOKEN);
    expect(session.state().status).toBe("unverified");
    await client.getJson("/quote/ltp", { i: "x" });
    expect(calls).toHaveLength(3);
  });
  it("a verified session is demoted the moment the server rejects it", async () => {
    const { client, session } = clientWith([ok({}), json({ status: "error", error_type: "TokenException", message: "x" }, 403)]);
    session.setToken(ACCESS_TOKEN);
    await client.verifySession();
    expect(session.state().status).toBe("verified");
    expect(await code(client.getJson("/quote", { i: "x" }))).toBe("SESSION_INVALID");
    expect(session.state().status).toBe("invalid");
  });
});

describe("requests and error handling", () => {
  it("sends the documented headers, query parameters (repeated i=), no redirects, and a timeout signal", async () => {
    const { client, session, calls } = clientWith([ok({})]);
    session.setToken(ACCESS_TOKEN);
    await client.getJson("/quote", { i: ["NSE:NIFTY 50", "BSE:SENSEX"] });
    const call = calls[0];
    expect(call?.url).toBe("https://api.kite.trade/quote?i=NSE%3ANIFTY+50&i=BSE%3ASENSEX");
    expect(call?.init.headers).toMatchObject({ "X-Kite-Version": "3", Authorization: `token ${API_KEY}:${ACCESS_TOKEN}` });
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });
  it("refuses a non-allowlisted request BEFORE the limiter or fetch, even with a valid session", async () => {
    const { client, session, calls } = clientWith([]);
    session.setToken(ACCESS_TOKEN);
    for (const p of ["/orders/regular", "/portfolio/positions", "/gtt/triggers"]) expect(await code(client.getJson(p))).toBe("NOT_ALLOWED");
    expect(calls).toHaveLength(0);
  });
  it("maps statuses to fixed codes; server text is redacted and never in the message", async () => {
    const cases: Array<[Response, string]> = [
      [json({ status: "error", error_type: "InputException", message: "bad" }, 400), "BAD_REQUEST"],
      [json({ status: "error", error_type: "NetworkException", message: "x" }, 503), "SERVER_ERROR"],
      [new Response("<html>", { status: 502 }), "SERVER_ERROR"],
      [json({ status: "error", message: "slow down" }, 429), "RATE_LIMITED"],
      [new Response("not json", { status: 200 }), "MALFORMED_RESPONSE"],
      [json({ status: "error", message: "x" }, 200), "MALFORMED_RESPONSE"],
      [json({ nodata: true }, 200), "MALFORMED_RESPONSE"],
    ];
    for (const [res, expected] of cases) {
      const { client, session } = clientWith([res]);
      session.setToken(ACCESS_TOKEN);
      expect(await code(client.getJson("/quote", { i: "x" }))).toBe(expected);
    }
    const { client, session } = clientWith([json({ status: "error", error_type: "InputException", message: `api_key=${API_KEY} access_token=${ACCESS_TOKEN} leaked ${API_SECRET}` }, 400)]);
    session.setToken(ACCESS_TOKEN);
    const err = await client.getJson("/quote").catch((e: unknown) => e as KiteError);
    expect(err.message).toBe("Kite rejected the request");
    const dump = JSON.stringify({ m: err.message, d: err.detail });
    for (const s of [ACCESS_TOKEN, API_SECRET]) expect(dump).not.toContain(s);
  });
  it("maps fetch failures and timeouts", async () => {
    const t = Object.assign(new Error("t"), { name: "TimeoutError" });
    for (const [e, expected] of [[new TypeError("fetch failed"), "NETWORK"], [t, "TIMEOUT"]] as const) {
      const { client, session } = clientWith([e]);
      session.setToken(ACCESS_TOKEN);
      expect(await code(client.getJson("/quote", { i: "x" }))).toBe(expected);
    }
  });
  it("bounds response size", async () => {
    const { client, session } = clientWith([new Response("x".repeat(50))], { maxBytes: 10 });
    session.setToken(ACCESS_TOKEN);
    expect(await code(client.getText("/instruments"))).toBe("RESPONSE_TOO_LARGE");
  });
  it("getText returns the CSV; a JSON error where a CSV was expected is an error", async () => {
    const a = clientWith([new Response("a,b\n1,2\n", { status: 200 })]);
    a.session.setToken(ACCESS_TOKEN);
    expect(await a.client.getText("/instruments/NFO")).toBe("a,b\n1,2\n");
    const b = clientWith([json({ status: "error", error_type: "TokenException", message: "x" }, 200)]);
    b.session.setToken(ACCESS_TOKEN);
    expect(await code(b.client.getText("/instruments"))).toBe("SESSION_INVALID");
  });
  it("only the production host (or loopback for tests) is accepted as base URL", () => {
    const s = new Session();
    for (const bad of ["https://api.kite.trade.evil.com", "http://api.kite.trade", "https://example.com", "http://10.0.0.1"]) expect(() => new KiteClient({ apiKey: API_KEY, session: s, baseUrl: bad })).toThrow(KiteError);
    expect(() => new KiteClient({ apiKey: API_KEY, session: s, baseUrl: "http://127.0.0.1:9" })).not.toThrow();
  });
  it("makes no real network call when a fake fetch is supplied (and the test network guard is active)", async () => {
    const { fetch: f, calls } = fakeFetch([ok({})]);
    const session = new Session();
    session.setToken(ACCESS_TOKEN);
    await new KiteClient({ apiKey: API_KEY, session, fetch: f, limiter: new RateLimiter(instantClock()) }).getJson("/user/profile");
    expect(calls).toHaveLength(1);
  });
});

describe("rate limiting", () => {
  it("spaces quote calls 1000 ms, historical ~334 ms and default 100 ms, per class, even when issued concurrently", async () => {
    const clock = instantClock();
    const limiter = new RateLimiter(clock);
    await Promise.all([limiter.acquire("quote"), limiter.acquire("quote"), limiter.acquire("quote")]);
    expect(clock.sleeps).toEqual([1000, 1000]);
    const c2 = instantClock();
    const l2 = new RateLimiter(c2);
    await Promise.all([l2.acquire("historical"), l2.acquire("historical")]);
    expect(c2.sleeps[0]).toBeCloseTo(1000 / 3, 0);
    const c3 = instantClock();
    const l3 = new RateLimiter(c3);
    await Promise.all([l3.acquire("default"), l3.acquire("default")]);
    expect(c3.sleeps).toEqual([100]);
  });
  it("classes do not block each other", async () => {
    const clock = instantClock();
    const l = new RateLimiter(clock);
    await l.acquire("quote");
    await l.acquire("default");
    expect(clock.sleeps).toEqual([]);
  });
});

describe("configuration and redaction", () => {
  it("validates variable shapes without echoing values, and describes presence only", () => {
    const env = { TWINS_KITE_API_KEY: API_KEY, TWINS_KITE_API_SECRET: API_SECRET };
    expect(loadKiteConfig(env)).toEqual({ apiKey: API_KEY, apiSecret: API_SECRET });
    expect(describeKiteConfig(env)).toEqual({ TWINS_KITE_API_KEY: "set", TWINS_KITE_API_SECRET: "set", TWINS_KITE_ACCESS_TOKEN: "unset" });
    for (const bad of [{}, { TWINS_KITE_API_KEY: "x y" }, { TWINS_KITE_API_KEY: API_KEY, TWINS_KITE_API_SECRET: "bad secret!" }, { TWINS_KITE_API_KEY: API_KEY, TWINS_KITE_ACCESS_TOKEN: "short" }]) {
      const err = (() => { try { loadKiteConfig(bad); } catch (e) { return e as KiteError; } return undefined; })();
      expect(err?.code).toBe("CONFIG");
      expect(JSON.stringify(err?.detail) + err?.message).not.toContain(API_SECRET);
    }
  });
  it("redacts known secrets and credential-keyed fragments, and bounds length", () => {
    const text = `Authorization: token ${API_KEY}:${ACCESS_TOKEN}; "access_token": "${ACCESS_TOKEN}" checksum=abcdef0123456789 ${REQUEST_TOKEN}`;
    const r = redact(text, [ACCESS_TOKEN, REQUEST_TOKEN], 500);
    for (const s of [ACCESS_TOKEN, REQUEST_TOKEN, "abcdef0123456789"]) expect(r).not.toContain(s);
    expect(redact("x".repeat(500)).length).toBeLessThan(210);
  });
});
