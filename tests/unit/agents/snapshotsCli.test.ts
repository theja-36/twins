import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../../scripts/ops/agent-snapshots";
import { NOW } from "../../support/agentFixtures";
import { iso, populate, snapshotDoc, tmpSnapshotDir } from "../../support/snapshotFixtures";

const cli = async (args: string[], env: Record<string, string> = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await runCli(args, { env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const file = (doc: unknown): string => { const p = join(mkdtempSync(join(tmpdir(), "twins-in-")), "in.json"); writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc)); return p; };

describe("agent-snapshots CLI", () => {
  it("list: a human table and JSON; exit 0 even when something is missing", async () => {
    const dir = tmpSnapshotDir(); populate(dir, ["news", "quotes"]);
    const t = await cli(["list"], { TWINS_AGENT_SNAPSHOT_DIR: dir });
    expect(t.code).toBe(0); expect(t.out).toContain("result: NOT OK"); expect(t.out).toMatch(/OK\s+news\s+required/); expect(t.out).toContain("missing required:"); expect(t.out).toContain("MISSING   holiday-calendar");
    const j = await cli(["list", "--json"], { TWINS_AGENT_SNAPSHOT_DIR: dir });
    expect(JSON.parse(j.out)).toMatchObject({ ok: false, strictness: "STRICT", dirExists: true }); expect(JSON.parse(j.out).reports).toHaveLength(15);
  });
  it("validate: exit 0 when acceptable under the configured strictness, 1 otherwise", async () => {
    const dir = tmpSnapshotDir(); populate(dir);
    expect((await cli(["validate"], { TWINS_AGENT_SNAPSHOT_DIR: dir })).code).toBe(0);
    populate(dir, ["news"], iso(7));
    expect((await cli(["validate"], { TWINS_AGENT_SNAPSHOT_DIR: dir })).code).toBe(1);
    const lenient = await cli(["validate", "--dir", dir], { TWINS_AGENT_SNAPSHOT_STRICTNESS: "LENIENT" });
    expect(lenient.code).toBe(0); expect(lenient.out).toContain("stale: news");
  });
  it("write: installs a valid snapshot; refuses an overwrite unless --overwrite and --confirm <kind> are both given", async () => {
    const dir = tmpSnapshotDir();
    const w = await cli(["write", "--kind", "news", "--file", file(snapshotDoc("news"))], { TWINS_AGENT_SNAPSHOT_DIR: dir });
    expect(w.code).toBe(0); expect(w.out).toMatch(/wrote news\.json \(\d+ bytes, sha256 [0-9a-f]{16}\.\.\., as_of /); expect(readdirSync(dir)).toEqual(["news.json"]);
    const again = await cli(["write", "--kind", "news", "--file", file(snapshotDoc("news", iso(0.5)))], { TWINS_AGENT_SNAPSHOT_DIR: dir });
    expect(again.code).toBe(3); expect(again.err).toContain("SNAPSHOT_EXISTS");
    expect((await cli(["write", "--kind", "news", "--file", file(snapshotDoc("news")), "--overwrite"], { TWINS_AGENT_SNAPSHOT_DIR: dir })).code).toBe(2);
    expect((await cli(["write", "--kind", "news", "--file", file(snapshotDoc("news")), "--confirm", "news"], { TWINS_AGENT_SNAPSHOT_DIR: dir })).code).toBe(2);
    expect((await cli(["write", "--kind", "news", "--file", file(snapshotDoc("news")), "--overwrite", "--confirm", "ohlc"], { TWINS_AGENT_SNAPSHOT_DIR: dir })).code).toBe(3);
    const ok = await cli(["write", "--kind", "news", "--file", file(snapshotDoc("news", iso(0.5))), "--overwrite", "--confirm", "news"], { TWINS_AGENT_SNAPSHOT_DIR: dir });
    expect(ok.code).toBe(0); expect(ok.out).toContain(".previous/"); expect(JSON.parse(readFileSync(join(dir, "news.json"), "utf8")).as_of).toBe(iso(0.5));
  });
  it("write: an invalid, unreadable or oversized input is refused and nothing is written", async () => {
    const dir = tmpSnapshotDir();
    const bad = snapshotDoc("quotes"); ((bad["quotes"] as Record<string, Record<string, number>>)["NSE:ACME"] as Record<string, number>)["bid"] = -1;
    const r = await cli(["write", "--kind", "quotes", "--file", file(bad)], { TWINS_AGENT_SNAPSHOT_DIR: dir });
    expect(r.code).toBe(1); expect(r.err).toContain("SNAPSHOT_INVALID");
    expect((await cli(["write", "--kind", "quotes", "--file", "/nonexistent/in.json"], { TWINS_AGENT_SNAPSHOT_DIR: dir })).code).toBe(1);
    expect((await cli(["write", "--kind", "weather", "--file", file(snapshotDoc("news"))], { TWINS_AGENT_SNAPSHOT_DIR: dir })).err).toContain("SNAPSHOT_KIND_UNKNOWN");
    expect(readdirSync(dir)).toEqual([]);
  });
  it("usage errors exit 2; a malformed configuration exits 1 without echoing values", async () => {
    for (const a of [[], ["bogus"], ["list", "--wat"], ["write"], ["write", "--kind", "news"], ["list", "--dir"]]) expect((await cli(a as string[])).code, a.join(" ")).toBe(2);
    const c = await cli(["list"], { TWINS_AGENT_SNAPSHOT_STRICTNESS: "SECRET-VALUE" });
    expect(c.code).toBe(1); expect(c.err).toContain("INVALID_SNAPSHOT_CONFIG"); expect(c.err).not.toContain("SECRET-VALUE");
  });
  it("list never prints snapshot contents beyond counts and short key lists", async () => {
    const dir = tmpSnapshotDir(); populate(dir);
    const j = await cli(["list", "--json"], { TWINS_AGENT_SNAPSHOT_DIR: dir });
    expect(j.out).not.toContain("A synthetic headline"); expect(j.out).not.toContain("Rate decision");
  });
});
