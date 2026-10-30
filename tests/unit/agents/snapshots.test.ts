import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_RULES, DEFAULT_SNAPSHOT_DIR, inspectSnapshot, listSnapshots, loadAgentRulesConfig, loadSnapshotConfig, SNAPSHOT_KINDS, SnapshotError, writeSnapshot, type SnapshotConfig, type SnapshotKind,
} from "../../../packages/agents/src/index";
import { NOW } from "../../support/agentFixtures";
import { FAST_KINDS, iso, populate, snapshotDoc, tmpSnapshotDir } from "../../support/snapshotFixtures";

const cfgFor = (dir: string, env: Record<string, string> = {}): SnapshotConfig => loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: dir, ...env });
const read = (dir: string, kind: string): string => readFileSync(join(dir, `${kind}.json`), "utf8");

describe("snapshot configuration (strict, conservative defaults)", () => {
  it("defaults: a git-ignored directory, every kind required, STRICT, the per-kind freshness table", () => {
    const c = loadSnapshotConfig({});
    expect(c).toMatchObject({ dir: DEFAULT_SNAPSHOT_DIR, strictness: "STRICT" });
    expect(c.required).toEqual([...SNAPSHOT_KINDS]);
    expect(c.freshness["quotes"]).toEqual({ warnHours: 5 / 60, maxHours: 0.5 }); // the quote agents go UNAVAILABLE at 30 minutes
    expect(c.freshness["holiday-calendar"].maxHours).toBe(365 * 24);
    expect(SNAPSHOT_KINDS).toHaveLength(15);
  });
  it("parses every override", () => {
    const c = loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_DIR: "/srv/snaps", TWINS_AGENT_SNAPSHOT_REQUIRED: "news,ohlc,news", TWINS_AGENT_SNAPSHOT_STRICTNESS: "LENIENT", TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: '{"news":{"warn":2,"max":10},"ohlc":{"max":200}}' });
    expect(c).toMatchObject({ dir: "/srv/snaps", required: ["news", "ohlc"], strictness: "LENIENT" });
    expect(c.freshness["news"]).toEqual({ warnHours: 2, maxHours: 10 }); expect(c.freshness["ohlc"]).toEqual({ warnHours: 24, maxHours: 200 });
    expect(loadSnapshotConfig({ TWINS_AGENT_SNAPSHOT_REQUIRED: "" }).required).toEqual([]);
  });
  it.each<[string, Record<string, string>]>([
    ["an unknown required kind", { TWINS_AGENT_SNAPSHOT_REQUIRED: "news,weather" }], ["a bad strictness", { TWINS_AGENT_SNAPSHOT_STRICTNESS: "LOOSE" }], ["non-JSON freshness", { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: "{nope" }],
    ["an unknown freshness kind", { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: '{"weather":{"warn":1,"max":2}}' }], ["warn not below max", { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: '{"news":{"warn":10,"max":10}}' }],
    ["a non-positive warn", { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: '{"news":{"warn":0,"max":10}}' }], ["a string threshold", { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: '{"news":{"warn":"1","max":10}}' }], ["an array freshness", { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: "[]" }],
  ])("a malformed override (%s) THROWS", (_n, env) => { expect(() => loadSnapshotConfig(env)).toThrowError(expect.objectContaining({ code: "INVALID_SNAPSHOT_CONFIG" })); });
});

describe("listing and validation (read-only)", () => {
  it("every kind's valid document is accepted by the strict parser: OK, with age and coverage", () => {
    const dir = tmpSnapshotDir(); populate(dir);
    const v = listSnapshots(cfgFor(dir), NOW);
    expect(v).toMatchObject({ ok: true, strictness: "STRICT", dirExists: true, missingRequired: [], malformed: [], unsafe: [], expired: [], stale: [], unexpectedFiles: [], leftoverTemp: [] });
    expect(v.reports.map((r) => [r.kind, r.status])).toEqual(SNAPSHOT_KINDS.map((k) => [k, "OK"]));
    for (const r of v.reports) expect(r, r.kind).toMatchObject({ code: "", required: true, ageHours: FAST_KINDS.includes(r.kind) ? 0.05 : 1, bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), asOf: FAST_KINDS.includes(r.kind) ? iso(0.05) : iso(1) });
    const by = Object.fromEntries(v.reports.map((r) => [r.kind, r]));
    expect(by["holiday-calendar"]?.coverage).toMatchObject({ entries: 1, keys: ["NSE"], from: "2025-01-01", to: "2025-12-31" });
    expect(by["economic-calendar"]?.coverage).toMatchObject({ entries: 1, from: "2025-01-01T00:00:00.000Z", to: "2025-12-31T00:00:00.000Z" });
    expect(by["ohlc"]?.coverage).toMatchObject({ entries: 1, keys: ["NSE:ACME"] }); expect(by["news"]?.coverage).toMatchObject({ entries: 1, keys: [] });
    expect(by["quotes"]?.coverage?.keys).toEqual(["NSE:ACME"]); expect(by["instrument-reference"]?.coverage?.entries).toBe(1);
  });
  it("listing and validating write nothing", () => {
    const dir = tmpSnapshotDir(); populate(dir);
    const snap = () => readdirSync(dir).sort().map((n) => `${n}:${statSync(join(dir, n)).mtimeMs}:${statSync(join(dir, n)).size}`).join("|");
    const before = snap();
    listSnapshots(cfgFor(dir), NOW); listSnapshots(cfgFor(dir), NOW);
    expect(snap()).toBe(before);
  });
  it("freshness: STALE past the warn age, EXPIRED past the max age; fractional hours work for quotes", () => {
    const dir = tmpSnapshotDir();
    populate(dir, ["news"], iso(7)); populate(dir, ["quotes"], iso(0.2)); populate(dir, ["macro-context"], iso(100)); populate(dir, ["last-price"], iso(0.01));
    const v = listSnapshots(cfgFor(dir), NOW);
    const s = (k: SnapshotKind) => v.reports.find((r) => r.kind === k)!;
    expect(s("news")).toMatchObject({ status: "STALE", code: "SNAPSHOT_STALE", ageHours: 7 });
    expect(s("quotes")).toMatchObject({ status: "STALE", ageHours: 0.2 }); // beyond 5 minutes
    expect(s("macro-context")).toMatchObject({ status: "EXPIRED", code: "SNAPSHOT_TOO_OLD" });
    expect(s("last-price")).toMatchObject({ status: "OK" });
    expect(v.stale).toEqual(expect.arrayContaining(["news", "quotes"])); expect(v.expired).toContain("macro-context");
  });
  it("freshness thresholds are configurable", () => {
    const dir = tmpSnapshotDir(); populate(dir, ["news"], iso(7));
    expect(inspectSnapshot(dir, "news", cfgFor(dir, { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: '{"news":{"warn":12,"max":24}}' }), NOW).status).toBe("OK");
    expect(inspectSnapshot(dir, "news", cfgFor(dir, { TWINS_AGENT_SNAPSHOT_FRESHNESS_HOURS: '{"news":{"warn":1,"max":5}}' }), NOW).status).toBe("EXPIRED");
  });
  it("a calendar whose coverage has ended is EXPIRED however fresh the file is; an as_of in the future is MALFORMED", () => {
    const dir = tmpSnapshotDir();
    const eco = snapshotDoc("economic-calendar"); (eco["coverage"] as Record<string, string>)["to"] = "2025-01-05T00:00:00Z";
    writeFileSync(join(dir, "economic-calendar.json"), JSON.stringify(eco));
    const hol = snapshotDoc("holiday-calendar"); const nse = (hol["markets"] as Record<string, Record<string, unknown>>)["NSE"] as Record<string, unknown>; nse["to"] = "2025-01-05"; nse["days"] = [];
    writeFileSync(join(dir, "holiday-calendar.json"), JSON.stringify(hol));
    writeFileSync(join(dir, "news.json"), JSON.stringify(snapshotDoc("news", iso(-3))));
    const v = listSnapshots(cfgFor(dir), NOW);
    expect(v.reports.find((r) => r.kind === "economic-calendar")).toMatchObject({ status: "EXPIRED", code: "COVERAGE_ENDED" });
    expect(v.reports.find((r) => r.kind === "holiday-calendar")).toMatchObject({ status: "EXPIRED", code: "COVERAGE_ENDED" });
    expect(v.reports.find((r) => r.kind === "news")).toMatchObject({ status: "MALFORMED", code: "AS_OF_IN_FUTURE" });
  });
  it("missing required snapshots are detected (and a missing directory reports every kind)", () => {
    const dir = tmpSnapshotDir(); populate(dir, ["news", "ohlc"]);
    const v = listSnapshots(cfgFor(dir), NOW);
    expect(v.ok).toBe(false); expect(v.missingRequired).toEqual(SNAPSHOT_KINDS.filter((k) => k !== "news" && k !== "ohlc"));
    expect(v.reports.find((r) => r.kind === "quotes")).toMatchObject({ status: "MISSING", code: "SNAPSHOT_FILE_MISSING" });
    const only = listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_REQUIRED: "news,ohlc" }), NOW);
    expect(only).toMatchObject({ ok: true, missingRequired: [] }); // optional kinds may be absent
    const gone = listSnapshots(cfgFor(join(dir, "does-not-exist")), NOW);
    expect(gone).toMatchObject({ ok: false, dirExists: false }); expect(gone.missingRequired).toHaveLength(15); expect(gone.reports[0]).toMatchObject({ code: "SNAPSHOT_DIRECTORY_MISSING" });
  });
  it.each<[string, (dir: string) => void, string]>([
    ["invalid JSON", (d) => writeFileSync(join(d, "news.json"), "{nope"), "NOT_JSON"],
    ["a JSON array", (d) => writeFileSync(join(d, "news.json"), "[]"), "NOT_AN_OBJECT"],
    ["another kind's format", (d) => writeFileSync(join(d, "news.json"), JSON.stringify(snapshotDoc("sentiment"))), "FORMAT_MISMATCH"],
    ["a rejected entry (strict parser)", (d) => { const q = snapshotDoc("quotes"); ((q["quotes"] as Record<string, Record<string, number>>)["NSE:ACME"] as Record<string, number>)["bid"] = -1; writeFileSync(join(d, "quotes.json"), JSON.stringify(q)); }, "INVALID_QUOTE_DATA"],
    ["a crossed market", (d) => { const q = snapshotDoc("quotes"); ((q["quotes"] as Record<string, Record<string, number>>)["NSE:ACME"] as Record<string, number>)["bid"] = 101; writeFileSync(join(d, "quotes.json"), JSON.stringify(q)); }, "INVALID_QUOTE_DATA"],
    ["a missing as_of", (d) => { const n = snapshotDoc("news"); delete n["as_of"]; writeFileSync(join(d, "news.json"), JSON.stringify(n)); }, "INVALID_NEWS_DATA"],
    ["an as_of without an offset", (d) => { const n = snapshotDoc("news"); n["as_of"] = "2025-01-06T03:00:00"; writeFileSync(join(d, "news.json"), JSON.stringify(n)); }, "INVALID_NEWS_DATA"],
    ["a duplicate id", (d) => { const n = snapshotDoc("news"); (n["items"] as unknown[]).push((n["items"] as unknown[])[0]); writeFileSync(join(d, "news.json"), JSON.stringify(n)); }, "INVALID_NEWS_DATA"],
  ])("a malformed snapshot is detected: %s", (_n, setup, code) => {
    const dir = tmpSnapshotDir(); populate(dir); setup(dir);
    const v = listSnapshots(cfgFor(dir), NOW);
    expect(v.ok).toBe(false);
    const r = v.reports.find((x) => x.status === "MALFORMED")!;
    expect(r).toMatchObject({ status: "MALFORMED", code }); expect(v.malformed).toEqual([r.kind]);
  });
  it("unsafe snapshots are detected: a symlink, an empty file, a directory in its place", () => {
    const dir = tmpSnapshotDir(); populate(dir);
    const other = join(mkdtempSync(join(tmpdir(), "twins-snap-")), "real.json"); writeFileSync(other, JSON.stringify(snapshotDoc("news")));
    writeFileSync(join(dir, "news.json.x"), ""); // placeholder to keep dir listing realistic
    for (const k of ["news", "sentiment", "ohlc"]) writeFileSync(join(dir, `${k}.json`), "x");
    writeFileSync(join(dir, "sentiment.json"), ""); mkdirSync(join(dir, "ohlc.json.d"));
    writeFileSync(join(dir, "news.json"), "x"); // replaced below by a symlink
    unlinkSync(join(dir, "news.json")); symlinkSync(other, join(dir, "news.json"));
    unlinkSync(join(dir, "ohlc.json")); mkdirSync(join(dir, "ohlc.json"));
    const v = listSnapshots(cfgFor(dir), NOW);
    expect(v.reports.find((r) => r.kind === "news")).toMatchObject({ status: "UNSAFE", code: "SYMLINK_NOT_ALLOWED" });
    expect(v.reports.find((r) => r.kind === "sentiment")).toMatchObject({ status: "UNSAFE", code: "EMPTY_FILE" });
    expect(v.reports.find((r) => r.kind === "ohlc")).toMatchObject({ status: "UNSAFE", code: "NOT_A_REGULAR_FILE" });
    expect(v.unsafe.sort()).toEqual(["news", "ohlc", "sentiment"]); expect(v.ok).toBe(false);
  });
  it("strictness: STRICT fails on a stale required snapshot and on any malformed one; LENIENT tolerates stale and a malformed optional one", () => {
    const dir = tmpSnapshotDir(); populate(dir); populate(dir, ["news"], iso(7)); writeFileSync(join(dir, "sentiment.json"), "{nope");
    const strict = listSnapshots(cfgFor(dir), NOW);
    expect(strict.ok).toBe(false);
    const lenientRequired = listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_STRICTNESS: "LENIENT" }), NOW);
    expect(lenientRequired.ok).toBe(false); // sentiment is required and malformed
    const lenient = listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_STRICTNESS: "LENIENT", TWINS_AGENT_SNAPSHOT_REQUIRED: "news,ohlc" }), NOW);
    expect(lenient).toMatchObject({ ok: true, malformed: ["sentiment"], stale: ["news"] });
    expect(listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_REQUIRED: "news,ohlc" }), NOW).ok).toBe(false); // STRICT: stale required + any malformed
    populate(dir, ["sentiment"]);
    expect(listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_REQUIRED: "ohlc" }), NOW).ok).toBe(true);
    populate(dir, ["news"], iso(30)); // expired, required in lenient too
    expect(listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_STRICTNESS: "LENIENT", TWINS_AGENT_SNAPSHOT_REQUIRED: "news" }), NOW).ok).toBe(false);
  });
  it("unexpected files and leftover temporary files are reported", () => {
    const dir = tmpSnapshotDir(); populate(dir);
    writeFileSync(join(dir, "notes.txt"), "x"); writeFileSync(join(dir, ".news.json.0123456789ab.tmp"), "x");
    const v = listSnapshots(cfgFor(dir), NOW);
    expect(v.unexpectedFiles).toEqual(["notes.txt"]); expect(v.leftoverTemp).toEqual([".news.json.0123456789ab.tmp"]); expect(v.ok).toBe(true);
  });
  it("cross-checks the provider settings: a required snapshot that the setting does not read is reported", () => {
    const dir = tmpSnapshotDir(); populate(dir, ["news", "ohlc", "quotes"]);
    const rules = loadAgentRulesConfig({ TWINS_AGENT_NEWS_PROVIDER: `file:${join(dir, "news.json")}`, TWINS_AGENT_OHLC_PROVIDER: "file:/somewhere/else.json" });
    const v = listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_REQUIRED: "news,ohlc,quotes" }), NOW, rules);
    const s = (k: SnapshotKind) => v.reports.find((r) => r.kind === k)!;
    expect(s("news")).toMatchObject({ configuredSource: "file", servesFromDirectory: true });
    expect(s("ohlc")).toMatchObject({ configuredSource: "file", servesFromDirectory: false });
    expect(s("quotes")).toMatchObject({ configuredSource: "none", servesFromDirectory: false });
    expect(v.notServed.sort()).toEqual(["ohlc", "quotes"]);
    expect(listSnapshots(cfgFor(dir), NOW).reports[0]).toMatchObject({ configuredSource: "unknown", servesFromDirectory: null });
    expect(DEFAULT_AGENT_RULES.news.source).toBe("none");
  });
});

describe("atomic, confirmed writes", () => {
  it("writes a valid snapshot (0600), validated by the agent's strict parser; the result reports size, hash and as_of", () => {
    const dir = tmpSnapshotDir();
    const text = JSON.stringify(snapshotDoc("quotes", iso(0.05)));
    const w = writeSnapshot(cfgFor(dir), "quotes", text, { now: NOW });
    expect(w).toMatchObject({ kind: "quotes", file: "quotes.json", replaced: false, bytes: Buffer.byteLength(text), asOf: iso(0.05), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(read(dir, "quotes")).toBe(text); expect(statSync(join(dir, "quotes.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["quotes.json"]); // no temporary file is left behind
    expect(listSnapshots(cfgFor(dir, { TWINS_AGENT_SNAPSHOT_REQUIRED: "quotes" }), NOW).ok).toBe(true);
    writeSnapshot(cfgFor(tmpSnapshotDir()), "news", snapshotDoc("news"), { now: NOW }); // an object is accepted and serialised
  });
  it("creates the directory (0700) when it does not exist", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "twins-snap-")), "a", "b");
    writeSnapshot(cfgFor(dir), "news", snapshotDoc("news"), { now: NOW });
    expect(statSync(dir).mode & 0o777).toBe(0o700); expect(existsSync(join(dir, "news.json"))).toBe(true);
  });
  it("never replaces an existing snapshot without an explicit confirmation naming the kind", () => {
    const dir = tmpSnapshotDir(); populate(dir, ["news"]);
    const original = read(dir, "news");
    const next = JSON.stringify(snapshotDoc("news", iso(0.5)));
    for (const confirm of [undefined, "", "sentiment", "NEWS", "yes"]) expect(() => writeSnapshot(cfgFor(dir), "news", next, { ...(confirm === undefined ? {} : { confirmOverwrite: confirm }), now: NOW }), String(confirm)).toThrowError(expect.objectContaining({ code: "SNAPSHOT_EXISTS" }));
    expect(read(dir, "news")).toBe(original); expect(readdirSync(dir)).toEqual(["news.json"]);
    const w = writeSnapshot(cfgFor(dir), "news", next, { confirmOverwrite: "news", now: NOW });
    expect(w).toMatchObject({ replaced: true, asOf: iso(0.5) });
    expect(read(dir, "news")).toBe(next);
    expect(readFileSync(join(dir, ".previous", "news.json"), "utf8")).toBe(original); // the previous version is kept once
    expect(readdirSync(dir).sort()).toEqual([".previous", "news.json"]);
  });
  it("an invalid snapshot is refused and the existing one is untouched", () => {
    const dir = tmpSnapshotDir(); populate(dir, ["quotes"]);
    const original = read(dir, "quotes");
    const bad = snapshotDoc("quotes"); ((bad["quotes"] as Record<string, Record<string, number>>)["NSE:ACME"] as Record<string, number>)["ask"] = 0;
    const attempts: Array<[string, string | Record<string, unknown>, string]> = [
      ["strict parser", bad, "SNAPSHOT_INVALID"], ["not JSON", "{nope", "SNAPSHOT_NOT_JSON"], ["an array", "[]", "SNAPSHOT_INVALID"], ["the wrong format", snapshotDoc("news"), "SNAPSHOT_INVALID"],
      ["a future as_of", snapshotDoc("quotes", iso(-2)), "SNAPSHOT_FUTURE"], ["empty", "", "SNAPSHOT_SIZE"],
    ];
    for (const [name, content, code] of attempts) expect(() => writeSnapshot(cfgFor(dir), "quotes", content, { confirmOverwrite: "quotes", now: NOW }), name).toThrowError(expect.objectContaining({ code }));
    expect(read(dir, "quotes")).toBe(original); expect(readdirSync(dir)).toEqual(["quotes.json"]);
  });
  it("an unknown kind and path-like kinds are refused (no path is built from input)", () => {
    const dir = tmpSnapshotDir();
    for (const k of ["weather", "../news", "news.json", "", "NEWS"]) expect(() => writeSnapshot(cfgFor(dir), k, snapshotDoc("news"), { now: NOW }), k).toThrowError(expect.objectContaining({ code: "SNAPSHOT_KIND_UNKNOWN" }));
    expect(readdirSync(dir)).toEqual([]);
  });
  it("atomicity: a failure while replacing leaves the existing snapshot intact and removes the temporary file", () => {
    const dir = tmpSnapshotDir(); populate(dir, ["news"]);
    const original = read(dir, "news");
    const next = JSON.stringify(snapshotDoc("news", iso(0.5)));
    expect(() => writeSnapshot(cfgFor(dir), "news", next, { confirmOverwrite: "news", now: NOW, io: { rename: () => { throw new Error("disk full SECRET-DETAIL"); } } })).toThrowError(expect.objectContaining({ code: "SNAPSHOT_WRITE_FAILED" }));
    expect(read(dir, "news")).toBe(original);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(() => writeSnapshot(cfgFor(dir), "news", next, { confirmOverwrite: "news", now: NOW, io: { copyFile: () => { throw new Error("no space"); } } })).toThrowError(expect.objectContaining({ code: "SNAPSHOT_WRITE_FAILED" }));
    expect(read(dir, "news")).toBe(original); expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    try { writeSnapshot(cfgFor(dir), "news", next, { confirmOverwrite: "news", now: NOW, io: { rename: () => { throw new Error("disk full SECRET-DETAIL"); } } }); } catch (e) { expect((e as SnapshotError).message).not.toContain("SECRET-DETAIL"); }
  });
  it("atomicity: the target is replaced in one rename - at no time does a reader see a partial file", () => {
    const dir = tmpSnapshotDir(); populate(dir, ["news"]);
    const next = JSON.stringify(snapshotDoc("news", iso(0.5)));
    let seenAtRename = "";
    writeSnapshot(cfgFor(dir), "news", next, { confirmOverwrite: "news", now: NOW, io: { rename: (from, to) => { seenAtRename = read(dir, "news"); expect(readFileSync(from, "utf8")).toBe(next); renameSync(from, to); } } });
    expect(JSON.parse(seenAtRename).as_of).toBe(iso(1)); // before the rename the old complete file is what readers see
    expect(read(dir, "news")).toBe(next);
  });
  it("refuses to write through a symlinked directory or over a symlinked or non-regular target", () => {
    const real = tmpSnapshotDir();
    const link = join(mkdtempSync(join(tmpdir(), "twins-snap-")), "link"); symlinkSync(real, link);
    expect(() => writeSnapshot(cfgFor(link), "news", snapshotDoc("news"), { now: NOW })).toThrowError(expect.objectContaining({ code: "SNAPSHOT_UNSAFE" }));
    const dir = tmpSnapshotDir(); const other = join(dir, "..", "other.json"); writeFileSync(other, "x"); symlinkSync(other, join(dir, "news.json"));
    expect(() => writeSnapshot(cfgFor(dir), "news", snapshotDoc("news"), { confirmOverwrite: "news", now: NOW })).toThrowError(expect.objectContaining({ code: "SNAPSHOT_UNSAFE" }));
    expect(lstatSync(join(dir, "news.json")).isSymbolicLink()).toBe(true); expect(readFileSync(other, "utf8")).toBe("x");
    const d2 = tmpSnapshotDir(); mkdirSync(join(d2, "news.json"));
    expect(() => writeSnapshot(cfgFor(d2), "news", snapshotDoc("news"), { confirmOverwrite: "news", now: NOW })).toThrowError(expect.objectContaining({ code: "SNAPSHOT_UNSAFE" }));
    chmodSync(real, 0o700);
  });
});

describe("source hygiene", () => {
  it("snapshot management and observability import no network, broker, database or child-process code and perform no fetch", () => {
    for (const f of ["snapshots.ts", "observability.ts"]) {
      const t = readFileSync(join(__dirname, "../../../packages/agents/src", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(t, f).not.toMatch(/\bfetch\(|node:https?|node:net\b|node:child_process|zerodha|kite|anthropic|openai|@twins\/database|drizzle|\.insert\(|\.delete\(|schema\./i);
    }
  });
});
