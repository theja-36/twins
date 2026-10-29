import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** SYNTHETIC historical-message fixtures only: no real channel, author, price history or message is used anywhere. */
export const MSG = {
  completeOption: "BUY NIFTY 24500 CE 29 OCT 2031 ABOVE 120 SL 90 TGT 150 180 premium",
  equity: "BUY RELIANCE @ 2800 SL 2750 TGT 2900 3000",
  equityNoStop: "BUY TCS @ 3500 TGT 3600",
  equityBadStop: "BUY INFY @ 1500 SL 1600 TGT 1700",
  optionNoExpiry: "BUY NIFTY 24500 CE @ 120 SL 90 TGT 150 premium",
  optionYearMissing: "BUY NIFTY 24500 CE 29 OCT @ 120 SL 90 TGT 150 premium",
  optionPeriodWord: "BUY NIFTY 24500 CE MONTHLY @ 120 SL 90 TGT 150 premium",
  optionNoBasis: "BUY NIFTY 24500 CE 29 OCT 2031 @ 120 SL 90 TGT 150",
  several: "BUY RELIANCE @ 2800 SL 2750 TGT 2900 SELL TCS @ 3500 SL 3600 TGT 3400",
  noise: "Good morning everyone, markets look calm today",
  // the token-shaped string is assembled at run time so that no credential-shaped literal exists in the repository
  withSecret: `BUY RELIANCE @ 2800 SL 2750 TGT 2900 token ${"123456789:" + "B".repeat(35)} mail trader@example.com`,
};

export interface RecordInput { channel: string; message_id: string | number; timestamp: string | number; text: string; [k: string]: unknown }

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "twins-hist-"));
}
export function writeJsonl(dir: string, name: string, records: unknown[], raw: string[] = []): string {
  const p = join(dir, name);
  writeFileSync(p, [...records.map((r) => JSON.stringify(r)), ...raw].join("\n") + "\n");
  return p;
}
export function writeJson(dir: string, name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}
const cell = (v: unknown): string => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function writeCsv(dir: string, name: string, columns: string[], rows: Array<Record<string, unknown>>): string {
  const p = join(dir, name);
  writeFileSync(p, [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n");
  return p;
}
/** Records for one synthetic channel: ids 1..n, one minute apart, texts cycling through the given list. */
export function makeRecords(channel: string, n: number, texts: readonly string[] = [MSG.equity, MSG.completeOption, MSG.noise], start = "2024-03-04T04:00:00Z"): RecordInput[] {
  const t0 = Date.parse(start);
  return Array.from({ length: n }, (_, i) => ({ channel, message_id: i + 1, timestamp: new Date(t0 + i * 60_000).toISOString(), text: texts[i % texts.length] as string }));
}
