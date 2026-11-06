import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSourceHealth, observeProviderFiles, parsePassLog, ALL_PROVIDERS, FILES, type FileObservation, type PassEvent } from "../../../packages/providers/src/index";

const NOW = new Date("2026-11-06T13:30:00.000Z");
const iso = (minAgo: number): string => new Date(NOW.getTime() - minAgo * 60_000).toISOString();
const obs = (provider: FileObservation["provider"], over: Partial<FileObservation> = {}): FileObservation => ({ provider, present: true, readable: true, asOf: iso(20), modifiedAt: iso(20), format: "x", source: "s", count: 3, ...over });
const allGood = (): FileObservation[] => ALL_PROVIDERS.map((p) => obs(p));
const ev = (provider: PassEvent["provider"], outcome: PassEvent["outcome"], minAgo: number, reason: string | null = null): PassEvent => ({ at: iso(minAgo), provider, outcome, reason });
const byName = (p: ReturnType<typeof buildSourceHealth>, n: string) => p.providers.find((x) => x.provider === n)!;

describe("source health profile", () => {
  it("is OK and usable when every file is fresh, with no pass log supplied", () => {
    const p = buildSourceHealth({ now: NOW, observations: allGood() });
    expect(p.overall).toBe("OK"); expect(p.passLogAvailable).toBe(false); expect(p.grantsApproval).toBe(false);
    expect(p.providers.every((x) => x.usable && x.reasons.length === 0 && x.consecutiveFailures === null)).toBe(true);
    expect(p.counts.OK).toBe(ALL_PROVIDERS.length);
  });
  it("a missing file is MISSING and unusable; a file that is not readable is INVALID and unusable", () => {
    const o = allGood().map((x) => x.provider === "news" ? obs("news", { present: false, readable: false, asOf: null, modifiedAt: null, count: null }) : x.provider === "sentiment" ? obs("sentiment", { readable: false, asOf: null }) : x);
    const p = buildSourceHealth({ now: NOW, observations: o });
    expect(byName(p, "news")).toMatchObject({ status: "MISSING", usable: false, reasons: ["file_missing"] });
    expect(byName(p, "sentiment")).toMatchObject({ status: "INVALID", usable: false, reasons: ["file_unreadable"] });
    expect(p.overall).toBe("INVALID");
  });
  it("a provider with no observation at all is MISSING (never assumed healthy)", () => {
    const p = buildSourceHealth({ now: NOW, observations: allGood().filter((x) => x.provider !== "macro") });
    expect(byName(p, "macro").status).toBe("MISSING");
  });
  it("stale data and a stale export are judged separately, with the macro file allowed a longer data horizon", () => {
    const p = buildSourceHealth({ now: NOW, observations: allGood().map((x) =>
      x.provider === "calendar" ? obs("calendar", { asOf: iso(7 * 60) }) // 7 h old data, fresh export
      : x.provider === "holidays" ? obs("holidays", { modifiedAt: iso(200) }) // exporter has not rewritten it
      : x.provider === "macro" ? obs("macro", { asOf: iso(30 * 60) }) // 30 h old: fine for macro (72 h), because it only moves on a Kite feed run
      : x) });
    expect(byName(p, "calendar")).toMatchObject({ status: "STALE", reasons: ["data_stale"], usable: false });
    expect(byName(p, "holidays")).toMatchObject({ status: "STALE", reasons: ["export_stale"], usable: false });
    expect(byName(p, "macro").status).toBe("OK");
    const old = buildSourceHealth({ now: NOW, observations: allGood().map((x) => x.provider === "macro" ? obs("macro", { asOf: iso(80 * 60) }) : x) });
    expect(byName(old, "macro")).toMatchObject({ status: "STALE", reasons: ["data_stale"] });
  });
  it("one failed pass is DEGRADED (still usable); two consecutive failures are FAILING; a later publish resets the count", () => {
    const one = buildSourceHealth({ now: NOW, observations: allGood(), events: [ev("news", "published", 130), ev("news", "failed", 70, "fetch_network")] });
    expect(byName(one, "news")).toMatchObject({ status: "DEGRADED", usable: true, consecutiveFailures: 1, reasons: ["last_pass_failed"] });
    const two = buildSourceHealth({ now: NOW, observations: allGood(), events: [ev("news", "failed", 130, "fetch_network"), ev("news", "failed", 70, "fetch_network")] });
    expect(byName(two, "news")).toMatchObject({ status: "FAILING", usable: false, consecutiveFailures: 2, reasons: ["repeated_failures"], lastPass: { outcome: "failed", reason: "fetch_network" } });
    const reset = buildSourceHealth({ now: NOW, observations: allGood(), events: [ev("news", "failed", 130), ev("news", "failed", 70), ev("news", "published", 10)] });
    expect(byName(reset, "news")).toMatchObject({ status: "OK", consecutiveFailures: 0, reasons: [] });
  });
  it("a skipped pass is a configuration state: DEGRADED, not a failure; a provider absent from a supplied log is flagged", () => {
    const p = buildSourceHealth({ now: NOW, observations: allGood(), events: [ev("sentiment", "skipped", 10, "provider_rate_limited")] });
    expect(byName(p, "sentiment")).toMatchObject({ status: "DEGRADED", consecutiveFailures: 0, reasons: ["last_pass_skipped"] });
    expect(byName(p, "macro").reasons).toEqual(["no_pass_logged"]);
    expect(byName(p, "macro").status).toBe("OK");
  });
  it("a missing file plus repeated failures reports MISSING (the worst) and keeps both reasons", () => {
    const o = allGood().map((x) => x.provider === "news" ? obs("news", { present: false, readable: false, asOf: null, modifiedAt: null, count: null }) : x);
    const p = buildSourceHealth({ now: NOW, observations: o, events: [ev("news", "failed", 130), ev("news", "failed", 70)] });
    expect(byName(p, "news")).toMatchObject({ status: "MISSING", reasons: ["file_missing", "repeated_failures"], usable: false });
  });
});

describe("pass log parsing", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ ts: "2026-11-06T13:06:56.000Z", service: "provider-exporter", ...o });
  it("keeps only pass events for known providers, in time order, and ignores everything else", () => {
    const text = [
      line({ event: "provider.published", provider: "calendar", file: "economic-calendar.json", count: 6 }),
      line({ event: "provider.failed", provider: "news", reason: "fetch_network" }),
      line({ event: "provider.failed", provider: "nonsense", reason: "x" }), line({ event: "something.else", provider: "news" }), "not json", "{broken",
      line({ ts: "2026-11-06T12:06:56.000Z", event: "provider.skipped", provider: "sentiment", reason: "key_missing" }),
    ].join("\n");
    const e = parsePassLog(text);
    expect(e.map((x) => [x.provider, x.outcome, x.reason])).toEqual([["sentiment", "skipped", "key_missing"], ["calendar", "published", null], ["news", "failed", "fetch_network"]]);
  });
  it("never copies an unusual reason string (it could carry a URL or a key) into the profile", () => {
    const secretish = "https://example.invalid/x?api_token=SECRETVALUE";
    const e = parsePassLog(line({ event: "provider.failed", provider: "news", reason: secretish }));
    expect(e[0]!.reason).toBe("unrecognized");
    const p = buildSourceHealth({ now: NOW, observations: allGood(), events: e });
    expect(JSON.stringify(p)).not.toContain("SECRETVALUE");
  });
});

describe("observing the provider files", () => {
  it("describes present files read-only and reports absent ones as not present", () => {
    const d = mkdtempSync(join(tmpdir(), "sh-"));
    writeFileSync(join(d, FILES.calendar), JSON.stringify({ format: "twins-economic-calendar-v1", source: "fred", as_of: "2026-11-06T13:00:00.000Z", events: [{}, {}, {}] }));
    writeFileSync(join(d, FILES.sentiment), JSON.stringify({ format: "twins-sentiment-v1", source: "x", entries: { a: {} } })); // no as_of: not readable
    writeFileSync(join(d, FILES.news), "{not json");
    utimesSync(join(d, FILES.calendar), new Date("2026-11-06T13:01:00.000Z"), new Date("2026-11-06T13:01:00.000Z"));
    const o = observeProviderFiles(d);
    const g = (n: string) => o.find((x) => x.provider === n)!;
    expect(g("calendar")).toMatchObject({ present: true, readable: true, asOf: "2026-11-06T13:00:00.000Z", modifiedAt: "2026-11-06T13:01:00.000Z", count: 3, source: "fred" });
    expect(g("sentiment")).toMatchObject({ present: true, readable: false, asOf: null });
    expect(g("news")).toMatchObject({ present: true, readable: false });
    expect(g("macro")).toMatchObject({ present: false, readable: false });
    expect(observeProviderFiles(join(tmpdir(), "no-such-dir-sh")).every((x) => !x.present)).toBe(true);
  });
});
