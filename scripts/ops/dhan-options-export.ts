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
import { runDhanOptionsPass } from "../../packages/providers/src/index";

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
