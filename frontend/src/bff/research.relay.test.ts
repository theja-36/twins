/** The three research reads through the REAL relay handler, with a fetch double standing in for the backend (real orchestrator output, synthetic FIXTURE candidates, test-only). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { relay } from "./handlers";
import { cfgHost, fakeFetch, get, sessionCookie, ORIGIN, TOKEN } from "@/test/helpers";

const sample = JSON.parse(readFileSync(new URL("../../e2e/fixtures/research.sample.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const ID = "00000000-0000-4000-8000-000000000001", PID = "00000000-0000-4000-8000-000000000900";
const rel = (path: string, headers: Record<string, string> = { cookie: sessionCookie }) => get(`/api/session${path}`, headers);
const up = (answer: (path: string) => { status: number; body: unknown }) => fakeFetch((s) => answer(new URL(s.url).pathname));
const real = (path: string) => (path.endsWith("/package") ? { status: 200, body: clone(sample["packageIndependentEquity"]) } : path.startsWith("/research/packages/") ? { status: 200, body: clone(sample["packageById"]) } : path === "/research/agents" ? { status: 200, body: clone(sample["agents"]) } : { status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } });
const ROUTES: Array<[string, string[], string]> = [[`/research/candidates/${ID}/package`, ["research", "candidates", ID, "package"], "package"], [`/research/packages/${PID}`, ["research", "packages", PID], "package"], ["/research/agents", ["research", "agents"], "agents"]];

describe("research through the relay", () => {
  for (const [path, seg, kind] of ROUTES) it(`${path}: GET only, bearer token only, strict response reaches the browser`, async () => {
    const f = up(real), res = await relay(rel(path, { cookie: sessionCookie, "x-api-key": "k", authorization: "Bearer browser" }), seg, { cfg: cfgHost(), fetcher: f.fetcher });
    expect(res.status).toBe(200); expect(f.seen).toHaveLength(1); const u = f.seen[0]!; expect(u.method).toBe("GET"); expect(new URL(u.url).pathname).toBe(path); expect(u.headers["authorization"]).toBe(`Bearer ${TOKEN}`); expect(u.headers["cookie"]).toBeUndefined(); expect(u.headers["x-api-key"]).toBeUndefined();
    const body = (await res.json()) as Record<string, unknown>; if (kind === "package") { expect((body["package"] as Record<string, unknown>)["grantsApproval"]).toBe(false); expect((body["package"] as Record<string, unknown>)["reports"]).toBeDefined(); } else expect((body["agents"] as unknown[]).length).toBe(13);
  });
  it("the verified package body now reaches the browser (it used to be stripped), with every report field, and the options-risk context never does", async () => {
    const f = up((p) => (p.endsWith("/package") ? { status: 200, body: clone(sample["packageTelegramOption"]) } : real(p))), res = await relay(rel(`/research/candidates/${ID}/package`), seg0, { cfg: cfgHost(), fetcher: f.fetcher }), text = await res.text(), b = JSON.parse(text) as { package: { reports: Array<Record<string, unknown>> } };
    expect(b.package.reports.length).toBeGreaterThan(10); expect(Object.keys(b.package.reports[0]!).sort()).toEqual(["agentId", "agentVersion", "confidence", "errorCode", "evidenceRefs", "inputSnapshotRef", "reasoningSummary", "riskFlags", "role", "verdict", "executionStatus"].sort());
    expect(text).not.toMatch(/optionsRisk|MAPPED_UNVERIFIED|options-risk-mapping/);
  });
  it("a package that grants approval, or breaks the verified shape, becomes a neutral error with NO data", async () => {
    for (const mut of [(b: Record<string, unknown>) => { (b["package"] as Record<string, unknown>)["grantsApproval"] = true; }, (b: Record<string, unknown>) => { ((b["package"] as { reports: Array<Record<string, unknown>> }).reports[0]!)["verdict"] = "APPROVED"; }, (b: Record<string, unknown>) => { delete (b["package"] as Record<string, unknown>)["packageSha256"]; }]) {
      const body = clone(sample["packageIndependentEquity"]!); mut(body); const f = up(() => ({ status: 200, body })), res = await relay(rel(`/research/candidates/${ID}/package`), seg0, { cfg: cfgHost(), fetcher: f.fetcher });
      expect(res.status).toBe(502); expect(JSON.stringify(await res.json())).not.toMatch(/reports|packageSha256|grantsApproval/);
    }
  });
  it("the no-package answer, an unknown candidate (404) and a backend failure are passed on as what they are", async () => {
    const absent = { candidateId: ID, status: "PENDING", researchAttempts: 0, package: null, note: "No research package has been stored for this candidate; nothing is inferred." };
    expect(await (await relay(rel(`/research/candidates/${ID}/package`), seg0, { cfg: cfgHost(), fetcher: up(() => ({ status: 200, body: absent })).fetcher })).json()).toEqual(absent);
    const nf = await relay(rel(`/research/candidates/${ID}/package`), seg0, { cfg: cfgHost(), fetcher: up(() => ({ status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } })).fetcher }); expect(nf.status).toBe(404);
    const boom = await relay(rel("/research/agents"), ["research", "agents"], { cfg: cfgHost(), fetcher: up(() => ({ status: 500, body: { internal: "stack trace" } })).fetcher }); expect(boom.status).toBe(502); expect(await boom.text()).not.toMatch(/stack trace/);
  });
  it("no query parameter is accepted; nothing but GET works; no session sends nothing upstream; the ids must be UUIDs", async () => {
    const f = up(real), d = { cfg: cfgHost(), fetcher: f.fetcher };
    for (const [p, s] of [[`/research/candidates/${ID}/package?x=1`, seg0], ["/research/agents?limit=1", ["research", "agents"]]] as const) expect((await relay(rel(p), [...s], d)).status, p).toBe(422);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect((await relay(new Request(`${ORIGIN}/api/session/research/agents`, { method: m, headers: { cookie: sessionCookie, origin: ORIGIN }, body: m === "POST" ? "{}" : null }), ["research", "agents"], d)).status).toBe(405);
    expect((await relay(rel("/research/agents", {}), ["research", "agents"], d)).status).toBe(401); expect((await relay(rel("/research/candidates/not-a-uuid/package"), ["research", "candidates", "not-a-uuid", "package"], d)).status).toBe(404); expect(f.seen).toHaveLength(0);
  });
  it("research routes that do not exist (run, approve, execute) are not relayed", async () => {
    const f = up(real), d = { cfg: cfgHost(), fetcher: f.fetcher };
    for (const seg of [["research", "run"], ["research", "candidates", ID, "run"], ["research", "candidates", ID, "approve"], ["research", "agents", "weights"]]) expect((await relay(rel(`/${seg.join("/")}`), seg, d)).status, seg.join("/")).toBe(404); expect(f.seen).toHaveLength(0);
  });
});
const seg0 = ["research", "candidates", ID, "package"];
