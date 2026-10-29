import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { buildAlert, severityRank, SEVERITIES, type AlertPayload, type Severity } from "./payload";
import type { AlertSender } from "./sender";

/**
 * Alert relay. The application containers live on an internal network with no internet; the relay is the ONE component that holds the webhook
 * credential and can reach it. Services post their (already sanitised) alert to the relay over the internal network with a shared bearer token;
 * the relay re-validates and re-sanitises the payload (a compromised service cannot inject free text or secrets), rate-limits, and forwards it.
 * It is not published on any host port and has no route for anything else.
 */
export interface RelayStatus {
  startedAt: string;
  destinations: string[];
  delivered: number;
  failed: number;
  /** CRITICAL alerts that no destination accepted yet and are being retried. */
  pendingCritical: number;
  /** Every CRITICAL alert that failed its first delivery (counted once each). */
  undeliveredCritical: number;
  /** CRITICAL alerts abandoned after the retry window (never silent: logged and counted here). */
  droppedCritical: number;
  lastDeliveryAt: string | null;
  lastUndeliveredCriticalAt: string | null;
  /** Outcome per destination of the most recent alerts, newest first (event + severity + time only). */
  recent: Array<{ event: string; severity: Severity; at: string; results: Array<{ destination: string; ok: boolean }> }>;
}

export interface RelayOptions {
  token: string;
  /** One or more destinations; each alert goes to all of them. `sender` is shorthand for a single destination. */
  destinations?: AlertSender[];
  sender?: AlertSender;
  /** Max alerts forwarded per minute (default 30); excess non-CRITICAL is dropped and counted in the next alert. */
  perMinute?: number;
  /** How long an undelivered CRITICAL alert is retried (default 2 h) and the first retry delay (default 30 s, doubling to 5 min). */
  criticalRetryWindowMs?: number;
  retryBaseMs?: number;
  /** Retry loop interval (default 15 s). 0 disables the timer (tests call retryPending()). */
  retryTickMs?: number;
  now?: () => Date;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Called with the status after every change (the process entry point persists it to a status file). */
  onStatus?: (status: RelayStatus) => void;
}

export interface RelayServer extends Server {
  status(): RelayStatus;
  /** Retries pending CRITICAL alerts that are due. Returns how many were delivered. */
  retryPending(): Promise<number>;
}

const MAX_BODY = 8 * 1024;

export function createRelayServer(options: RelayOptions): RelayServer {
  const now = options.now ?? (() => new Date());
  const perMinute = options.perMinute ?? 30;
  const destinations = options.destinations ?? (options.sender ? [options.sender] : []);
  const window = options.criticalRetryWindowMs ?? 2 * 3_600_000;
  const base = options.retryBaseMs ?? 30_000;
  let windowStart = 0;
  let used = 0;
  let dropped = 0;
  const log = options.log ?? (() => undefined);
  const expected = Buffer.from(options.token);
  const state: RelayStatus = { startedAt: now().toISOString(), destinations: destinations.map((d) => d.label), delivered: 0, failed: 0, pendingCritical: 0, undeliveredCritical: 0, droppedCritical: 0, lastDeliveryAt: null, lastUndeliveredCriticalAt: null, recent: [] };
  const pending: Array<{ payload: AlertPayload; firstAt: number; tries: number; nextAt: number }> = [];
  const publish = (): void => { state.pendingCritical = pending.length; try { options.onStatus?.({ ...state, recent: [...state.recent] }); } catch { /* status persistence must not break delivery */ } };

  /** Sends to every destination; returns per-destination results. */
  async function deliver(payload: AlertPayload): Promise<Array<{ destination: string; ok: boolean }>> {
    if (destinations.length === 0) return [];
    return Promise.all(destinations.map(async (d) => ({ destination: d.label, ok: await d.send(payload).catch(() => false) })));
  }
  function record(payload: AlertPayload, results: Array<{ destination: string; ok: boolean }>): void {
    state.recent = [{ event: payload.event, severity: payload.severity, at: now().toISOString(), results }, ...state.recent].slice(0, 10);
  }
  async function handle(payload: AlertPayload): Promise<void> {
    const results = await deliver(payload);
    record(payload, results);
    if (results.some((r) => r.ok)) {
      state.delivered += 1;
      state.lastDeliveryAt = now().toISOString();
      const failedDest = results.filter((r) => !r.ok).map((r) => r.destination);
      log("relay.forwarded", { alertEvent: payload.event, severity: payload.severity, destinations: results.filter((r) => r.ok).map((r) => r.destination), ...(failedDest.length ? { failedDestinations: failedDest } : {}) });
    } else {
      state.failed += 1;
      if (payload.severity === "CRITICAL") {
        // never silent: logged at error level, counted, kept for retry
        state.undeliveredCritical += 1;
        state.lastUndeliveredCriticalAt = now().toISOString();
        pending.push({ payload, firstAt: now().getTime(), tries: 0, nextAt: now().getTime() + base });
        log("relay.undelivered_critical", { alertEvent: payload.event, severity: payload.severity, reason: destinations.length === 0 ? "no_destination_configured" : "all_destinations_failed", retryWindowSeconds: Math.floor(window / 1000) });
      } else {
        log("relay.forward_failed", { alertEvent: payload.event, severity: payload.severity, reason: destinations.length === 0 ? "no_destination_configured" : "all_destinations_failed" });
      }
    }
    publish();
  }
  let retrying = false;
  async function retryPending(): Promise<number> {
    if (retrying) return 0;
    retrying = true;
    let ok = 0;
    try {
      for (const item of [...pending]) {
        const t = now().getTime();
        if (t < item.nextAt) continue;
        item.tries += 1;
        const results = await deliver(item.payload);
        if (results.some((r) => r.ok)) {
          pending.splice(pending.indexOf(item), 1);
          state.delivered += 1;
          state.lastDeliveryAt = now().toISOString();
          ok += 1;
          log("relay.forwarded", { alertEvent: item.payload.event, severity: item.payload.severity, retry: item.tries, destinations: results.filter((r) => r.ok).map((r) => r.destination) });
        } else if (t - item.firstAt >= window) {
          pending.splice(pending.indexOf(item), 1);
          state.droppedCritical += 1;
          log("relay.critical_dropped", { alertEvent: item.payload.event, severity: "CRITICAL", reason: "retry_window_exhausted", tries: item.tries });
        } else {
          item.nextAt = t + Math.min(300_000, base * 2 ** item.tries);
        }
      }
    } finally {
      retrying = false;
      publish();
    }
    return ok;
  }
  const authorised = (header: string | undefined): boolean => {
    const given = Buffer.from((header ?? "").replace(/^Bearer /i, ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const server = createServer((req, res) => {
    const reply = (code: number, body: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") return reply(200, { status: "ok", service: "alert-relay" });
    if (req.method === "GET" && req.url === "/v1/status") {
      if (!authorised(req.headers.authorization)) return reply(401, { error: "Unauthorized" });
      return reply(200, { ...state, recent: state.recent });
    }
    if (req.method !== "POST" || req.url !== "/v1/alert") return reply(404, { error: "Not Found" });
    if (!authorised(req.headers.authorization)) { log("relay.rejected", { reason: "unauthorized" }); return reply(401, { error: "Unauthorized" }); }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reply(413, { error: "too large" }); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      let input: Partial<AlertPayload>;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<AlertPayload>; } catch { return reply(400, { error: "invalid json" }); }
      let payload: AlertPayload;
      try {
        if (input.v !== 1 || !SEVERITIES.includes(input.severity as Severity)) throw new Error("contract");
        payload = buildAlert(
          { event: String(input.event), severity: input.severity as Severity, code: String(input.code ?? ""), summary: String(input.summary ?? ""), correlationId: input.correlationId, details: input.details },
          { environment: String(input.environment ?? ""), service: String(input.service ?? ""), build: input.build },
          now(),
        );
      } catch { log("relay.rejected", { reason: "invalid_payload" }); return reply(400, { error: "invalid payload" }); }
      const t = now().getTime();
      if (t - windowStart >= 60_000) { windowStart = t; used = 0; }
      if (used >= perMinute && severityRank(payload.severity) < severityRank("CRITICAL")) { dropped += 1; return reply(429, { error: "rate limited" }); }
      used += 1;
      if (dropped > 0) { payload.details["droppedSinceLast"] = dropped; dropped = 0; }
      void handle(payload);
      reply(202, { accepted: true });
    });
  }) as RelayServer;
  server.status = () => ({ ...state, recent: [...state.recent] });
  server.retryPending = retryPending;
  const tick = options.retryTickMs ?? 15_000;
  if (tick > 0) {
    const timer = setInterval(() => void retryPending(), tick);
    timer.unref();
    server.on("close", () => clearInterval(timer));
  }
  publish();
  return server;
}

/** Sender used by the application containers: posts to the relay (internal network, bearer token). */
export function createRelaySender(config: { url: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }): AlertSender {
  const u = new URL(config.url);
  const doFetch = config.fetchImpl ?? fetch;
  return {
    label: `relay:${u.host}`,
    async send(payload) {
      try {
        const res = await doFetch(u.toString(), { method: "POST", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs ?? 3000), headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify(payload) });
        return res.status === 202;
      } catch {
        return false;
      }
    },
  };
}
