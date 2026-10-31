import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinWebSocketFactory, KiteError, KiteTicker, Session, type KiteInstrument, type TickerOptions, type TickerTimers, type WsConnection } from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, API_KEY, catalog } from "./helpers";

const fx = JSON.parse(readFileSync(new URL("../../fixtures/kite/ws-frames.json", import.meta.url), "utf8")) as { now_epoch: number; frames: Record<string, string> };
const frame = (name: string): Uint8Array => Uint8Array.from(Buffer.from(fx.frames[name] as string, "hex"));
const cat = catalog();
const nifty = cat.require({ underlying: "NIFTY", kind: "index" });
const fut = cat.require({ underlying: "NIFTY", kind: "future", expiry: "2026-11-26" });
const opt = cat.require({ underlying: "NIFTY", kind: "option", expiry: "2026-11-26", strike: 24000, optionType: "CE" });
const bank = cat.require({ underlying: "BANKNIFTY", kind: "index" });

class FakeTimers implements TickerTimers {
  t = fx.now_epoch * 1000;
  private seq = 0;
  private pending: Array<{ id: number; at: number; fn: () => void }> = [];
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.seq; this.pending.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown): void { this.pending = this.pending.filter((p) => p.id !== h); }
  count(): number { return this.pending.length; }
  /** Advances the clock, firing due timers in order (including ones they schedule). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const next = this.pending.filter((p) => p.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.pending = this.pending.filter((p) => p !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
      await Promise.resolve(); await Promise.resolve();
    }
    this.t = end;
  }
}

class FakeSocket implements WsConnection {
  sent: string[] = [];
  closed = false;
  private h: { open?: () => void; message?: (d: string | Uint8Array) => void; close?: (c: number) => void; error?: () => void } = {};
  constructor(readonly url: string) {}
  onOpen(cb: () => void): void { this.h.open = cb; }
  onMessage(cb: (d: string | Uint8Array) => void): void { this.h.message = cb; }
  onClose(cb: (c: number) => void): void { this.h.close = cb; }
  onError(cb: () => void): void { this.h.error = cb; }
  send(t: string): void { if (this.closed) throw new Error("closed"); this.sent.push(t); }
  close(): void { this.closed = true; }
  // test controls
  open(): void { this.h.open?.(); }
  push(d: string | Uint8Array): void { this.h.message?.(d); }
  drop(code = 1006): void { this.h.error?.(); this.h.close?.(code); }
  msgs(): unknown[] { return this.sent.map((s) => JSON.parse(s) as unknown); }
}

function rig(over: Partial<TickerOptions> = {}) {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const session = new Session();
  session.setToken(ACCESS_TOKEN);
  const ticker = new KiteTicker({
    plan: "connect",
    apiKey: API_KEY, session, catalog: cat, timers, log: (event, fields) => { logs.push({ event, ...(fields ? { fields } : {}) }); },
    factory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    baseBackoffMs: 1000, maxBackoffMs: 8000, maxReconnectAttempts: 4, inactivityMs: 9000, ...over,
  });
  const last = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket;
  const connect = (): FakeSocket => { ticker.start(); const s = last(); s.open(); return s; };
  return { ticker, timers, sockets, logs, session, last, connect };
}

describe("connection and subscriptions", () => {
  it("opens exactly one connection, the URL goes only to the transport, and start() is idempotent", () => {
    const r = rig();
    r.ticker.start(); r.ticker.start();
    expect(r.sockets).toHaveLength(1);
    expect(r.sockets[0]?.url).toBe(`wss://ws.kite.trade?api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`);
    expect(r.ticker.state()).toBe("connecting");
    r.last().open();
    expect(r.ticker.state()).toBe("connected");
    r.ticker.start();
    expect(r.sockets).toHaveLength(1);
  });
  it("sends only subscribe / unsubscribe / mode messages; subscriptions made before connect are sent on open", () => {
    const r = rig();
    r.ticker.subscribe([nifty, fut], "full");
    const s = r.connect();
    expect(s.msgs()).toEqual([{ a: "subscribe", v: [256265, 9000001] }, { a: "mode", v: ["full", [256265, 9000001]] }]);
    r.ticker.subscribe([opt], "ltp");
    r.ticker.setMode("quote", [opt]);
    r.ticker.unsubscribe([fut]);
    expect(s.msgs().slice(2)).toEqual([{ a: "subscribe", v: [9000002] }, { a: "mode", v: ["ltp", [9000002]] }, { a: "mode", v: ["quote", [9000002]] }, { a: "unsubscribe", v: [9000001] }]);
    expect(s.msgs().every((m) => ["subscribe", "unsubscribe", "mode"].includes((m as { a: string }).a))).toBe(true);
    expect(r.ticker.subscribed().sort()).toEqual([9000002, 256265].sort());
  });
  it("refuses instruments outside the catalog and subscriptions beyond the hard bound", () => {
    const r = rig({ maxInstruments: 2 });
    const stranger: KiteInstrument = { ...fut, token: 777, tradingSymbol: "FINNIFTYFUT" };
    expect(() => r.ticker.subscribe([stranger])).toThrow(KiteError);
    expect(() => r.ticker.subscribe([nifty, fut, opt])).toThrow(KiteError);
    expect(r.ticker.subscribed()).toEqual([]);
    expect(r.ticker.storedCount()).toBe(0);
  });
  it("the built-in WebSocket adapter exists (not opened here: no live sockets in tests)", () => {
    expect(typeof builtinWebSocketFactory).toBe("function");
  });
});

describe("ticks, freshness and what does NOT make data fresh", () => {
  const MAX = 10_000;
  it("a full packet is stored as a validated quote and is fresh while connected and young", () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(frame("fut_full"));
    const stored = r.ticker.get(9000001);
    expect(stored?.validated?.quote).toMatchObject({ bid: 24399.9, ask: 24400.1, last: 24400, asOf: "2026-11-02T10:15:56.000Z" });
    expect(stored?.validated).toMatchObject({ lastTradeTime: "2026-11-02T10:15:52.000Z", receivedAt: "2026-11-02T10:16:00.000Z" });
    expect(r.ticker.freshness(9000001, MAX)).toMatchObject({ state: "fresh", ageMs: 4000 });
  });
  it("heartbeats prove the connection only: the quote still ages and goes stale", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(frame("fut_full"));
    for (let i = 0; i < 4; i++) { await r.timers.advance(3000); s.push(frame("heartbeat")); }
    expect(r.ticker.stats().heartbeats).toBe(4);
    expect(r.ticker.freshness(9000001, MAX)).toMatchObject({ state: "stale", ageMs: 16000 });
    expect(r.ticker.state()).toBe("connected");
  });
  it("timestamp-less packets stay LIMITED and cannot create or refresh a validated quote", async () => {
    const r = rig({ inactivityMs: 3_600_000 });
    r.ticker.subscribe([fut, nifty], "full");
    const s = r.connect();
    s.push(frame("fut_ltp"));
    expect(r.ticker.get(9000001)).toMatchObject({ validated: null, limited: { lastPrice: 24400, reason: "no_exchange_timestamp" } });
    expect(r.ticker.freshness(9000001, MAX)).toMatchObject({ state: "limited" });
    s.push(frame("fut_full"));
    await r.timers.advance(20_000);
    s.push(frame("fut_ltp")); // a new LTP arrives, but it carries no exchange time
    expect(r.ticker.freshness(9000001, MAX)).toMatchObject({ state: "stale", ageMs: 24000 });
    s.push(frame("index_quote"));
    expect(r.ticker.freshness(256265, MAX)).toMatchObject({ state: "limited" });
    s.push(frame("full_no_ts"));
    expect(r.ticker.get(9000001)?.validated?.exchangeTimestamp).toBe("2026-11-02T10:15:56.000Z"); // unchanged
  });
  it("an old exchange timestamp is stored but stale; a future one and a crossed market are rejected and store nothing", () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(frame("full_future_ts"));
    s.push(frame("full_crossed"));
    expect(r.ticker.get(9000001)).toEqual({ validated: null, limited: null });
    expect(r.ticker.freshness(9000001, MAX)).toEqual({ state: "no_data" });
    expect(r.ticker.stats().rejectedPackets).toBe(2);
    s.push(frame("full_old_ts"));
    expect(r.ticker.freshness(9000001, MAX)).toMatchObject({ state: "stale" });
  });
  it("an instrument never moves backwards in exchange time; a newer tick replaces", () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(frame("fut_full"));
    s.push(frame("fut_full_older"));
    expect(r.ticker.get(9000001)?.validated?.quote.last).toBe(24400);
    expect(r.ticker.stats().staleDropped).toBe(1);
    s.push(frame("fut_full_newer"));
    expect(r.ticker.get(9000001)?.validated?.quote.last).toBe(24410);
  });
  it("malformed frames and unsupported tokens produce no quote, and the connection stays up", () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(frame("fut_full").slice(0, 100));
    s.push(frame("unsupported_currency"));
    s.push(frame("index_full")); // valid, but the NIFTY 50 index is not subscribed
    expect(r.ticker.get(9000001)).toEqual({ validated: null, limited: null });
    expect(r.ticker.stats()).toMatchObject({ rejectedFrames: 1, rejectedPackets: 2, ticks: 0 });
    expect(r.ticker.state()).toBe("connected");
  });
  it("ticks for an unsubscribed instrument are rejected and its storage is gone; storage never exceeds the subscriptions", () => {
    const r = rig();
    r.ticker.subscribe([fut, nifty], "full");
    const s = r.connect();
    s.push(frame("multi"));
    expect(r.ticker.storedCount()).toBe(2);
    r.ticker.unsubscribe([nifty]);
    expect(r.ticker.get(256265)).toBeUndefined();
    s.push(frame("index_full"));
    expect(r.ticker.get(256265)).toBeUndefined();
    expect(r.ticker.storedCount()).toBe(1);
  });
  it("listeners get decoded ticks; a throwing listener does not break the ticker", () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const seen: number[] = [];
    r.ticker.onTick(() => { throw new Error("bad listener"); });
    const off = r.ticker.onTick((t) => seen.push(t.instrument.token));
    const s = r.connect();
    s.push(frame("fut_full"));
    off();
    s.push(frame("fut_full_newer"));
    expect(seen).toEqual([9000001]);
    expect(r.ticker.stats().ticks).toBe(2);
  });
});

describe("disconnect, reconnect and re-subscription", () => {
  it("reconnects with doubling back-off, re-sends every subscription and mode, keeps a single socket and a single timer", async () => {
    const r = rig();
    r.ticker.subscribe([fut, nifty], "full");
    r.ticker.subscribe([opt], "ltp");
    const s1 = r.connect();
    s1.drop();
    expect(r.ticker.state()).toBe("reconnecting");
    expect(r.timers.count()).toBe(1); // the reconnect timer; the watchdog was cleared
    await r.timers.advance(999);
    expect(r.sockets).toHaveLength(1);
    await r.timers.advance(1);
    expect(r.sockets).toHaveLength(2);
    const s2 = r.last();
    s2.drop(); // never opened: next delay doubles
    await r.timers.advance(1999);
    expect(r.sockets).toHaveLength(2);
    await r.timers.advance(1);
    expect(r.sockets).toHaveLength(3);
    const s3 = r.last();
    s3.open();
    expect(s3.msgs()).toEqual([
      { a: "subscribe", v: [9000001, 256265, 9000002] },
      { a: "mode", v: ["full", [9000001, 256265]] }, { a: "mode", v: ["ltp", [9000002]] },
    ]);
    expect(r.ticker.state()).toBe("connected");
    expect(r.timers.count()).toBe(1); // only the watchdog
    expect(r.sockets.filter((s) => !s.closed).length).toBeGreaterThanOrEqual(1);
  });
  it("back-off is capped, resets after the first frame of a healthy connection, and stops as 'failed' after the maximum attempts", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    r.ticker.start();
    for (const delay of [1000, 2000, 4000, 8000]) { r.last().drop(); await r.timers.advance(delay); }
    expect(r.sockets).toHaveLength(5);
    r.last().drop(); // 5th consecutive failure > maxReconnectAttempts (4)
    expect(r.ticker.state()).toBe("failed");
    await r.timers.advance(600_000);
    expect(r.sockets).toHaveLength(5);
    expect(r.timers.count()).toBe(0);
    // a manual restart is allowed; a healthy frame resets the counter
    r.ticker.start();
    r.last().open();
    r.last().push(frame("heartbeat"));
    r.last().drop();
    await r.timers.advance(1000); // back to the FIRST delay
    expect(r.sockets).toHaveLength(7);
  });
  it("reconnecting never makes cached data fresh: it is 'disconnected' while down and stale/aged afterwards until a new tick arrives", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s1 = r.connect();
    s1.push(frame("fut_full"));
    s1.drop();
    expect(r.ticker.freshness(9000001, 60_000)).toMatchObject({ state: "disconnected", ageMs: 4000 });
    await r.timers.advance(1000);
    const s2 = r.last();
    s2.open();
    expect(r.ticker.freshness(9000001, 3000)).toMatchObject({ state: "stale", ageMs: 5000 }); // same exchange timestamp, simply older now
    s2.push(frame("heartbeat"));
    expect(r.ticker.freshness(9000001, 3000)).toMatchObject({ state: "stale" });
    s2.push(frame("fut_full_newer")); // only a NEW upstream timestamp refreshes
    expect(r.ticker.freshness(9000001, 3000)).toMatchObject({ state: "fresh", ageMs: 3000 });
  });
  it("events from a replaced socket are ignored", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s1 = r.connect();
    s1.drop();
    await r.timers.advance(1000);
    const s2 = r.last();
    s2.open();
    s1.push(frame("fut_full")); // late frame from the dead socket
    s1.drop();
    expect(r.ticker.get(9000001)?.validated).toBeNull();
    expect(r.ticker.state()).toBe("connected");
    expect(r.sockets).toHaveLength(2);
  });
  it("the inactivity watchdog drops a silent connection (no data AND no heartbeat) and heartbeats keep a quiet one alive", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s1 = r.connect();
    for (let i = 0; i < 5; i++) { await r.timers.advance(3000); s1.push(frame("heartbeat")); }
    expect(r.sockets).toHaveLength(1);
    await r.timers.advance(10_000); // silence beyond inactivityMs (9 s)
    expect(s1.closed).toBe(true);
    expect(r.ticker.state()).toBe("reconnecting");
    await r.timers.advance(1000);
    expect(r.sockets).toHaveLength(2);
  });
});

describe("authentication", () => {
  it("a server-side token error invalidates the session, stops without reconnecting, and its text is not logged", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(JSON.stringify({ type: "error", data: `Invalid access_token ${ACCESS_TOKEN} for api_key ${API_KEY}` }));
    expect(r.ticker.state()).toBe("auth_failed");
    expect(r.session.state().status).toBe("invalid");
    expect(s.closed).toBe(true);
    await r.timers.advance(600_000);
    expect(r.sockets).toHaveLength(1);
    expect(r.timers.count()).toBe(0);
    expect(JSON.stringify(r.logs)).not.toContain(ACCESS_TOKEN);
    r.ticker.start(); // refuses to connect with an invalid session
    expect(r.sockets).toHaveLength(1);
    expect(r.ticker.state()).toBe("auth_failed");
  });
  it("a session invalidated elsewhere is noticed before the next connect and at the next watchdog tick", async () => {
    const a = rig();
    a.ticker.subscribe([fut], "full");
    const s = a.connect();
    a.session.markInvalid();
    await a.timers.advance(3000);
    expect(a.ticker.state()).toBe("auth_failed");
    expect(s.closed).toBe(true);
    const b = rig();
    b.ticker.start();
    b.last().drop();
    b.session.markInvalid();
    await b.timers.advance(1000);
    expect(b.ticker.state()).toBe("auth_failed");
    expect(b.sockets).toHaveLength(1);
  });
  it("checkSession before each reconnect: SESSION_INVALID ends it as auth_failed; other failures keep the back-off schedule", async () => {
    let verdict: "invalid" | "network" = "network";
    const r = rig({ checkSession: async () => { throw new KiteError(verdict === "invalid" ? "SESSION_INVALID" : "NETWORK"); } });
    r.ticker.start();
    r.last().drop();
    await r.timers.advance(1000);
    expect(r.sockets).toHaveLength(2); // the check failed for another reason: carry on
    r.last().drop();
    verdict = "invalid";
    await r.timers.advance(2000);
    expect(r.ticker.state()).toBe("auth_failed");
    expect(r.sockets).toHaveLength(2);
    await r.timers.advance(600_000);
    expect(r.sockets).toHaveLength(2);
  });
  it("handshake rejection (closes without ever opening) is bounded by the attempt limit, never an endless loop", async () => {
    const r = rig();
    r.ticker.start();
    for (let i = 0; i < 10 && r.ticker.state() !== "failed"; i++) { r.last().drop(1006); await r.timers.advance(10_000); }
    expect(r.ticker.state()).toBe("failed");
    expect(r.sockets.length).toBeLessThanOrEqual(5);
  });
  it("a factory that throws is handled like a failed attempt, and its error text (which could contain the URL) is not logged", async () => {
    const timers = new FakeTimers();
    const logs: string[] = [];
    const session = new Session(); session.setToken(ACCESS_TOKEN);
    const ticker = new KiteTicker({ plan: "connect", apiKey: API_KEY, session, catalog: cat, timers, log: (e, f) => logs.push(JSON.stringify({ e, f })), factory: (url) => { throw new Error(`cannot connect to ${url}`); }, maxReconnectAttempts: 2 });
    ticker.start();
    await timers.advance(100_000);
    expect(ticker.state()).toBe("failed");
    expect(logs.join("")).not.toMatch(new RegExp(`${ACCESS_TOKEN}|${API_KEY}|wss://`));
  });
});

describe("other server messages", () => {
  it("order postbacks are ignored: counted only, never stored or logged; other messages are ignored too", () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    const marker = "ORDER-PAYLOAD-MARKER-91f2";
    s.push(JSON.stringify({ type: "order", data: { order_id: marker, tradingsymbol: "NIFTY26NOVFUT", status: "COMPLETE" } }));
    s.push(JSON.stringify({ type: "message", data: marker }));
    s.push("not json");
    s.push(JSON.stringify({ type: "error", data: `some non-auth problem ${marker}` }));
    expect(r.ticker.stats()).toMatchObject({ ordersIgnored: 1, messagesIgnored: 2 });
    expect(r.ticker.state()).toBe("connected");
    expect(JSON.stringify(r.logs)).not.toContain(marker);
    expect(JSON.stringify(r.ticker.get(9000001))).not.toContain(marker);
    expect(JSON.stringify(r.ticker.stats())).not.toContain(marker);
  });
  it("oversized text frames are dropped", () => {
    const r = rig();
    const s = r.connect();
    s.push(JSON.stringify({ type: "order", data: "x".repeat(70_000) }));
    expect(r.ticker.stats()).toMatchObject({ ordersIgnored: 0, messagesIgnored: 1 });
  });
  it("no log line ever contains the URL, the API key or the token", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(frame("fut_full")); s.push(frame("full_crossed")); s.push(frame("fut_full").slice(0, 9));
    s.drop();
    await r.timers.advance(1000);
    r.ticker.stop();
    const text = JSON.stringify(r.logs);
    expect(text.length).toBeGreaterThan(20);
    for (const secret of [ACCESS_TOKEN, API_KEY, "wss://", "access_token", "api_key="]) expect(text).not.toContain(secret);
  });
});

describe("stop and dispose release everything", () => {
  it("stop() closes the socket, clears every timer, ignores later events, keeps cached ticks (never fresh) and can restart", async () => {
    const r = rig();
    r.ticker.subscribe([fut], "full");
    const s = r.connect();
    s.push(frame("fut_full"));
    r.ticker.stop();
    expect(s.closed).toBe(true);
    expect(r.ticker.state()).toBe("stopped");
    expect(r.timers.count()).toBe(0);
    expect(r.ticker.pendingTimers()).toEqual({ reconnect: false, watchdog: false });
    s.push(frame("fut_full_newer")); s.drop();
    await r.timers.advance(600_000);
    expect(r.sockets).toHaveLength(1);
    expect(r.ticker.get(9000001)?.validated?.quote.last).toBe(24400);
    expect(r.ticker.freshness(9000001, 10 ** 9)).toMatchObject({ state: "disconnected" });
    r.ticker.start();
    expect(r.sockets).toHaveLength(2);
  });
  it("stop() during a pending reconnect cancels it", async () => {
    const r = rig();
    r.ticker.start();
    r.last().drop();
    expect(r.timers.count()).toBe(1);
    r.ticker.stop();
    expect(r.timers.count()).toBe(0);
    await r.timers.advance(600_000);
    expect(r.sockets).toHaveLength(1);
  });
  it("dispose() is final: storage, subscriptions and listeners are dropped, timers cleared, and further use is refused", async () => {
    const r = rig();
    r.ticker.subscribe([fut, nifty], "full");
    const states: string[] = [];
    r.ticker.onState((s) => states.push(s));
    const s = r.connect();
    s.push(frame("multi"));
    r.ticker.dispose();
    r.ticker.dispose();
    expect(r.ticker.state()).toBe("disposed");
    expect(r.ticker.storedCount()).toBe(0);
    expect(r.ticker.subscribed()).toEqual([]);
    expect(r.timers.count()).toBe(0);
    expect(s.closed).toBe(true);
    expect(() => r.ticker.start()).toThrow(KiteError);
    expect(() => r.ticker.subscribe([fut])).toThrow(KiteError);
    s.push(frame("fut_full"));
    await r.timers.advance(600_000);
    expect(r.ticker.get(9000001)).toBeUndefined();
    expect(r.sockets).toHaveLength(1);
    expect(states).toContain("connected");
  });
  it("stop() then dispose() with nothing running is harmless", () => {
    const r = rig();
    r.ticker.stop(); r.ticker.dispose();
    expect(r.ticker.state()).toBe("disposed");
  });
  it("scope: only the three indices and their listed derivatives are subscribable", () => {
    const r = rig();
    expect(() => r.ticker.subscribe([nifty, bank, fut, opt])).not.toThrow();
    expect(r.ticker.subscribed()).toHaveLength(4);
  });
});
