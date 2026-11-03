import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type LoginDeps } from "../../../scripts/ops/kite-login";
import { KiteTokenStore } from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, API_KEY, API_SECRET, REQUEST_TOKEN, fakeFetch, json, ok } from "./helpers";

const NOW = new Date("2026-11-03T04:00:00.000Z");
function setup(responses: Parameters<typeof fakeFetch>[0] = [], over: Partial<LoginDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "twins-login-"));
  const file = join(dir, "kite-token.json");
  const { fetch: f, calls } = fakeFetch(responses);
  const out: string[] = [], err: string[] = [], logs: Array<[string, Record<string, unknown>]> = [];
  const deps: LoginDeps = { env: { TWINS_KITE_API_KEY: API_KEY, TWINS_KITE_API_SECRET: API_SECRET, TWINS_KITE_TOKEN_FILE: file }, out: (l) => out.push(l), err: (l) => err.push(l), readSecret: async () => REQUEST_TOKEN, fetch: f, now: () => NOW, log: (e, fields) => logs.push([e, fields]), ...over };
  return { deps, out, err, logs, calls, file };
}
const all = (s: { out: string[]; err: string[] }) => [...s.out, ...s.err].join("\n");

describe("kite-login (fake fetch: no live call)", () => {
  it("url prints the login URL with the api key; status with nothing stored says missing; neither touches the network", async () => {
    const s = setup();
    expect(await main(["url"], s.deps)).toBe(0);
    expect(s.out[0]).toBe(`https://kite.zerodha.com/connect/login?v=3&api_key=${API_KEY}`);
    expect(await main(["status"], s.deps)).toBe(0);
    expect(JSON.parse(s.out[1] as string)).toEqual({ present: false, reason: "missing" });
    expect(s.calls).toHaveLength(0);
  });
  it("exchange: reads the request token from the hidden reader, makes ONE POST /session/token, stores the token 0600, and never prints a secret", async () => {
    const s = setup([ok({ access_token: ACCESS_TOKEN, api_key: API_KEY })]);
    expect(await main(["exchange"], s.deps)).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe("https://api.kite.trade/session/token");
    expect(s.calls[0]?.init.method).toBe("POST");
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(new KiteTokenStore(s.file).load(API_KEY)?.accessToken).toBe(ACCESS_TOKEN);
    const printed = all(s);
    for (const secret of [ACCESS_TOKEN, REQUEST_TOKEN, API_SECRET]) expect(printed, secret).not.toContain(secret);
    expect(JSON.parse(s.out[0] as string)).toMatchObject({ stored: true, present: true, advisoryExpired: false });
  });
  it("exchange without a secret / without a request token / with a rejected exchange stores nothing", async () => {
    const noSecret = setup([], { env: { TWINS_KITE_API_KEY: API_KEY, TWINS_KITE_TOKEN_FILE: "/tmp/x-never-written.json" } });
    expect(await main(["exchange"], noSecret.deps)).toBe(2);
    const empty = setup([], { readSecret: async () => "" });
    expect(await main(["exchange"], empty.deps)).toBe(2);
    expect(empty.calls).toHaveLength(0);
    const rejected = setup([json({ status: "error", message: "Token is invalid or has expired.", error_type: "TokenException" }, 403)]);
    expect(await main(["exchange"], rejected.deps)).toBe(3);
    expect(existsSync(rejected.file)).toBe(false);
    expect(all(rejected)).not.toContain(REQUEST_TOKEN);
  });
  it("verify: a valid token passes (one GET /user/profile); a rejected token is REMOVED and kite.session.invalidated is logged", async () => {
    const good = setup([ok({ access_token: ACCESS_TOKEN, api_key: API_KEY }), ok({ user_id: "AB1234" })]);
    await main(["exchange"], good.deps);
    expect(await main(["verify"], good.deps)).toBe(0);
    expect(good.calls[1]?.url).toBe("https://api.kite.trade/user/profile");
    expect(good.calls[1]?.init.method ?? "GET").toBe("GET");
    const bad = setup([ok({ access_token: ACCESS_TOKEN, api_key: API_KEY }), json({ status: "error", message: "Incorrect api_key or access_token.", error_type: "TokenException" }, 403)]);
    await main(["exchange"], bad.deps);
    expect(existsSync(bad.file)).toBe(true);
    expect(await main(["verify"], bad.deps)).toBe(3);
    expect(existsSync(bad.file)).toBe(false);
    expect(bad.logs).toEqual([["kite.session.invalidated", { reason: "server_rejected" }]]);
    expect(await main(["verify"], bad.deps)).toBe(3); // nothing stored any more: refused without a call
    expect(bad.calls).toHaveLength(2);
  });
  it("clear removes the file; usage errors and a relative token path exit 2; the source has no write-path strings and no token logging", async () => {
    const s = setup([ok({ access_token: ACCESS_TOKEN, api_key: API_KEY })]);
    await main(["exchange"], s.deps);
    expect(await main(["clear"], s.deps)).toBe(0);
    expect(existsSync(s.file)).toBe(false);
    for (const argv of [[], ["bogus"], ["status", "extra"], ["exchange", "--token", "x"]]) expect(await main(argv, setup().deps), argv.join(" ")).toBe(2);
    expect(await main(["status"], setup([], { env: { TWINS_KITE_API_KEY: API_KEY, TWINS_KITE_TOKEN_FILE: "relative.json" } }).deps)).toBe(2);
    const src = readFileSync("scripts/ops/kite-login.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/["'`]\/(orders|trades|portfolio|gtt|margins|mf)\b/);
    expect(src).not.toMatch(/console\.(log|error)\([^)]*(token|secret)/i);
  });
});
