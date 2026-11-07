import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classify, loadSymbols, runCli, type CliDeps } from "../../../scripts/ops/channel-news-export";

const now = new Date("2026-11-09T06:00:00Z");
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "cn-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fakeDb = (rows: unknown[] | Error) => (): { db: never; close: () => Promise<void> } => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => { if (rows instanceof Error) throw rows; return rows; } }) }) }) } as never,
  close: async () => undefined,
});
const deps = (rows: unknown[] | Error, lines: string[], errs: string[] = []): CliDeps => ({ env: { DATABASE_URL: "postgres://x/y" }, out: (l) => lines.push(l), err: (l) => errs.push(l), now: () => now, openDb: fakeDb(rows) });
const msg = (id: string, text: string, minsAgo = 5) => ({ id, channel: "-100123452544", at: new Date(now.getTime() - minsAgo * 60_000), text });

describe("channel-news-export", () => {
  it("classifies with the real parser: signals, result reports, commentary", () => {
    expect(classify("BUY SENSEX 80000 CE ABOVE 300 SL 250 TARGET 350")).toBe("signal_or_claim");
    expect(classify("RELIANCE profit warning today")).toBe("none");
  });

  it("writes the file atomically, prints counts only, and leaves no temp files", async () => {
    const dir = tmp(), lines: string[] = [];
    const secret = "RELIANCE profit warning zebra-quartz-7731";
    expect(await runCli(["--dir", dir], deps([msg("m1", secret), msg("m2", "good morning")], lines))).toBe(0);
    expect(readdirSync(dir)).toEqual(["channel-news.json"]);
    const text = readFileSync(join(dir, "channel-news.json"), "utf8");
    expect(text).not.toContain("zebra-quartz-7731");
    expect(text).toContain("***2544");
    expect(text).not.toContain("-100123452544");
    expect(lines.join("\n")).not.toContain("zebra");
    expect(lines.join("\n")).toMatch(/2 rows read.*1 items/);
  });

  it("keeps the previous file when the database fails", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "channel-news.json"), "PREVIOUS");
    const errs: string[] = [];
    expect(await runCli(["--dir", dir], deps(new Error("db down: secret-detail"), [], errs))).toBe(1);
    expect(readFileSync(join(dir, "channel-news.json"), "utf8")).toBe("PREVIOUS");
    expect(errs.join("")).not.toContain("secret-detail");
  });

  it("uses constituent symbols when the file exists, indices only otherwise", () => {
    const dir = tmp();
    expect(loadSymbols(dir).has("NIFTY")).toBe(true);
    expect(loadSymbols(dir).has("TCS")).toBe(false);
    writeFileSync(join(dir, "index-constituents.json"), JSON.stringify({ indices: { NIFTY: { constituents: [{ symbol: "TCS" }, { symbol: "bad symbol" }] } } }));
    const s = loadSymbols(dir);
    expect(s.has("TCS")).toBe(true);
    expect(s.has("bad symbol")).toBe(false);
  });

  it("usage and configuration errors", async () => {
    const l: string[] = [], e: string[] = [];
    expect(await runCli(["--bogus"], deps([], l, e))).toBe(2);
    expect(await runCli([], { ...deps([], l, e), env: { DATABASE_URL: "x" } })).toBe(2);
    expect(await runCli(["--dir", tmp()], { ...deps([], l, e), env: {} })).toBe(1);
  });
});
