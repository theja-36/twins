/**
 * ONE live Marketaux request, only for the first permitted test (docs/twins/MARKETAUX_FIRST_TEST_RUNBOOK.md). It refuses to run without --permission-confirmed, which the owner passes only after
 * Marketaux's written permission and the firewall approval. It reads the key from a file (never an argument or the environment), asks for one page, and prints a SHAPE report: field names and types,
 * counts and ranges. No headline, URL, snippet or key is printed or saved.
 *   node --import tsx scripts/ops/marketaux-shape-check.ts --key-file ~/.twins-marketaux-key --permission-confirmed [--universe-csv constituents.csv ...]
 */
import { readFileSync } from "node:fs";
import { createFetcher, marketauxShapeReport, marketauxUrl, MARKETAUX_HOST } from "../../packages/providers/src/index";

const args = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
async function main(): Promise<number> {
  if (!args.includes("--permission-confirmed")) { console.error("refused: pass --permission-confirmed only after Marketaux's written permission and the owner's go-ahead (see the runbook)."); return 2; }
  const keyFile = arg("--key-file");
  if (!keyFile) { console.error("usage: --key-file <path> --permission-confirmed [--universe-csv <path>]"); return 2; }
  const key = readFileSync(keyFile, "utf8").trim();
  const universe = new Set(["NIFTY", "BANKNIFTY", "SENSEX"]);
  for (let i = 0; i < args.length; i += 1) if (args[i] === "--universe-csv" && args[i + 1]) for (const line of readFileSync(args[i + 1]!, "utf8").split(/\r?\n/)) { const s = line.split(",")[0]?.trim() ?? ""; if (/^[A-Z0-9&._-]{1,30}$/.test(s)) universe.add(s); }
  const now = new Date();
  const fetcher = createFetcher({ allowedHosts: [MARKETAUX_HOST], maxAttempts: 1, minIntervalMs: 2100 });
  let body: string;
  try { body = await fetcher(marketauxUrl(key, { publishedAfter: new Date(now.getTime() - 24 * 3_600_000), page: 1 })); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "error" })); return 1; } // fetch errors never carry the URL
  console.log(JSON.stringify({ ok: true, host: MARKETAUX_HOST, requests: 1, report: await marketauxShapeReport(body, { now, universe }) }, null, 2));
  return 0;
}
void main().then((c) => process.exit(c), () => { console.error("fatal"); process.exit(1); });
