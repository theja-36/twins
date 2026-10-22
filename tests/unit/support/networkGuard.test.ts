/**
 * Regression tests for the test-process network guard. NO external request is made to test it: every external attempt
 * below must be refused BEFORE a socket or DNS lookup, which the tests prove by checking that nothing reached the real
 * transport (`allowedConnects` does not move) and that the refusal is the guard's own error, not a DNS/connection error.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { YahooFinanceAdapter } from "../../../adapters/market/src/yahoo";
import { ExternalNetworkBlockedError, isLoopbackHost, networkGuardStats } from "../../support/networkGuard";

const stats = () => networkGuardStats();
const snapshot = () => ({ blocked: stats().blocked.length, allowed: stats().allowedConnects });

describe("host classification", () => {
  it.each(["localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1", "LOCALHOST", undefined, ""])("loopback: %s", (h) => {
    expect(isLoopbackHost(h as string | undefined)).toBe(true);
  });
  it.each(["query1.finance.yahoo.com", "8.8.8.8", "192.0.2.1", "10.0.0.5", "example.invalid", "127.0.0.1.evil.example", "localhost.evil.example"])("external: %s", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("external transports are refused before any socket or DNS lookup", () => {
  it("fetch to a public host", async () => {
    const before = snapshot();
    await expect(fetch("https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS")).rejects.toMatchObject({ code: "EXTERNAL_NETWORK_BLOCKED", host: "query1.finance.yahoo.com", via: "fetch" });
    expect(stats().blocked.length).toBe(before.blocked + 1);
    expect(stats().allowedConnects).toBe(before.allowed); // nothing reached the real transport
  });

  it("the real Yahoo market adapter (its default fetch) is blocked on every attempt, and nothing is sent", async () => {
    const before = snapshot();
    const adapter = new YahooFinanceAdapter(); // default global fetch, as the worker registers it
    await expect(adapter.getHistoricalBars({ instrument: { symbol: "RELIANCE", exchange: "NSE" }, timeframe: "1d", from: new Date(Date.now() - 86_400_000), to: new Date() })).rejects.toThrow(/EXTERNAL_NETWORK_BLOCKED/);
    const attempts = stats().blocked.slice(before.blocked);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts.every((a) => a.host.endsWith("finance.yahoo.com") && a.via === "fetch")).toBe(true);
    expect(stats().allowedConnects).toBe(before.allowed);
  }, 20_000);

  it.each([
    ["http.get", () => http.get("http://example.invalid/")],
    ["http.request (options form)", () => http.request({ hostname: "example.invalid", path: "/" })],
    ["https.request", () => https.request("https://example.invalid/")],
    ["https.get", () => https.get({ host: "example.invalid", path: "/" })],
  ])("%s", (label, attempt) => {
    const before = snapshot();
    expect(attempt).toThrow(ExternalNetworkBlockedError);
    expect(stats().allowedConnects).toBe(before.allowed);
    expect(stats().blocked.length).toBe(before.blocked + 1);
    void label;
  });

  it.each([
    ["net.connect to a hostname (blocked before DNS: not ENOTFOUND)", () => net.connect({ host: "example.invalid", port: 80 })],
    ["net.connect to a public IP", () => net.connect(80, "8.8.8.8")],
    ["net.createConnection to a documentation IP", () => net.createConnection({ host: "192.0.2.1", port: 5432 })],
    ["tls.connect", () => tls.connect({ host: "example.invalid", port: 443 })],
  ])("%s", (_l, attempt) => {
    const before = snapshot();
    expect(attempt).toThrow(/EXTERNAL_NETWORK_BLOCKED/);
    expect(stats().allowedConnects).toBe(before.allowed);
    expect(stats().blocked.length).toBe(before.blocked + 1);
  });
});

describe("approved local connections are NOT blocked", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("local-ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetch, http.get and raw net.connect to 127.0.0.1 all work and pass through to the transport", async () => {
    const before = snapshot();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("local-ok");
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => resolve(d));
      }).on("error", reject);
    });
    expect(body).toBe("local-ok");
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(); });
      s.on("error", reject);
    });
    expect(stats().allowedConnects).toBeGreaterThan(before.allowed);
    expect(stats().blocked.length).toBe(before.blocked); // none refused
  });
});
