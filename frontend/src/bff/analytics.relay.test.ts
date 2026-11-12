/** The 11 analytics reads through the REAL relay handler, with a fetch double standing in for the backend. The backend answers with a real-output sample (synthetic FIXTURE data, test-only). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { relay } from "./handlers";
import { cfgHost, fakeFetch, get, sessionCookie, ORIGIN, TOKEN } from "@/test/helpers";

const sample = JSON.parse(readFileSync(new URL("../../e2e/fixtures/analytics.sample.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const SECTIONS = ["overview", "strategies", "channels", "independent", "agents", "decisions", "drift", "data-quality", "calibration", "outcomes", "insights"];
const rel = (path: string, headers: Record<string, string> = { cookie: sessionCookie }) => get(`/api/session${path}`, headers);
const upstream = (mut: (n: string, b: Record<string, unknown>) => Record<string, unknown> = (_n, b) => b) => fakeFetch((s) => { const n = new URL(s.url).pathname.replace("/analytics/", ""); return sample[n] ? { status: 200, body: mut(n, clone(sample[n]!)) } : { status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } }; });

describe("analytics through the relay", () => {
  for (const s of SECTIONS) it(`${s}: GET only, bearer token only, the strict response reaches the browser`, async () => {
    const f = upstream(), res = await relay(rel(`/analytics/${s}`, { cookie: sessionCookie, "x-api-key": "k", authorization: "Bearer browser" }), ["analytics", s], { cfg: cfgHost(), fetcher: f.fetcher });
    expect(res.status).toBe(200); expect(f.seen).toHaveLength(1); const u = f.seen[0]!; expect(u.method).toBe("GET"); expect(new URL(u.url).pathname).toBe(`/analytics/${s}`);
    expect(u.headers["authorization"]).toBe(`Bearer ${TOKEN}`); expect(u.headers["cookie"]).toBeUndefined(); expect(u.headers["x-api-key"]).toBeUndefined();
    const body = (await res.json()) as Record<string, unknown>; expect(body).toMatchObject({ mode: "PAPER", dataset: "PAPER", liveStatus: "UNAVAILABLE" }); expect(res.headers.get("authorization")).toBeNull();
  });
  it("verified query parameters are forwarded exactly; unknown ones are refused before the backend is contacted", async () => {
    const f = upstream(), d = { cfg: cfgHost(), fetcher: f.fetcher };
    expect((await relay(rel("/analytics/outcomes?limit=50&finality=FINAL"), ["analytics", "outcomes"], d)).status).toBe(200); expect(new URL(f.seen[0]!.url).search).toBe("?limit=50&finality=FINAL");
    expect((await relay(rel("/analytics/insights?limit=100&kind=DRIFT"), ["analytics", "insights"], d)).status).toBe(200); expect(new URL(f.seen[1]!.url).search).toBe("?limit=100&kind=DRIFT");
    for (const [p, seg] of [["/analytics/outcomes?bogus=1", "outcomes"], ["/analytics/overview?userId=1", "overview"], ["/analytics/outcomes?limit=1&limit=2", "outcomes"], ["/analytics/insights?kind=%3Cscript%3E", "insights"]] as const) expect((await relay(rel(p), ["analytics", seg], d)).status, p).toBe(422);
    expect(f.seen).toHaveLength(2);
  });
  it("decimal strings arrive byte-identical (trailing zeros kept) and undeclared fields never do", async () => {
    const f = upstream((n, b) => { if (n === "outcomes") { ((b["data"] as Array<Record<string, unknown>>)[0]!)["leak"] = "x"; } return b; });
    const text = await (await relay(rel("/analytics/outcomes"), ["analytics", "outcomes"], { cfg: cfgHost(), fetcher: f.fetcher })).text();
    expect(text).toContain('"netPnl":"6172.18"'); expect(text).toContain('"rMultiple":"0.66907100"'); expect(text).not.toMatch(/leak|paperPositionId|decisionId/);
  });
  it("a response that breaks the contract becomes a neutral error with NO data (no fabricated fallback): numeric money, a LIVE mode, no snapshot", async () => {
    for (const mut of [(b: Record<string, unknown>) => { (b["data"] as Array<Record<string, unknown>>)[0]!["netPnl"] = 6172.18; }, (b: Record<string, unknown>) => { b["mode"] = "LIVE"; }, (b: Record<string, unknown>) => { delete b["snapshot"]; }]) {
      const f = upstream((_n, b) => { mut(b); return b; }), res = await relay(rel("/analytics/outcomes"), ["analytics", "outcomes"], { cfg: cfgHost(), fetcher: f.fetcher });
      expect(res.status).toBe(502); expect(JSON.stringify(await res.json())).not.toMatch(/netPnl|6172|snapshot|grossPnl/);
    }
  });
  it("the backend's 404 for a private route (an administrator, or another user's data) reaches the browser as a plain 404", async () => {
    const f = fakeFetch(() => ({ status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } })), res = await relay(rel("/analytics/overview"), ["analytics", "overview"], { cfg: cfgHost(), fetcher: f.fetcher });
    expect(res.status).toBe(404); expect(await res.json()).toMatchObject({ error: "NOT_FOUND" });
  });
  it("nothing but GET works, and with no session nothing is sent upstream", async () => {
    const f = upstream(), d = { cfg: cfgHost(), fetcher: f.fetcher };
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect((await relay(new Request(`${ORIGIN}/api/session/analytics/insights`, { method: m, headers: { cookie: sessionCookie, origin: ORIGIN }, body: m === "POST" ? "{}" : null }), ["analytics", "insights"], d)).status).toBe(405);
    expect((await relay(rel("/analytics/overview", {}), ["analytics", "overview"], d)).status).toBe(401); expect(f.seen).toHaveLength(0);
  });
  it("routes that do not exist (live analytics, unrealised P&L, strategy evaluation) are not relayed", async () => {
    const f = upstream(), d = { cfg: cfgHost(), fetcher: f.fetcher };
    for (const seg of [["analytics", "live"], ["analytics", "unrealised"], ["analytics", "evaluate"], ["analytics", "insights", "accept"], ["insights", "apply"], ["analytics"]]) expect((await relay(rel(`/${seg.join("/")}`), seg, d)).status, seg.join("/")).toBe(404);
    expect(f.seen).toHaveLength(0);
  });
});
