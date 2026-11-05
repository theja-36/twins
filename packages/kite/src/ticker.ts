import { KiteError } from "./errors";
import type { InstrumentCatalog, KiteInstrument } from "./instruments";
import type { Session } from "./session";
import { MAX_FUTURE_SKEW_MS } from "./marketData";
import { PLAN_CAPABILITIES, type KitePlan } from "./plans";
import { decodeFrame, type DecodedTick } from "./ticks";

export type TickerMode = "ltp" | "quote" | "full";
export type TickerState = "idle" | "connecting" | "connected" | "reconnecting" | "stopped" | "auth_failed" | "failed" | "disposed";

/** The minimal socket surface the ticker needs. The URL carries credentials: only the transport factory ever sees it. */
export interface WsConnection {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: (code: number) => void): void;
  onError(cb: () => void): void;
  send(text: string): void;
  close(): void;
}
export type WsFactory = (url: string) => WsConnection;

export interface TickerTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemTimers: TickerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Adapter over the runtime's built-in WebSocket (Node 22+); no dependency is added. Not exercised by the unit tests (it would open a socket);
 * the ticker is tested through a fake `WsFactory`.
 */
export function builtinWebSocketFactory(): WsFactory {
  return (url) => {
    const Ctor = (globalThis as { WebSocket?: new (u: string) => WebSocket }).WebSocket;
    if (!Ctor) throw new KiteError("CONFIG");
    const ws = new Ctor(url);
    ws.binaryType = "arraybuffer";
    return {
      onOpen: (cb) => { ws.onopen = () => cb(); },
      onMessage: (cb) => { ws.onmessage = (e: MessageEvent) => cb(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer)); },
      onClose: (cb) => { ws.onclose = (e: { code: number }) => cb(e.code); },
      onError: (cb) => { ws.onerror = () => cb(); },
      send: (t) => ws.send(t),
      close: () => ws.close(),
    };
  };
}

export interface TickerOptions {
  apiKey: string;
  session: Session;
  catalog: InstrumentCatalog;
  factory: WsFactory;
  timers?: TickerTimers;
  /** Fixed-field events only: never the URL, never message content. */
  log?: (event: string, fields?: Record<string, unknown>) => void;
  baseUrl?: string;
  /** Hard bound on subscribed instruments (and thus on stored ticks). Default 200, maximum 3000 (the documented per-connection limit). */
  maxInstruments?: number;
  /** Consecutive failed connection attempts before the state becomes "failed". Default 8. */
  maxReconnectAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** No frame (data OR heartbeat) for this long = connection considered dead. Default 15 s. */
  inactivityMs?: number;
  /**
   * Optional check before a reconnect (e.g. `() => kiteClient.verifySession()`): a SESSION_INVALID answer stops reconnecting as auth_failed.
   * Any other failure of the check does not stop the backoff schedule.
   */
  checkSession?: () => Promise<void>;
  /** The configured Kite plan; default "personal" (fail closed): the WebSocket needs "connect". */
  plan?: KitePlan;
}

export interface ValidatedTick { instrumentKey: string; layout: DecodedTick["layout"]; quote: NonNullable<DecodedTick["quote"]>; exchangeTimestamp: string; lastTradeTime: string | null; receivedAt: string; dayOhlc: DecodedTick["dayOhlc"] }
export interface LimitedTick { instrumentKey: string; layout: DecodedTick["layout"]; lastPrice: number | null; receivedAt: string; volume: number | null; dayOhlc: DecodedTick["dayOhlc"]; reason: "no_exchange_timestamp" }
export interface StoredTicks { validated: ValidatedTick | null; limited: LimitedTick | null }

export type Freshness =
  | { state: "no_data" }
  | { state: "limited"; reason: "no_exchange_timestamp"; receivedAt: string }
  | { state: "disconnected"; ageMs: number; exchangeTimestamp: string; receivedAt: string }
  | { state: "stale"; ageMs: number; exchangeTimestamp: string; receivedAt: string }
  | { state: "invalid_future"; ageMs: number; exchangeTimestamp: string; receivedAt: string }
  | { state: "fresh"; ageMs: number; exchangeTimestamp: string; receivedAt: string };

export interface TickerStats {
  frames: number; heartbeats: number; ticks: number; rejectedPackets: number; rejectedFrames: number; staleDropped: number;
  ordersIgnored: number; messagesIgnored: number; reconnects: number; lastActivityAt: string | null;
  /** Packet rejections by check name (no payloads): the first of each reason is logged, then every 100th with its running count. */
  rejectedByReason: Record<string, number>;
}

const MAX_TEXT = 64 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const CHUNK = 200;
const AUTH_ERROR = /token|api_key|api key|unauthori[sz]ed|forbidden|403|session/i;

export class KiteTicker {
  private readonly timers: TickerTimers;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private readonly maxInstruments: number;
  private readonly maxAttempts: number;
  private readonly baseBackoff: number;
  private readonly maxBackoff: number;
  private readonly inactivityMs: number;
  private readonly desired = new Map<number, { instrument: KiteInstrument; mode: TickerMode }>();
  private readonly store = new Map<number, StoredTicks>();
  private readonly tickListeners = new Set<(t: DecodedTick) => void>();
  private readonly stateListeners = new Set<(s: TickerState) => void>();
  private socket: WsConnection | undefined;
  private generation = 0;
  private current: TickerState = "idle";
  private attempts = 0;
  private reconnectTimer: unknown;
  private watchdogTimer: unknown;
  private lastFrameAt = 0;
  private opened = false;
  private statsData: TickerStats = { frames: 0, heartbeats: 0, ticks: 0, rejectedPackets: 0, rejectedFrames: 0, staleDropped: 0, ordersIgnored: 0, messagesIgnored: 0, reconnects: 0, lastActivityAt: null, rejectedByReason: {} };

  constructor(private readonly o: TickerOptions) {
    this.timers = o.timers ?? systemTimers;
    this.log = o.log ?? (() => undefined);
    this.maxInstruments = Math.min(Math.max(o.maxInstruments ?? 200, 1), 3000);
    this.maxAttempts = Math.max(o.maxReconnectAttempts ?? 8, 1);
    this.baseBackoff = o.baseBackoffMs ?? 1000;
    this.maxBackoff = o.maxBackoffMs ?? 30_000;
    this.inactivityMs = o.inactivityMs ?? 15_000;
  }

  state(): TickerState { return this.current; }
  stats(): TickerStats { return { ...this.statsData, rejectedByReason: { ...this.statsData.rejectedByReason } }; }
  subscribed(): number[] { return [...this.desired.keys()]; }
  storedCount(): number { return this.store.size; }
  /** For tests and diagnostics: 0 or 1 timers of each kind, never more. */
  pendingTimers(): { reconnect: boolean; watchdog: boolean } { return { reconnect: this.reconnectTimer !== undefined, watchdog: this.watchdogTimer !== undefined }; }
  hasSocket(): boolean { return this.socket !== undefined; }

  onTick(cb: (t: DecodedTick) => void): () => void { this.tickListeners.add(cb); return () => this.tickListeners.delete(cb); }
  onState(cb: (s: TickerState) => void): () => void { this.stateListeners.add(cb); return () => this.stateListeners.delete(cb); }

  // ───────────── subscriptions (desired state; re-sent after every reconnect) ─────────────

  subscribe(instruments: readonly KiteInstrument[], mode: TickerMode = "quote"): void {
    this.assertLive();
    const fresh = instruments.filter((i) => !this.desired.has(i.token));
    for (const i of instruments) if (this.o.catalog.instruments.find((c) => c.token === i.token) === undefined) throw new KiteError("UNSUPPORTED_CONTRACT");
    if (this.desired.size + fresh.length > this.maxInstruments) throw new KiteError("INVALID_REQUEST");
    for (const i of instruments) { this.desired.set(i.token, { instrument: i, mode }); if (!this.store.has(i.token)) this.store.set(i.token, { validated: null, limited: null }); }
    if (this.current === "connected") { this.sendSubscribe(instruments.map((i) => i.token), mode); }
  }

  unsubscribe(instruments: readonly KiteInstrument[]): void {
    this.assertLive();
    const tokens = instruments.filter((i) => this.desired.has(i.token)).map((i) => i.token);
    for (const t of tokens) { this.desired.delete(t); this.store.delete(t); }
    if (this.current === "connected" && tokens.length) this.sendAll("unsubscribe", tokens);
  }

  setMode(mode: TickerMode, instruments: readonly KiteInstrument[]): void {
    this.assertLive();
    const tokens = instruments.filter((i) => this.desired.has(i.token)).map((i) => i.token);
    for (const t of tokens) { const d = this.desired.get(t); if (d) d.mode = mode; }
    if (this.current === "connected" && tokens.length) this.sendMode(mode, tokens);
  }

  // ───────────── lifecycle ─────────────

  /** Idempotent: never opens a second connection or a second timer. Restartable after stop(), auth_failed and failed. */
  start(): void {
    this.assertLive();
    if (this.socket || this.reconnectTimer !== undefined) return;
    this.attempts = 0;
    this.connect(false);
  }

  /** Closes the socket and clears every timer. Cached ticks are kept but can no longer be "fresh" (not connected). */
  stop(): void {
    if (this.current === "disposed") return;
    this.teardown();
    this.setState("stopped");
  }

  /** Final: stop + drop every stored tick and subscription. */
  dispose(): void {
    if (this.current === "disposed") return;
    this.teardown();
    this.desired.clear();
    this.store.clear();
    this.tickListeners.clear();
    this.setState("disposed");
    this.stateListeners.clear();
  }

  private assertLive(): void { if (this.current === "disposed") throw new KiteError("INVALID_REQUEST"); }

  private teardown(): void {
    this.generation += 1; // events from the old socket are ignored from here on
    if (this.reconnectTimer !== undefined) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.clearWatchdog();
    const s = this.socket;
    this.socket = undefined;
    if (s) { try { s.close(); } catch { /* already closed */ } }
  }

  private setState(next: TickerState): void {
    if (this.current === next) return;
    this.current = next;
    this.log("ticker.state", { state: next });
    for (const cb of [...this.stateListeners]) { try { cb(next); } catch { /* listener errors never break the ticker */ } }
  }

  // ───────────── connection ─────────────

  private connect(isReconnect: boolean): void {
    if (!PLAN_CAPABILITIES[this.o.plan ?? "personal"].websocket) { this.fail("failed", "plan_restricted"); return; } // checked locally: no socket is opened
    const token = this.o.session.usableToken();
    if (!token) { this.fail("auth_failed", "no_usable_session"); return; }
    const gen = ++this.generation;
    this.opened = false;
    this.setState(isReconnect ? "reconnecting" : "connecting");
    let ws: WsConnection;
    try {
      const base = this.o.baseUrl ?? "wss://ws.kite.trade";
      ws = this.o.factory(`${base}?api_key=${encodeURIComponent(this.o.apiKey)}&access_token=${encodeURIComponent(token)}`); // credentials: never logged
    } catch (e) {
      this.log("ticker.connect_failed", { errorName: e instanceof Error ? e.name : "Error" });
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onOpen(() => { if (gen !== this.generation) return; this.opened = true; this.lastFrameAt = this.timers.now(); this.setState("connected"); this.armWatchdog(gen); this.resubscribe(); });
    ws.onMessage((data) => { if (gen === this.generation) this.handle(data); });
    ws.onError(() => { /* the close event that follows decides; the error carries nothing we may log */ });
    ws.onClose((code) => {
      if (gen !== this.generation) return;
      this.socket = undefined;
      this.clearWatchdog();
      this.log("ticker.closed", { code, wasOpen: this.opened });
      this.scheduleReconnect();
    });
  }

  private resubscribe(): void {
    const byMode = new Map<TickerMode, number[]>();
    for (const [token, d] of this.desired) byMode.set(d.mode, [...(byMode.get(d.mode) ?? []), token]);
    const all = [...this.desired.keys()];
    if (all.length) this.sendAll("subscribe", all);
    for (const [mode, tokens] of byMode) if (mode !== "quote") this.sendMode(mode, tokens); // "quote" is the server default after subscribing; send it explicitly too
    if (byMode.has("quote")) this.sendMode("quote", byMode.get("quote") as number[]);
  }

  private sendSubscribe(tokens: number[], mode: TickerMode): void { this.sendAll("subscribe", tokens); this.sendMode(mode, tokens); }
  private sendAll(action: "subscribe" | "unsubscribe", tokens: number[]): void {
    for (let i = 0; i < tokens.length; i += CHUNK) this.sendJson({ a: action, v: tokens.slice(i, i + CHUNK) });
  }
  private sendMode(mode: TickerMode, tokens: number[]): void {
    for (let i = 0; i < tokens.length; i += CHUNK) this.sendJson({ a: "mode", v: [mode, tokens.slice(i, i + CHUNK)] });
  }
  /** Only subscribe / unsubscribe / mode messages exist in this class. */
  private sendJson(msg: { a: "subscribe" | "unsubscribe" | "mode"; v: unknown }): void {
    try { this.socket?.send(JSON.stringify(msg)); } catch { this.log("ticker.send_failed"); }
  }

  private scheduleReconnect(): void {
    if (this.current === "stopped" || this.current === "disposed" || this.current === "auth_failed" || this.current === "failed") return;
    this.attempts += 1;
    if (this.attempts > this.maxAttempts) { this.fail("failed", "max_reconnect_attempts"); return; }
    if (this.reconnectTimer !== undefined) return; // never two timers
    const delay = Math.min(this.baseBackoff * 2 ** (this.attempts - 1), this.maxBackoff);
    this.setState("reconnecting");
    this.statsData.reconnects += 1;
    const gen = this.generation;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (gen !== this.generation) return;
      void this.reconnectNow();
    }, delay);
  }

  private async reconnectNow(): Promise<void> {
    const gen = this.generation;
    if (this.o.checkSession) {
      try { await this.o.checkSession(); } catch (e) {
        if (e instanceof KiteError && (e.code === "SESSION_INVALID" || e.code === "NO_SESSION")) { if (gen === this.generation) this.fail("auth_failed", "session_rejected"); return; }
      }
    }
    if (gen !== this.generation || this.socket) return;
    this.connect(true);
  }

  private fail(state: "auth_failed" | "failed", reason: string): void {
    this.teardown();
    this.log("ticker.stopped", { state, reason });
    this.setState(state);
  }

  private armWatchdog(gen: number): void {
    this.clearWatchdog();
    this.watchdogTimer = this.timers.setTimeout(() => {
      this.watchdogTimer = undefined;
      if (gen !== this.generation) return;
      if (this.o.session.state().status === "invalid") { this.fail("auth_failed", "session_invalidated"); return; }
      if (this.timers.now() - this.lastFrameAt >= this.inactivityMs) {
        this.log("ticker.inactive");
        const s = this.socket; this.socket = undefined; this.generation += 1;
        try { s?.close(); } catch { /* ignore */ }
        this.scheduleReconnect();
        return;
      }
      this.armWatchdog(gen);
    }, Math.max(Math.floor(this.inactivityMs / 3), 1));
  }
  private clearWatchdog(): void { if (this.watchdogTimer !== undefined) { this.timers.clearTimeout(this.watchdogTimer); this.watchdogTimer = undefined; } }

  // ───────────── inbound ─────────────

  private handle(data: string | Uint8Array): void {
    if (typeof data === "string") { this.handleText(data); return; }
    if (data.length > MAX_BYTES) { this.statsData.rejectedFrames += 1; return; }
    const now = this.timers.now();
    const frame = decodeFrame(data, (token) => this.desired.get(token)?.instrument, now);
    // any well-formed or heartbeat frame proves the CONNECTION is alive; it says nothing about quote freshness
    if (frame.frameError) { this.statsData.rejectedFrames += 1; this.log("ticker.bad_frame", { reason: frame.frameError }); return; }
    this.touch(now);
    this.attempts = 0;
    if (frame.heartbeat) { this.statsData.heartbeats += 1; return; }
    this.statsData.frames += 1;
    for (const r of frame.rejected) {
      this.statsData.rejectedPackets += 1;
      const n = (this.statsData.rejectedByReason[r.reason] ?? 0) + 1;
      this.statsData.rejectedByReason[r.reason] = n;
      if (n === 1 || n % 100 === 0) this.log("ticker.bad_packet", { reason: r.reason, count: n });
    }
    for (const t of frame.ticks) this.accept(t);
  }

  private touch(now: number): void { this.lastFrameAt = now; this.statsData.lastActivityAt = new Date(now).toISOString(); }

  private accept(t: DecodedTick): void {
    const slot = this.store.get(t.instrument.token);
    if (!slot) return; // unsubscribed between decode and store
    const key = `${t.instrument.exchange}:${t.instrument.tradingSymbol}`;
    if (t.quote && t.exchangeTimestamp) {
      const prev = slot.validated;
      if (prev && Date.parse(t.exchangeTimestamp) < Date.parse(prev.exchangeTimestamp)) { this.statsData.staleDropped += 1; return; } // never move an instrument backwards in time
      slot.validated = { instrumentKey: key, layout: t.layout, quote: t.quote, exchangeTimestamp: t.exchangeTimestamp, lastTradeTime: t.lastTradeTime, receivedAt: t.receivedAt, dayOhlc: t.dayOhlc };
    } else {
      // no exchange timestamp: kept as a LIMITED reading; it cannot refresh (or create) a validated quote
      slot.limited = { instrumentKey: key, layout: t.layout, lastPrice: t.lastPrice, receivedAt: t.receivedAt, volume: t.volume, dayOhlc: t.dayOhlc, reason: "no_exchange_timestamp" };
    }
    this.statsData.ticks += 1;
    if (this.statsData.ticks % 100 === 0) this.log("ticker.ticks_accepted", { count: this.statsData.ticks }); // count only, never a payload
    for (const cb of [...this.tickListeners]) { try { cb(t); } catch { /* ignore */ } }
  }

  private handleText(text: string): void {
    this.touch(this.timers.now());
    if (text.length > MAX_TEXT) { this.statsData.messagesIgnored += 1; return; }
    let type: unknown;
    let errorData: unknown;
    try { const j = JSON.parse(text) as { type?: unknown; data?: unknown }; type = j.type; if (j.type === "error") errorData = j.data; } catch { this.statsData.messagesIgnored += 1; return; }
    if (type === "order") { this.statsData.ordersIgnored += 1; return; } // order postbacks: counted only; payload neither stored nor logged
    if (type === "error") {
      if (typeof errorData === "string" && AUTH_ERROR.test(errorData)) {
        this.o.session.markInvalid();
        this.fail("auth_failed", "server_rejected_session"); // fixed reason: the server text is not logged
        return;
      }
      this.log("ticker.server_error"); // content deliberately not logged
      return;
    }
    this.statsData.messagesIgnored += 1; // "message" and anything unknown
  }

  // ───────────── reads ─────────────

  get(token: number): StoredTicks | undefined {
    const s = this.store.get(token);
    return s ? { validated: s.validated, limited: s.limited } : undefined;
  }

  /**
   * Freshness is judged ONLY from the exchange timestamp against the local clock, and only while connected. Receiving heartbeats, reconnecting, or
   * receiving a timestamp-less packet never makes a cached quote fresh.
   */
  freshness(token: number, maxAgeMs: number): Freshness {
    const s = this.store.get(token);
    if (!s) return { state: "no_data" };
    if (!s.validated) return s.limited ? { state: "limited", reason: "no_exchange_timestamp", receivedAt: s.limited.receivedAt } : { state: "no_data" };
    const v = s.validated;
    const ageMs = this.timers.now() - Date.parse(v.exchangeTimestamp);
    const base = { ageMs, exchangeTimestamp: v.exchangeTimestamp, receivedAt: v.receivedAt };
    if (this.current !== "connected") return { state: "disconnected", ...base };
    if (ageMs < -MAX_FUTURE_SKEW_MS) return { state: "invalid_future", ...base };
    return ageMs > maxAgeMs ? { state: "stale", ...base } : { state: "fresh", ...base };
  }
}
