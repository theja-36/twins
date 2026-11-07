import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDhanOptionChainClient, DHAN_CHAIN_FILE, DHAN_HOST, DHAN_QUOTES_FILE, DhanClientError, DhanConfigError, loadDhanConfig, parseUnderlyings, runCli, runDhanOptionsPass } from "../../../scripts/ops/dhan-options-export";

// SYNTHETIC response in the ASSUMED Dhan shape; no real response and no real credential are used.
const leg = (o: Record<string, unknown> = {}) => ({ implied_volatility: 14.2, last_price: 120.5, oi: 90000, volume: 12000, top_bid_price: 120, top_ask_price: 121, greeks: { delta: 0.52, theta: -8.1, gamma: 0.0012, vega: 11.3 }, ...o });
const GOOD = { status: "success", data: { last_price: 24500, oc: { "24500.000000": { ce: leg(), pe: leg({ greeks: { delta: -0.48, theta: -7.9, gamma: 0.0012, vega: 11.3 } }) } } } };
const ENV_ON = { TWINS_DHAN_OPTIONS_ENABLED: "true", TWINS_DHAN_ACCESS_TOKEN: "TEST-TOKEN-VALUE-DO-NOT-LEAK", TWINS_DHAN_CLIENT_ID: "TEST-CLIENT-ID", TWINS_DHAN_UNDERLYINGS: "NIFTY:13:IDX_I" };
const NOW = () => new Date("2031-10-27T05:00:00Z");
const expiries = [{ underlying: "NIFTY", expiry: "2031-10-29" }];
const res = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("config: disabled unless everything is explicitly present", () => {
  it("defaults to disabled and never reads further", () => {
    expect(loadDhanConfig({})).toEqual({ enabled: false, reason: "disabled" });
    expect(loadDhanConfig({ TWINS_DHAN_OPTIONS_ENABLED: "false", TWINS_DHAN_ACCESS_TOKEN: "x", TWINS_DHAN_CLIENT_ID: "y" })).toEqual({ enabled: false, reason: "disabled" });
    expect(loadDhanConfig({ TWINS_DHAN_OPTIONS_ENABLED: "" })).toEqual({ enabled: false, reason: "disabled" });
  });
  it("enabled without credentials or underlyings stays disabled with a reason; bad flag values are errors", () => {
    expect(loadDhanConfig({ TWINS_DHAN_OPTIONS_ENABLED: "true" })).toEqual({ enabled: false, reason: "credentials_missing" });
    expect(loadDhanConfig({ TWINS_DHAN_OPTIONS_ENABLED: "true", TWINS_DHAN_ACCESS_TOKEN: "t", TWINS_DHAN_CLIENT_ID: "c" })).toEqual({ enabled: false, reason: "underlyings_missing" });
    expect(() => loadDhanConfig({ TWINS_DHAN_OPTIONS_ENABLED: "yes" })).toThrow(DhanConfigError);
    expect(loadDhanConfig(ENV_ON)).toMatchObject({ enabled: true, underlyings: [{ symbol: "NIFTY", scrip: 13, segment: "IDX_I" }] });
  });
  it("underlying ids are never guessed: malformed entries fail", () => {
    expect(parseUnderlyings("NIFTY:13:IDX_I, BANKNIFTY:25:IDX_I")).toHaveLength(2);
    for (const bad of ["NIFTY", "NIFTY:abc:IDX_I", "nifty:13:IDX_I", "", "A:1:B,".repeat(6)]) expect(() => parseUnderlyings(bad)).toThrow(DhanConfigError);
  });
});

describe("disabled means no network and no file", () => {
  it("a disabled pass never calls fetch and writes nothing", async () => {
    let calls = 0;
    const dir = mkdtempSync(join(tmpdir(), "dhan-"));
    for (const env of [{}, { TWINS_DHAN_OPTIONS_ENABLED: "true" }]) {
      const r = await runDhanOptionsPass({ env, providersDir: dir, now: NOW, expiries, fetchFn: (async () => { calls++; return res(GOOD); }) as typeof fetch });
      expect(r.status).toBe("skipped");
    }
    expect(calls).toBe(0);
    expect(existsSync(join(dir, DHAN_QUOTES_FILE))).toBe(false);
  });
  it("the CLI is a no-op when disabled and reports a fixed line", async () => {
    const out: string[] = [];
    expect(await runCli(["once", "--expiry", "NIFTY:2031-10-29"], { env: {}, out: (l) => out.push(l), err: () => undefined, fetchFn: (async () => { throw new Error("must not be called"); }) as typeof fetch })).toBe(0);
    expect(JSON.parse(out[0] as string)).toEqual({ event: "dhan_options.pass", status: "skipped", reason: "disabled" });
    expect(await runCli([], { env: {}, out: () => undefined, err: () => undefined })).toBe(2);
    expect(await runCli(["once", "--expiry", "bad"], { env: {}, out: () => undefined, err: () => undefined })).toBe(2);
  });
});

describe("client (host-pinned POST, fixed error codes)", () => {
  it("sends the assumed request to the pinned host only, with credentials in headers and never in the URL", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const call = createDhanOptionChainClient({ token: "T", clientId: "C", fetchFn: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return res(GOOD); }) as unknown as typeof fetch });
    await call({ underlying: { symbol: "NIFTY", scrip: 13, segment: "IDX_I" }, expiry: "2031-10-29" });
    expect(seen[0]?.url).toBe(`https://${DHAN_HOST}/v2/optionchain`);
    expect(seen[0]?.url).not.toContain("T");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.redirect).toBe("manual");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ UnderlyingScrip: 13, UnderlyingSeg: "IDX_I", Expiry: "2031-10-29" });
  });
  it("maps failures to fixed codes that never contain the token", async () => {
    const mk = (f: () => Promise<Response>) => createDhanOptionChainClient({ token: "SECRET-T", clientId: "C", fetchFn: f as unknown as typeof fetch });
    const u = { symbol: "NIFTY", scrip: 13, segment: "IDX_I" };
    const codes = async (f: () => Promise<Response>) => mk(f)({ underlying: u, expiry: "2031-10-29" }).then(() => "ok", (e: DhanClientError) => `${e.code}:${e.status ?? ""}:${e.message}`);
    expect(await codes(async () => res("", 401))).toBe("http_error:401:http_error:401");
    expect(await codes(async () => res("", 302, { location: "https://evil.example" }))).toBe("redirect:302:redirect:302");
    expect(await codes(async () => res("not json"))).toBe("bad_json::bad_json");
    expect(await codes(async () => { throw new TypeError("connect ECONNREFUSED https://api.dhan.co SECRET-T"); })).toBe("network::network");
    expect(await codes(async () => res("x".repeat(10), 200, { "content-length": "99999999" }))).toBe("too_large::too_large");
    await expect(mk(async () => res(GOOD))({ underlying: u, expiry: "29-10-2031" })).rejects.toThrow(DhanClientError);
  });
});

describe("enabled pass (fake fetch only)", () => {
  it("publishes both files that the agents' own parsers accept, and the token is nowhere in them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dhan-"));
    const r = await runDhanOptionsPass({ env: ENV_ON, providersDir: dir, now: NOW, expiries, fetchFn: (async () => res(GOOD)) as typeof fetch });
    expect(r).toEqual({ status: "published", quotes: 2, chains: 1, skippedLegs: 0 });
    const q = readFileSync(join(dir, DHAN_QUOTES_FILE), "utf8"), c = readFileSync(join(dir, DHAN_CHAIN_FILE), "utf8");
    expect(JSON.parse(q).source).toBe("dhan-option-chain");
    expect(q + c).not.toContain("TEST-TOKEN-VALUE-DO-NOT-LEAK");
    expect(Object.keys(JSON.parse(q).quotes)).toContain("NSE:NIFTY:2031-10-29:24500:CE");
  });
  it("a failed or malformed answer leaves any previous good file untouched and reports a fixed reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dhan-"));
    await runDhanOptionsPass({ env: ENV_ON, providersDir: dir, now: NOW, expiries, fetchFn: (async () => res(GOOD)) as typeof fetch });
    const before = readFileSync(join(dir, DHAN_QUOTES_FILE), "utf8");
    for (const [fetchFn, reason] of [[async () => res("", 500), "fetch_http_error_500"], [async () => res({ status: "failure" }), "response_unexpected_response"], [async () => res("zzz"), "fetch_bad_json"]] as const) {
      const r = await runDhanOptionsPass({ env: ENV_ON, providersDir: dir, now: NOW, expiries, fetchFn: fetchFn as unknown as typeof fetch });
      expect(r).toEqual({ status: "failed", reason });
    }
    expect(readFileSync(join(dir, DHAN_QUOTES_FILE), "utf8")).toBe(before);
    expect(await runDhanOptionsPass({ env: ENV_ON, providersDir: dir, now: NOW, expiries: [{ underlying: "SENSEX", expiry: "2031-10-29" }], fetchFn: (async () => res(GOOD)) as typeof fetch })).toEqual({ status: "failed", reason: "underlying_not_configured" });
  });
});

describe("it stays out of the running system", () => {
  it("is not referenced by the exporter loop, the compose file, the egress allow-list or the providers package", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    expect(read("scripts/ops/provider-exporter.ts")).not.toMatch(/dhan/i);
    expect(read("infrastructure/staging/docker-compose.staging.yml")).not.toMatch(/dhan/i);
    expect(read("infrastructure/staging/twins-providers-egress.sh")).not.toMatch(/dhan/i);
    expect(read("packages/providers/src/index.ts")).not.toMatch(/dhanOptions\b/);
  });
});
