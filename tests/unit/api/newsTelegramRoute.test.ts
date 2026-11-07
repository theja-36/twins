import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildChannelNewsFile } from "../../../packages/agents/src/index";
import { registerLiveRoutes } from "../../../apps/api/src/liveApi";

const NOW = new Date("2026-11-09T06:00:00Z");
const auth = { authorization: "Bearer ok" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const item = (id: string, o: Partial<{ symbols: string[]; themes: string[]; polarity: number; at: string; channel: string }> = {}) => ({ id, channel: o.channel ?? "***2544", publishedAt: o.at ?? "2026-11-09T05:30:00Z", symbols: o.symbols ?? ["RELIANCE"], themes: (o.themes ?? ["earnings"]) as never, polarity: o.polarity ?? -0.5, reliability: 0.3 });
function setup(file?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "nt-")); dirs.push(dir);
  file?.(dir);
  let dbTouched = false;
  const db = new Proxy({}, { get: () => { dbTouched = true; throw new Error("db must not be used"); } });
  const a = Fastify();
  registerLiveRoutes(a, { db: db as never, authorized: (h) => h === "Bearer ok", snapshotDir: "/nonexistent", providersDir: dir, adminConfigured: false, readSafety: () => ({}), now: () => NOW });
  return { a, dir, touched: () => dbTouched };
}
const write = (items: ReturnType<typeof item>[], asOf = NOW) => (dir: string) => writeFileSync(join(dir, "channel-news.json"), JSON.stringify(buildChannelNewsFile(items, asOf)));
const get = async (a: ReturnType<typeof setup>["a"], url = "/news/telegram") => a.inject({ method: "GET", url, headers: auth });

describe("GET /news/telegram", () => {
  it("needs the bearer token; writes are 404", async () => {
    const { a } = setup(write([item("tm-1")]));
    expect((await a.inject({ method: "GET", url: "/news/telegram" })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/news/telegram", headers: auth })).statusCode).toBe(404);
  });
  it("reports a missing file as missing, not as no news", async () => {
    const { a } = setup();
    const body = (await get(a)).json();
    expect(body).toMatchObject({ status: "missing", reason: "file_missing", items: [], clusters: [] });
  });
  it("reports an invalid file as invalid and leaks nothing from it", async () => {
    const { a } = setup((d) => writeFileSync(join(d, "channel-news.json"), JSON.stringify({ format: "twins-channel-news-v1", as_of: NOW.toISOString(), items: [{ id: "x", text: "SECRET SENTENCE" }] })));
    const res = await get(a);
    expect(res.json()).toMatchObject({ status: "invalid", reason: "format_invalid", items: [] });
    expect(res.body).not.toContain("SECRET");
  });
  it("reports an invalid JSON file as invalid", async () => {
    const { a } = setup((d) => writeFileSync(join(d, "channel-news.json"), "{not json"));
    expect((await get(a)).json()).toMatchObject({ status: "invalid" });
  });
  it("reports an old file as stale, with its items still shown", async () => {
    const { a } = setup(write([item("tm-1")], new Date(NOW.getTime() - 4 * 3600_000)));
    const b = (await get(a)).json();
    expect(b).toMatchObject({ status: "stale", reason: "export_stale", ageSeconds: 4 * 3600 });
    expect(b.items).toHaveLength(1);
  });
  it("returns items and clusters with stable ids; filters by symbol and limit", async () => {
    const { a } = setup(write([item("tm-1"), item("tm-2", { polarity: 0.8 }), item("tm-3", { symbols: ["TCS"], themes: ["rates"], at: "2026-11-09T05:00:00Z" })]));
    const all = (await get(a)).json();
    expect(all.status).toBe("ok");
    expect(all.items.map((i: { id: string }) => i.id)).toEqual(["tm-1", "tm-2", "tm-3"]);
    const rel = all.clusters.find((c: { symbol: string }) => c.symbol === "RELIANCE");
    expect(rel).toMatchObject({ items: 2, mixed: true });
    expect(rel.clusterId).toMatch(/^cl-[0-9a-f]{12}$/);
    expect((await get(a)).json().clusters.map((c: { clusterId: string }) => c.clusterId)).toEqual(all.clusters.map((c: { clusterId: string }) => c.clusterId));
    expect((await get(a, "/news/telegram?symbol=TCS")).json().items).toHaveLength(1);
    expect((await get(a, "/news/telegram?limit=1")).json().items).toHaveLength(1);
    expect((await get(a, "/news/telegram?symbol=bad%20x")).statusCode).toBe(400);
    expect((await get(a, "/news/telegram?limit=0")).statusCode).toBe(400);
  });
  it("never touches the database", async () => {
    const t = setup(write([item("tm-1")]));
    await get(t.a);
    expect(t.touched()).toBe(false);
  });
});

describe("static isolation", () => {
  const view = readFileSync("apps/api/src/channelNewsView.ts", "utf8");
  it("the read model imports no database package and names no Telegram table or text column", () => {
    expect(view).not.toMatch(/@twins\/database|drizzle|telegram_messages|telegramMessages|rawText|raw_text|from "pg"/);
    expect([...view.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["node:fs", "node:path", "@twins/agents"]);
  });
  it("the route handler uses neither the db nor sql", () => {
    const api = readFileSync("apps/api/src/liveApi.ts", "utf8");
    const start = api.indexOf('app.get<{ Querystring: { limit?: string; symbol?: string } }>("/news/telegram"');
    const block = api.slice(start, api.indexOf("  });", start));
    expect(start).toBeGreaterThan(0);
    expect(block).not.toMatch(/deps\.db|sql`|execute\(/);
  });
});
