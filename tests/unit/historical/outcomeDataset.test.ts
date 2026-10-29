import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDataset, DatasetError, fileProvider, memoryProvider } from "../../../packages/historical/src/outcomes/index";
import { dailyBars, datasetOf, equitySeries, optionSeries, underlyingSeries } from "../../support/outcomeFixtures";
import { tempDir } from "../../support/historicalFixtures";

const ROOT = join(__dirname, "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return (e as DatasetError).code; } return undefined; };
const ok = (bars: Array<Record<string, unknown>>) => datasetOf([equitySeries("ACME", bars)]);

describe("dataset validation rejects malformed data instead of repairing it", () => {
  it.each([
    ["an unknown format", { ...ok(dailyBars({ days: 2, base: 10 })), format: "x" }, "dataset_format_unsupported"],
    ["no series", datasetOf([]), "dataset_series_missing"],
    ["high below low", ok([{ t: "2030-01-02T00:00:00Z", o: 10, h: 9, l: 10, c: 10 }]), "bar_ohlc_inconsistent"],
    ["close outside the range", ok([{ t: "2030-01-02T00:00:00Z", o: 10, h: 11, l: 9, c: 12 }]), "bar_ohlc_inconsistent"],
    ["a negative price", ok([{ t: "2030-01-02T00:00:00Z", o: -1, h: 1, l: -1, c: 1 }]), "bar_price_invalid"],
    ["NaN as a string", ok([{ t: "2030-01-02T00:00:00Z", o: "NaN", h: 1, l: 1, c: 1 }]), "bar_price_invalid"],
    ["a timestamp without an offset", ok([{ t: "2030-01-02T00:00:00", o: 1, h: 1, l: 1, c: 1 }]), "bar_timestamp_invalid"],
    ["duplicate timestamps", ok([{ t: "2030-01-02T00:00:00Z", o: 1, h: 1, l: 1, c: 1 }, { t: "2030-01-02T00:00:00Z", o: 1, h: 1, l: 1, c: 1 }]), "bar_timestamps_not_increasing"],
    ["unsorted timestamps", ok([{ t: "2030-01-03T00:00:00Z", o: 1, h: 1, l: 1, c: 1 }, { t: "2030-01-02T00:00:00Z", o: 1, h: 1, l: 1, c: 1 }]), "bar_timestamps_not_increasing"],
    ["negative open interest", ok([{ t: "2030-01-02T00:00:00Z", o: 1, h: 1, l: 1, c: 1, oi: -5 }]), "bar_open_interest_invalid"],
    ["an option series without its contract", datasetOf([{ kind: "option_premium", symbol: "NIFTY", interval_seconds: 60, bars: [] }]), "option_series_contract_incomplete"],
    ["contract fields on an equity series", datasetOf([equitySeries("ACME", [], { strike: 5 })]), "contract_fields_on_non_option_series"],
    ["a duplicate series", datasetOf([equitySeries("ACME", []), equitySeries("ACME", [])]), "duplicate_series"],
  ])("%s", (_n, raw, expected) => { expect(code(() => buildDataset(raw, "a".repeat(64)))).toBe(expected); });
  it("accepts a zero option premium (an expired-worthless contract) but not a zero equity price", () => {
    expect(code(() => buildDataset(datasetOf([optionSeries("NIFTY", 1, "CE", "2030-01-25", [{ t: "2030-01-02T00:00:00Z", o: 0, h: 0, l: 0, c: 0 }])]), "a".repeat(64)))).toBeUndefined();
    expect(code(() => buildDataset(ok([{ t: "2030-01-02T00:00:00Z", o: 0, h: 0, l: 0, c: 0 }]), "a".repeat(64)))).toBe("bar_price_invalid");
  });
});

describe("providers", () => {
  const data = datasetOf([equitySeries("acme", dailyBars({ days: 3, base: 10 })), optionSeries("NIFTY", 24500, "CE", "2030-01-25", dailyBars({ days: 3, base: 5 })), underlyingSeries("NIFTY", dailyBars({ days: 3, base: 24000 }))]);
  it("the in-memory provider is deterministic, case-insensitive on symbols, and distinguishes CE from PE and strikes", () => {
    const p = memoryProvider([data]);
    expect(p.datasets()[0]?.contentSha256).toBe(memoryProvider([data]).datasets()[0]?.contentSha256);
    expect(p.findSeries({ kind: "equity_price", symbol: "ACME", market: "NSE" }).found?.series.key.symbol).toBe("ACME");
    expect(p.findSeries({ kind: "option_premium", underlying: "NIFTY", market: "NSE", strike: 24500, optionType: "CE", expiry: "2030-01-25" }).found).not.toBeNull();
    const pe = p.findSeries({ kind: "option_premium", underlying: "NIFTY", market: "NSE", strike: 24500, optionType: "PE", expiry: "2030-01-25" });
    expect(pe).toEqual({ found: null, underlyingAvailable: true }); // only the underlying exists: reported, never substituted
    expect(p.findSeries({ kind: "option_premium", underlying: "NIFTY", market: "NSE", strike: 24600, optionType: "CE", expiry: "2030-01-25" }).found).toBeNull();
    expect(p.findSeries({ kind: "equity_price", symbol: "OTHER", market: "NSE" })).toEqual({ found: null, underlyingAvailable: false });
  });
  it("the file provider hashes the file, accepts only .json, and refuses symlinks, malformed JSON and credential-like names", async () => {
    const dir = tempDir();
    const f = join(dir, "bars.json");
    writeFileSync(f, JSON.stringify(data));
    const p = await fileProvider([f]);
    expect(p.datasets()[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dir, "bad.json"), "{nope");
    await expect(fileProvider([join(dir, "bad.json")])).rejects.toMatchObject({ code: "dataset_json_malformed" });
    writeFileSync(join(dir, "bars.csv"), "a,b");
    await expect(fileProvider([join(dir, "bars.csv")])).rejects.toBeInstanceOf(DatasetError);
    symlinkSync(f, join(dir, "link.json"));
    await expect(fileProvider([join(dir, "link.json")])).rejects.toBeDefined();
    writeFileSync(join(dir, "id_rsa.json"), JSON.stringify(data));
    await expect(fileProvider([join(dir, "id_rsa.json")])).rejects.toBeDefined();
    await expect(fileProvider([])).rejects.toMatchObject({ code: "no_dataset_files" });
  });
});

describe("architecture: the outcome engine is research-only", () => {
  const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".ts") ? [`${d}/${e.name}`] : []));
  const files = [...walk("packages/historical/src/outcomes"), "scripts/ops/historical-evaluate.ts"];
  it("never imports the risk, broker, execution, approval or Telegram code and never touches the network", () => {
    for (const f of files) expect(strip(readFileSync(join(ROOT, f), "utf8")), f).not.toMatch(/@twins\/(risk|execution|broker|approval|adapter)|packages\/(risk|execution|broker)|adapters\/|approval-bot|api\.telegram|\bfetch\(|node:https?|node:net\b|zerodha|kite/i);
  });
  it("writes only the four outcome tables: no insert / update / delete targets any other table", () => {
    for (const f of files) {
      const text = strip(readFileSync(join(ROOT, f), "utf8"));
      for (const m of text.matchAll(/\b(?:db|tx)\.(insert|update|delete)\(\s*(?:schema\.)?(\w+)/g)) expect(m[2], f).toMatch(/^(historicalDatasets|historicalEvaluationRuns|historicalOutcomeLabels|historicalEvaluationEvents|L|E)$/);
      expect(text, f).not.toMatch(/\b(?:db|tx)\.(update|delete)\(/); // append-only: the engine never updates or deletes anything
    }
  });
  it("neither reads nor stores raw message text", () => {
    for (const f of files) expect(strip(readFileSync(join(ROOT, f), "utf8")), f).not.toMatch(/rawText|raw_text/);
  });
  it("is not wired into any runtime service (CLI only)", () => {
    for (const d of ["apps", "services", "adapters"]) for (const f of walk(d)) expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/historical-evaluate|packages\/historical|@twins\/historical/);
  });
});
