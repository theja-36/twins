/**
 * Morning login for the Kite Connect token (P0-2 token persistence). Kite tokens lapse every day (around 06:00 IST), and the login itself needs a human in a browser; this tool is the host half.
 *
 *   kite-login url                 prints the login URL (the api key is not a secret). Open it in a browser, log in, and copy the `request_token` from the redirect URL.
 *   kite-login exchange            reads the request token from STDIN (hidden when it is a terminal; never an argument, so it does not reach the process list or shell history),
 *                                  exchanges it (ONE live call: POST /session/token), and stores the access token in the 0600 token file.
 *   kite-login verify              LIVE read-only check of the stored token (GET /user/profile). A rejected token is removed and `kite.session.invalidated` is logged (alert rule).
 *   kite-login status              file-only: whether a token is stored, when it was issued and its ADVISORY expiry. Never prints the token. No network.
 *   kite-login clear               removes the stored token.
 *
 * Environment: TWINS_KITE_API_KEY and TWINS_KITE_API_SECRET (for `exchange`), TWINS_KITE_TOKEN_FILE (absolute path, default /var/lib/twins-kite/kite-token.json). The shared live-trading guard runs
 * first. Exit codes: 0 ok, 1 failed, 2 usage / configuration, 3 refused (token rejected / not stored). Nothing here can place an order: the client has no write method and the allowlist refuses every write path.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { KiteClient, KiteError, KiteTokenStore, KITE_ENV, Session, loadKiteConfig, loginUrl, loadKitePlan, type KiteConfig } from "../../packages/kite/src/index";

export interface LoginDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The request token, entered hidden (tests inject a value). */
  readSecret: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Structured log sink for `kite.session.invalidated` (the real entry point passes the alerting logger). */
  log?: (event: string, fields: Record<string, unknown>) => void;
}
export const DEFAULT_TOKEN_FILE = "/var/lib/twins-kite/kite-token.json";
const USAGE = "usage: kite-login url | exchange | verify | status | clear";

export async function readSecretFromStdin(): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    process.stderr.write("request_token (hidden): ");
    const rl = createInterface({ input: stdin, output: process.stderr, terminal: true });
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined; // do not echo
    return new Promise((resolve) => rl.question("", (answer) => { rl.close(); process.stderr.write("\n"); resolve(answer.trim()); }));
  }
  const chunks: Buffer[] = [];
  for await (const c of stdin) { chunks.push(c as Buffer); if (Buffer.concat(chunks).length > 4096) break; }
  return Buffer.concat(chunks).toString("utf8").split("\n")[0]?.trim() ?? "";
}

export async function main(argv: string[], deps: LoginDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || !["url", "exchange", "verify", "status", "clear"].includes(cmd) || rest.length > 0) { deps.err(USAGE); return 2; }
  const now = deps.now ?? (() => new Date());
  const file = deps.env["TWINS_KITE_TOKEN_FILE"] || DEFAULT_TOKEN_FILE;
  let store: KiteTokenStore;
  try { store = new KiteTokenStore(file, now); } catch { deps.err("TWINS_KITE_TOKEN_FILE must be an absolute path"); return 2; }
  if (cmd === "status") { deps.out(JSON.stringify(store.status())); return 0; }
  if (cmd === "clear") { store.clear(); deps.out(JSON.stringify({ cleared: true })); return 0; }
  let cfg: KiteConfig;
  try { cfg = loadKiteConfig(deps.env); } catch { deps.err(`${KITE_ENV.apiKey} is missing or malformed`); return 2; }
  if (cmd === "url") { deps.out(loginUrl(cfg.apiKey)); return 0; }

  let plan;
  try { plan = loadKitePlan(deps.env); } catch { deps.err("TWINS_KITE_PLAN must be personal or connect"); return 2; }
  const session = new Session(now, (reason) => { store.clear(); deps.log?.("kite.session.invalidated", { reason }); });
  const client = new KiteClient({ apiKey: cfg.apiKey, ...(cfg.apiSecret ? { apiSecret: cfg.apiSecret } : {}), session, plan, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  try {
    if (cmd === "exchange") {
      if (!cfg.apiSecret) { deps.err(`${KITE_ENV.apiSecret} is required for exchange`); return 2; }
      const requestToken = await deps.readSecret();
      if (!requestToken) { deps.err("no request token on stdin"); return 2; }
      await client.exchangeRequestToken(requestToken);
      const token = session.usableToken();
      if (!token) { deps.err("exchange returned no usable token"); return 1; }
      store.save(token, cfg.apiKey);
      deps.out(JSON.stringify({ stored: true, ...store.status() }));
      return 0;
    }
    // verify
    const stored = store.load(cfg.apiKey);
    if (!stored) { deps.err(JSON.stringify(store.status())); return 3; }
    session.setToken(stored.accessToken);
    await client.verifySession();
    deps.out(JSON.stringify({ verified: true, ...store.status() }));
    return 0;
  } catch (e) {
    const code = e instanceof KiteError ? e.code : "ERROR";
    deps.err(JSON.stringify({ failed: true, code }));
    return code === "SESSION_INVALID" || code === "AUTH_FAILED" ? 3 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  enforceLiveTradingGuard("kite-login");
  void main(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l), readSecret: readSecretFromStdin, log: (e, f) => console.error(JSON.stringify({ level: "error", event: e, ...f })) }).then((c) => process.exit(c));
}
