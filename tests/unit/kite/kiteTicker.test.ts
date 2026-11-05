import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type TickerDeps } from "../../../scripts/ops/kite-ticker";
import { KiteTokenStore, type FeedLoopDeps, type WsConnection } from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, API_KEY, csv, fakeFetch, ok } from "./helpers";

const NOW = new Date("2026-11-03T04:00:00.000Z"); // Tuesday 09:30 IST
class Sock implements WsConnection {
  sent: string[] = []; closed = false;
  constructor(readonly url: string) {}
  onOpen(): void {} onMessage(): void {} onClose(): void {} onError(): void {}
  send(t: string): void { this.sent.push(t); }
  close(): void { this.closed = true; }
}
function setup(over: { env?: Record<string, string>; token?: boolean; issuedAt?: Date; responses?: Parameters<typeof fakeFetch>[0] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "twins-kt-"));
  const tokenFile = join(dir, "kite-token.json");
  if (over.token !== false) new KiteTokenStore(tokenFile, () => over.issuedAt ?? NOW).save(ACCESS_TOKEN, API_KEY);
  const { fetch: f, calls } = fakeFetch(over.responses ?? []);
  const out: string[] = [], err: string[] = [], logs: Array<[string, Record<string, unknown> | undefined]> = [], socks: Sock[] = [];
  const env: Record<string, string> = { TWINS_KITE_API_KEY: API_KEY, TWINS_KITE_TOKEN_FILE: tokenFile, TWINS_KITE_PLAN: "connect", TWINS_AGENT_SNAPSHOT_DIR: join(dir, "snap"), TWINS_AGENT_SNAPSHOT_REQUIRED: "instrument-reference,quotes,option-quotes,option-chain,last-price,ohlc", TWINS_KITE_UNDERLYINGS: "NIFTY", ...over.env };
  let captured: FeedLoopDeps | undefined;
  const deps: TickerDeps = {
    env, now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l), fetch: f, log: (e, fl) => logs.push([e, fl]),
    wsFactory: (url) => { const s = new Sock(url); socks.push(s); return s; },
    runLoop: async (d) => { captured = d; return "stopped"; },
  };
  return { deps, out, err, logs, calls, socks, captured: () => captured, tokenFile };
}
const candlesResp = () => ok({ candles: [["2026-10-30T00:00:00+0530", 24150, 24300, 24100, 24250, 0], ["2026-11-02T00:00:00+0530", 24250, 24400, 24200, 24350, 0]] });

describe("kite-ticker (fixtures only; nothing connects)", () => {
  it("check-config with a connect plan and a fresh token prints a redacted summary and makes no network call", async () => {
    const s = setup();
    expect(await main(["check-config"], s.deps)).toBe(0);
    const j = JSON.parse(s.out[0] as string);
    expect(j).toMatchObject({ ok: true, plan: "connect", underlyings: ["NIFTY"], marketStateNow: "open", token: { present: true } });
    expect(JSON.stringify(j)).not.toContain(ACCESS_TOKEN);
    expect(s.calls).toHaveLength(0);
    expect(s.socks).toHaveLength(0);
  });
  it("the default plan (personal) stops with exit 3 before any token is read or any socket is created", async () => {
    const s = setup({ env: { TWINS_KITE_PLAN: "" } });
    expect(await main(["run"], s.deps)).toBe(3);
    expect(JSON.parse(s.err[0] as string)).toMatchObject({ code: "PLAN_RESTRICTED", plan: "personal" });
    expect(s.captured()).toBeUndefined();
    expect(s.socks).toHaveLength(0);
  });
  it("no token / an advisory-expired token / a token of another api key exit 4 and log kite.session.invalidated", async () => {
    const none = setup({ token: false });
    expect(await main(["run"], none.deps)).toBe(4);
    expect(none.logs).toEqual([["kite.session.invalidated", { reason: "missing" }]]);
    const old = setup({ issuedAt: new Date("2026-11-01T04:00:00.000Z") });
    expect(await main(["run"], old.deps)).toBe(4);
    expect(old.logs[0]).toEqual(["kite.session.invalidated", { reason: "token_expired" }]);
    const other = setup({ env: { TWINS_KITE_API_KEY: "anotherkey123" } });
    expect(await main(["check-config"], other.deps)).toBe(4);
    expect(other.logs[0]?.[1]).toEqual({ reason: "token_for_another_key" });
  });
  it("bad configuration (unknown plan, bad holiday, unsupported underlying, missing snapshot dir, bad interval) exits 2 with a code only", async () => {
    for (const env of [{ TWINS_KITE_PLAN: "gold" }, { TWINS_KITE_HOLIDAYS: "11/10/2026" }, { TWINS_KITE_UNDERLYINGS: "RELIANCE" }, { TWINS_KITE_UNDERLYINGS: "NIFTY,NIFTY" }, { TWINS_KITE_EXPORT_INTERVAL_SECONDS: "1" }, { TWINS_KITE_OPTION_EXPIRIES: "9" }, { TWINS_AGENT_SNAPSHOT_DIR: "" }]) {
      const s = setup({ env });
      expect(await main(["check-config"], s.deps), JSON.stringify(env)).toBe(2);
      expect(s.err[0]).toMatch(/"code":"[A-Z_]+"/);
    }
    expect(await main(["bogus"], setup().deps)).toBe(2);
    expect(await main(["run", "--now"], setup().deps)).toBe(2);
  });
  it("run: wires the loop but opens NOTHING by itself (no socket, no request) until the loop's own day-preparation runs", async () => {
    const s = setup();
    expect(await main(["run"], s.deps)).toBe(0);
    expect(s.captured()).toBeDefined();
    expect(s.calls).toHaveLength(0);
    expect(s.socks).toHaveLength(0);
  });
  it("prepareDay through the wired service: ONE instruments request and one candle request (GET only), then the ticker is created on the Kite WebSocket host with the token as a parameter that is never logged; the window close stops it", async () => {
    const s = setup({ responses: [new Response(csv()), candlesResp()] });
    await main(["run"], s.deps);
    const d = s.captured() as FeedLoopDeps;
    await d.service.prepareDay();
    expect(s.calls.map((c) => `${c.init.method ?? "GET"} ${new URL(c.url).pathname}`)).toEqual(["GET /instruments", expect.stringMatching(/^GET \/instruments\/historical\/\d+\/day$/)]);
    expect(s.socks).toHaveLength(1);
    const url = new URL((s.socks[0] as Sock).url);
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("ws.kite.trade");
    expect(JSON.stringify(s.logs)).not.toContain(ACCESS_TOKEN);
    expect(d.health?.()).toBeNull();
    d.onWindowClose?.();
    expect((s.socks[0] as Sock).closed).toBe(true);
  });
  it("a rejected token (HTTP 403 on a REST call) removes the stored token and logs kite.session.invalidated; the day does not start and nothing is subscribed", async () => {
    const s = setup({ responses: [new Response(csv()), new Response(JSON.stringify({ status: "error", message: "Incorrect api_key or access_token.", error_type: "TokenException" }), { status: 403, headers: { "content-type": "application/json" } })] });
    await main(["run"], s.deps);
    const d = s.captured() as FeedLoopDeps;
    await expect(d.service.prepareDay()).rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(new KiteTokenStore(s.tokenFile).status()).toEqual({ present: false, reason: "missing" });
    expect(s.logs).toContainEqual(["kite.session.invalidated", { reason: "server_rejected", tokenFileCleared: true }]);
    expect(s.socks).toHaveLength(0);
    expect(d.service.ready()).toBe(false);
  });
});
