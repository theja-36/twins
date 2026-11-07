/**
 * DORMANT. One-shot Dhan option-chain export (owner order 2026-11-07: converter wiring behind a disabled switch). Not part of the provider exporter loop, not a compose service, no firewall rule exists
 * for its host. It does nothing unless TWINS_DHAN_OPTIONS_ENABLED=true AND a token and client id are in the environment AND the host allows the connection; Dhan was skipped by the owner on 2026-11-06.
 *
 *   dhan-options-export once --expiry NIFTY:2031-10-29 [--expiry BANKNIFTY:2031-10-29 ...]
 *
 * Prints a fixed result line (no URL, no credential). Exit 0 for skipped / published, 1 for failed, 2 usage.
 */
import { pathToFileURL } from "node:url";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { parseOptionChainFile, parseOptionQuotesFile } from "../../packages/agents/src/index";
import { convertDhanOptionChain, DhanChainError, publishJson, PublishRefusedError, type DhanConverted } from "../../packages/providers/src/index";

/**
 * Dhan option-chain pass (owner order 2026-11-07: "converter wiring behind a DISABLED switch"). **Dormant by construction, and off in four independent ways**:
 *   1. `TWINS_DHAN_OPTIONS_ENABLED` must be exactly `true` (default: unset / false);
 *   2. an access token and client id must be supplied through the environment (never in a file in this repository, never logged);
 *   3. it is NOT part of the provider exporter loop and NOT a compose service: a person has to run `scripts/ops/dhan-options-export.ts` on purpose;
 *   4. no firewall rule and no egress allow-list entry exists for `api.dhan.co`, so a run from the staging containers is dropped at the host (the firewall change is a separate owner approval).
 * Dhan was SKIPPED by the owner on 2026-11-06 (the Data plan costs money). The request shape below (POST /v2/optionchain; headers `access-token` and `client-id`; body UnderlyingScrip, UnderlyingSeg,
 * Expiry) is an ASSUMPTION from public documentation as remembered and has never been executed; it must be checked against Dhan's official docs before any live use. Nothing here is a trading action.
 */
export const DHAN_HOST = "api.dhan.co";
export const DHAN_OPTION_CHAIN_PATH = "/v2/optionchain";
export const DHAN_ENV = { enabled: "TWINS_DHAN_OPTIONS_ENABLED", token: "TWINS_DHAN_ACCESS_TOKEN", clientId: "TWINS_DHAN_CLIENT_ID", underlyings: "TWINS_DHAN_UNDERLYINGS" } as const;
export const DHAN_QUOTES_FILE = "dhan-option-quotes.json";
export const DHAN_CHAIN_FILE = "dhan-option-chain.json";

export interface DhanUnderlying { symbol: string; scrip: number; segment: string }
export type DhanConfig = { enabled: false; reason: "disabled" | "credentials_missing" | "underlyings_missing" } | { enabled: true; token: string; clientId: string; underlyings: DhanUnderlying[] };
export class DhanConfigError extends Error { constructor(m: string) { super(m); this.name = "DhanConfigError"; } }

/** `NIFTY:13:IDX_I,BANKNIFTY:25:IDX_I` (the owner supplies the ids; none is hard-coded because they were never verified). Malformed => error, never a guess. */
export function parseUnderlyings(raw: string): DhanUnderlying[] {
  const out: DhanUnderlying[] = [];
  for (const part of raw.split(",")) {
    const m = /^\s*([A-Z][A-Z0-9&.-]{1,19}):(\d{1,9}):([A-Z_]{2,12})\s*$/.exec(part);
    if (!m) throw new DhanConfigError("TWINS_DHAN_UNDERLYINGS entries must look like SYMBOL:scripId:SEGMENT");
    out.push({ symbol: m[1] as string, scrip: Number(m[2]), segment: m[3] as string });
  }
  if (out.length === 0 || out.length > 5) throw new DhanConfigError("between 1 and 5 underlyings are allowed");
  return out;
}
export function loadDhanConfig(env: Record<string, string | undefined>): DhanConfig {
  if (env[DHAN_ENV.enabled] !== "true") {
    if (env[DHAN_ENV.enabled] !== undefined && env[DHAN_ENV.enabled] !== "" && env[DHAN_ENV.enabled] !== "false") throw new DhanConfigError(`${DHAN_ENV.enabled} must be true or false`);
    return { enabled: false, reason: "disabled" };
  }
  const token = env[DHAN_ENV.token], clientId = env[DHAN_ENV.clientId];
  if (!token || !clientId) return { enabled: false, reason: "credentials_missing" };
  const u = env[DHAN_ENV.underlyings];
  if (!u) return { enabled: false, reason: "underlyings_missing" };
  return { enabled: true, token, clientId, underlyings: parseUnderlyings(u) };
}

export type DhanErrorCode = "bad_request" | "http_error" | "timeout" | "network" | "redirect" | "too_large" | "bad_json";
export class DhanClientError extends Error { constructor(readonly code: DhanErrorCode, readonly status?: number) { super(status === undefined ? code : `${code}:${status}`); this.name = "DhanClientError"; } }

export interface DhanClientOptions { token: string; clientId: string; fetchFn?: typeof fetch; timeoutMs?: number; maxBytes?: number }
/** Host-pinned POST client. Errors carry a fixed code (and the HTTP status) only: never the URL, the headers, the body or the token. */
export function createDhanOptionChainClient(o: DhanClientOptions): (req: { underlying: DhanUnderlying; expiry: string }) => Promise<unknown> {
  const fetchFn = o.fetchFn ?? globalThis.fetch, timeoutMs = o.timeoutMs ?? 15_000, maxBytes = o.maxBytes ?? 3_000_000;
  return async ({ underlying, expiry }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new DhanClientError("bad_request");
    let res: Response;
    try {
      res = await fetchFn(`https://${DHAN_HOST}${DHAN_OPTION_CHAIN_PATH}`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json", "access-token": o.token, "client-id": o.clientId },
        body: JSON.stringify({ UnderlyingScrip: underlying.scrip, UnderlyingSeg: underlying.segment, Expiry: expiry }),
      });
    } catch (e) { throw new DhanClientError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network"); }
    if (res.status >= 300 && res.status < 400) throw new DhanClientError("redirect", res.status);
    if (res.status !== 200) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new DhanClientError("http_error", res.status); }
    if (Number(res.headers.get("content-length") ?? "0") > maxBytes) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new DhanClientError("too_large"); }
    const text = await res.text();
    if (text.length > maxBytes) throw new DhanClientError("too_large");
    try { return JSON.parse(text); } catch { throw new DhanClientError("bad_json"); }
  };
}

export interface DhanPassContext { env: Record<string, string | undefined>; providersDir: string; now: () => Date; expiries: Array<{ underlying: string; expiry: string }>; fetchFn?: typeof fetch }
export type DhanPassResult = { status: "skipped"; reason: string } | { status: "published"; quotes: number; chains: number; skippedLegs: number } | { status: "failed"; reason: string };

/** One pass over the requested (underlying, expiry) pairs. Disabled => returns before any client exists (no network call is possible). */
export async function runDhanOptionsPass(ctx: DhanPassContext): Promise<DhanPassResult> {
  const cfg = loadDhanConfig(ctx.env);
  if (!cfg.enabled) return { status: "skipped", reason: cfg.reason };
  if (ctx.expiries.length === 0 || ctx.expiries.length > 6) return { status: "failed", reason: "expiries_invalid" };
  const call = createDhanOptionChainClient({ token: cfg.token, clientId: cfg.clientId, ...(ctx.fetchFn ? { fetchFn: ctx.fetchFn } : {}) });
  const quotes: Record<string, unknown> = {}, chains: Record<string, unknown> = {};
  let skippedLegs = 0;
  const asOf = ctx.now();
  try {
    for (const { underlying, expiry } of ctx.expiries) {
      const u = cfg.underlyings.find((x) => x.symbol === underlying);
      if (!u) return { status: "failed", reason: "underlying_not_configured" };
      const converted: DhanConverted = convertDhanOptionChain(await call({ underlying: u, expiry }), { market: underlying === "SENSEX" ? "BSE" : "NSE", underlying, expiry, asOf });
      Object.assign(quotes, converted.quotesDoc["quotes"] as object);
      Object.assign(chains, converted.chainDoc["chains"] as object);
      skippedLegs += converted.skipped.length;
    }
    const iso = asOf.toISOString();
    publishJson(ctx.providersDir, DHAN_QUOTES_FILE, { format: "twins-option-quotes-v1", source: "dhan-option-chain", as_of: iso, quotes }, parseOptionQuotesFile);
    publishJson(ctx.providersDir, DHAN_CHAIN_FILE, { format: "twins-option-chain-v1", source: "dhan-option-chain", as_of: iso, chains }, parseOptionChainFile);
    return { status: "published", quotes: Object.keys(quotes).length, chains: Object.keys(chains).length, skippedLegs };
  } catch (e) {
    if (e instanceof DhanClientError) return { status: "failed", reason: `fetch_${e.code}${e.status ? `_${e.status}` : ""}` };
    if (e instanceof DhanChainError) return { status: "failed", reason: `response_${e.code}` };
    if (e instanceof PublishRefusedError) return { status: "failed", reason: "refused_validation" };
    return { status: "failed", reason: "error" };
  }
}


export async function runCli(argv: string[], deps: { env: Record<string, string | undefined>; out: (l: string) => void; err: (l: string) => void; now?: () => Date; fetchFn?: typeof fetch }): Promise<number> {
  const [cmd, ...rest] = argv;
  const expiries: Array<{ underlying: string; expiry: string }> = [];
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i] === "--expiry" ? /^([A-Z][A-Z0-9&.-]{1,19}):(\d{4}-\d{2}-\d{2})$/.exec(rest[i + 1] ?? "") : null;
    if (!m) { deps.err("usage: dhan-options-export once --expiry SYMBOL:YYYY-MM-DD [--expiry ...]"); return 2; }
    expiries.push({ underlying: m[1] as string, expiry: m[2] as string }); i++;
  }
  if (cmd !== "once" || expiries.length === 0) { deps.err("usage: dhan-options-export once --expiry SYMBOL:YYYY-MM-DD [--expiry ...]"); return 2; }
  try {
    const r = await runDhanOptionsPass({ env: deps.env, providersDir: deps.env["TWINS_PROVIDERS_DIR"] || "/var/lib/twins-providers", now: deps.now ?? (() => new Date()), expiries, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
    deps.out(JSON.stringify({ event: "dhan_options.pass", ...r }));
    return r.status === "failed" ? 1 : 0;
  } catch { deps.err("failed: configuration"); return 1; }
}
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  enforceLiveTradingGuard("dhan-options-export");
  runCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) }).then((c) => process.exit(c), () => process.exit(1));
}
