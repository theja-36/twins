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
export interface RelayOptions {
  token: string;
  sender: AlertSender;
  /** Max alerts forwarded per minute (default 30); excess is dropped and counted in the next alert. */
  perMinute?: number;
  now?: () => Date;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const MAX_BODY = 8 * 1024;

export function createRelayServer(options: RelayOptions): Server {
  const now = options.now ?? (() => new Date());
  const perMinute = options.perMinute ?? 30;
  let windowStart = 0;
  let used = 0;
  let dropped = 0;
  const log = options.log ?? (() => undefined);
  const expected = Buffer.from(options.token);
  const authorised = (header: string | undefined): boolean => {
    const given = Buffer.from((header ?? "").replace(/^Bearer /i, ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return createServer((req, res) => {
    const reply = (code: number, body: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") return reply(200, { status: "ok", service: "alert-relay" });
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
      void options.sender.send(payload).then((ok) => log(ok ? "relay.forwarded" : "relay.forward_failed", { alertEvent: payload.event, severity: payload.severity }));
      reply(202, { accepted: true });
    });
  });
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
