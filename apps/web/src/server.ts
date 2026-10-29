/**
 * Minimal LOCAL, READ-ONLY options-result viewer (Node built-ins only; no framework, no build, no new dependency).
 *
 *   npm run options:viewer -- [--api http://127.0.0.1:4010] [--port 4020]
 *
 * It serves one static page and one read-only route that forwards the owner's bearer token (supplied per request in
 * the Authorization header, never stored, logged, put in a URL or embedded in the page) to the existing
 * GET /options-claims/:messageId endpoint, then reshapes the STORED response. It binds to loopback only, talks only
 * to a loopback API, checks the Host header, sends no CORS headers, and never reparses or reassesses anything.
 */
import http from "node:http";
import { enforceLiveTradingGuard } from "@twins/config";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "./page";
import { buildView } from "./view";

export const DEFAULT_API_BASE = "http://127.0.0.1:4010";
export const DEFAULT_VIEWER_PORT = 4020;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

export interface ViewerOptions {
  apiBase?: string;
  host?: string;
  port?: number;
  /** Receives one short, secret-free line per request. Defaults to console.log. */
  log?: (line: string) => void;
}

export class ViewerConfigError extends Error {
  constructor(message: string) {
    super(`viewer configuration refused: ${message}`);
    this.name = "ViewerConfigError";
  }
}

function errorBody(kind: string, message: string) {
  return { error: { kind, message } };
}

export function createViewerServer(options: ViewerOptions = {}): { server: http.Server; listen: () => Promise<{ host: string; port: number }>; apiBase: string } {
  const apiBase = new URL(options.apiBase ?? DEFAULT_API_BASE);
  if (apiBase.protocol !== "http:" || !LOOPBACK_HOSTS.has(apiBase.hostname)) throw new ViewerConfigError("the API base must be a loopback http URL");
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new ViewerConfigError("the viewer binds to loopback only");
  const log = options.log ?? ((l: string) => console.log(l));
  let boundPort = options.port ?? DEFAULT_VIEWER_PORT;

  const send = (res: http.ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
    res.end(body);
  };
  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://viewer.local");
    const done = (status: number) => log(`${req.method ?? "?"} ${url.pathname} -> ${status}`); // path only: no query, no headers
    const reply = (status: number, type: string, body: string) => { send(res, status, type, body); done(status); };
    const replyJson = (status: number, body: unknown) => { sendJson(res, status, body); done(status); };

    // DNS-rebinding defence: only our own loopback origin is a valid Host.
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
    if (!allowedHosts.includes(hostHeader)) return replyJson(403, errorBody("forbidden_host", "Unexpected Host header."));
    if (req.method !== "GET") return replyJson(405, errorBody("method_not_allowed", "This viewer is read-only (GET only)."));

    if (url.pathname === "/") return reply(200, "text/html; charset=utf-8", PAGE_HTML);
    if (url.pathname === "/app.js") return reply(200, "text/javascript; charset=utf-8", PAGE_JS);
    if (url.pathname === "/app.css") return reply(200, "text/css; charset=utf-8", PAGE_CSS);

    const m = /^\/view\/options-claims\/([^/]+)$/.exec(url.pathname);
    if (!m) return replyJson(404, errorBody("not_found", "No such page."));
    const messageId = decodeURIComponent(m[1] ?? "");
    if (!UUID.test(messageId)) return replyJson(400, errorBody("invalid_id", "The message id must be a UUID (the internal telegram_messages id)."));
    const parserVersion = url.searchParams.get("parserVersion");
    if (parserVersion !== null && !VERSION.test(parserVersion)) return replyJson(400, errorBody("invalid_parser_version", "The parser version filter has an unexpected format."));

    const authorization = req.headers.authorization;
    const target = new URL(`/options-claims/${messageId}`, apiBase);
    if (parserVersion !== null) target.searchParams.set("parserVersion", parserVersion);
    let upstream: Response;
    try {
      upstream = await fetch(target, { method: "GET", headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(5000), redirect: "error" });
    } catch {
      return replyJson(502, errorBody("api_unavailable", "The TWINS API could not be reached. Is it running on the configured loopback address?"));
    }
    if (upstream.status === 401) return replyJson(401, errorBody("unauthorized", "The API rejected the token (or none was given)."));
    if (upstream.status === 400) return replyJson(400, errorBody("invalid_id", "The API rejected the message id."));
    if (upstream.status === 404) return replyJson(404, errorBody("not_found", "No options claim is recorded for this message (and parser version)."));
    if (upstream.status !== 200) return replyJson(502, errorBody("api_error", `The API answered with an unexpected status (${upstream.status}).`));
    try {
      return replyJson(200, buildView(await upstream.json()));
    } catch {
      return replyJson(502, errorBody("api_error", "The API response had an unexpected shape."));
    }
  });

  return {
    server,
    apiBase: apiBase.origin,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? DEFAULT_VIEWER_PORT, host, () => {
          const addr = server.address();
          if (addr === null || typeof addr === "string") return reject(new Error("no address"));
          boundPort = addr.port;
          resolve({ host: addr.address, port: addr.port });
        });
      }),
  };
}

async function main(): Promise<void> {
  enforceLiveTradingGuard("options-viewer");
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const portArg = opt("--port");
  const viewer = createViewerServer({ ...(opt("--api") ? { apiBase: opt("--api") as string } : {}), ...(portArg ? { port: Number(portArg) } : {}) });
  const bound = await viewer.listen();
  console.log(`TWINS options viewer (read-only) on http://${bound.host}:${bound.port}  ->  API ${viewer.apiBase}`);
  console.log("Enter the internal message id and your API bearer token in the page. Nothing is stored. Ctrl+C to stop.");
}

if (process.argv[1]?.endsWith("apps/web/src/server.ts")) {
  main().catch((err: unknown) => {
    console.error(`options viewer failed to start: ${err instanceof Error ? err.message : "error"}`);
    process.exit(1);
  });
}
