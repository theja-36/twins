/** The paper and portfolio reads through the REAL relay handler, with a fetch double for the backend (real engine output fixtures, test-only). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { relay } from "./handlers";
import { cfgHost, fakeFetch, get, sessionCookie, ORIGIN, TOKEN } from "@/test/helpers";

const S = JSON.parse(readFileSync(new URL("../../e2e/fixtures/paper.sample.json", import.meta.url), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, ACC = "33333333-3333-4333-8333-333333333333";
const clone = <X,>(x: X): X => JSON.parse(JSON.stringify(x)) as X;
const answer = (path: string): { status: number; body: unknown } => {
  if (path === "/execution/orders") return { status: 200, body: { orders: clone(S["orders"]) } };
  if (path === "/execution/positions") return { status: 200, body: { positions: [clone(S["positionClosed"])] } };
  if (/\/fills$/.test(path)) return { status: 200, body: { fills: clone(S["fillsEntry"]) } };
  if (/\/events$/.test(path)) return { status: 200, body: { events: clone(S["events"]) } };
  if (path === "/portfolio") return { status: 200, body: clone(S["portfolioReal"]) };
  return { status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } };
};
const rel = (path: string, headers: Record<string, string> = { cookie: sessionCookie }) => get(`/api/session${path}`, headers);
const seg = (p: string): string[] => p.split("?")[0]!.split("/").filter(Boolean);
const run = (path: string, a = answer, headers?: Record<string, string>) => { const f = fakeFetch((s) => a(new URL(s.url).pathname)); return relay(rel(path, headers), seg(path), { cfg: cfgHost(), fetcher: f.fetcher }).then((res) => ({ res, f })); };
const READS = ["/execution/orders?limit=200", "/execution/orders?status=FILLED&limit=200", `/execution/orders?decisionId=${ID(500)}&limit=200`, `/execution/orders/${ID(621)}/fills`, "/execution/positions?status=OPEN&limit=200", `/execution/positions/${ID(611)}/events`, `/portfolio?accountId=${ACC}`];

describe("paper and portfolio through the relay", () => {
  for (const path of READS) it(`${path}: GET only, the session token only, a strict response`, async () => {
    const { res, f } = await run(path); expect(res.status).toBe(200); expect(f.seen).toHaveLength(1); const u = f.seen[0]!;
    expect(u.method).toBe("GET"); expect(u.headers["authorization"]).toBe(`Bearer ${TOKEN}`); expect(u.headers["cookie"]).toBeUndefined(); expect(u.headers["x-api-key"]).toBeUndefined();
  });
  it("positions reach the browser WITHOUT the user id and the rules; events WITHOUT the payload", async () => {
    const p = await (await run("/execution/positions?limit=200")).res.text(); expect(p).not.toMatch(/userId|rules|sebiPct|brokerage|feeVersion/);
    const e = await (await run(`/execution/positions/${ID(611)}/events`)).res.text(); expect(e).not.toMatch(/payload|realizedPnl|openQuantity|repaired/); expect(e).toContain("OPENED");
  });
  it("exact decimal strings and scale arrive unchanged", async () => {
    const o = (await (await run("/execution/orders")).res.json()) as { orders: Array<Record<string, unknown>> }; const entry = o.orders.find((x) => x["purpose"] === "ENTRY")!; expect(entry["quantity"]).toBe("4500"); expect(entry["filledQuantity"]).toBe("4500.00000000");
    expect(((await (await run(`/portfolio?accountId=${ACC}`)).res.json()) as { facts: { realizedPnl: string; totalCapital: null } }).facts).toMatchObject({ realizedPnl: "6746.40", totalCapital: null });
  });
  it("a contract break (numeric money, an unknown status) becomes a neutral 502 with NO data", async () => {
    for (const mut of [(b: any) => { b.orders[0].quantity = 4500; }, (b: any) => { b.orders[0].status = "EXECUTED_LIVE"; }]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const body = { orders: clone(S["orders"]) }; mut(body); const { res } = await run("/execution/orders", () => ({ status: 200, body })); expect(res.status).toBe(502); expect(JSON.stringify(await res.json())).not.toMatch(/orders|4500|EXECUTED_LIVE/);
    }
  });
  it("an ADMIN or another trader's route answers 404 and nothing is invented; a backend failure is a neutral 502", async () => {
    expect((await run("/execution/orders", () => ({ status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } }))).res.status).toBe(404);
    const boom = await run("/execution/positions", () => ({ status: 500, body: { internal: "stack trace" } })); expect(boom.res.status).toBe(502); expect(await boom.res.text()).not.toMatch(/stack trace/);
  });
  it("only the backend's own parameters are accepted: no account filter, offset, cursor or page; portfolio needs accountId; nothing reaches the backend", async () => {
    for (const p of [`/execution/orders?accountId=${ACC}`, "/execution/orders?offset=10", "/execution/orders?cursor=x", "/execution/orders?page=2", "/execution/positions?offset=10", `/execution/positions?decisionId=${ID(500)}`, `/execution/positions/${ID(611)}/events?x=1`, "/portfolio", `/portfolio?accountId=${ACC}&x=1`]) {
      const { res, f } = await run(p); expect(res.status, p).toBe(422); expect(f.seen, p).toHaveLength(0);
    }
  });
  it("nothing but GET works on any of the five routes, and no session or a bad id sends nothing upstream", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} })), d = { cfg: cfgHost(), fetcher: f.fetcher };
    for (const [path, s] of [["/execution/orders", ["execution", "orders"]], ["/execution/positions", ["execution", "positions"]], ["/portfolio", ["portfolio"]], [`/execution/orders/${ID(621)}/fills`, ["execution", "orders", ID(621), "fills"]]] as const)
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect([404, 405], `${m} ${path}`).toContain((await relay(new Request(`${ORIGIN}/api/session${path}`, { method: m, headers: { cookie: sessionCookie, origin: ORIGIN }, body: m === "POST" ? "{}" : null }), [...s], d)).status);
    expect(f.seen).toHaveLength(0);
    const a = await run("/execution/orders", answer, {}); expect(a.res.status).toBe(401); expect(a.f.seen).toHaveLength(0);
    const b = await run("/execution/orders/not-a-uuid/fills"); expect(b.res.status).toBe(404); expect(b.f.seen).toHaveLength(0);
  });
});
