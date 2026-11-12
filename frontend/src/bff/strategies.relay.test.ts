/** Decisions and playbooks through the REAL relay handler, with a fetch double standing in for the backend (synthetic FIXTURE data shaped like the verified views; test-only). */
import { describe, expect, it } from "vitest";
import { relay } from "./handlers";
import { cfgHost, fakeFetch, get, sessionCookie, ORIGIN, TOKEN } from "@/test/helpers";

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = "2031-01-06T04:30:00.000Z";
const prov = { candidateId: ID(1), candidateSource: "INDEPENDENT", dataSource: "FIXTURE", researchPackageId: ID(9), researchPackageSha256: "a".repeat(64), confidenceAssessmentId: null, riskAssessmentId: null, simulationId: null };
const expl = { headline: "h", supporting: [], missing: [], contradictory: [], riskRestrictions: [], sizeRestriction: null, expiry: "e", reassess: [], invalidatedBy: [], reasons: [], restrictions: [], whatWouldChange: [], provenance: prov };
const dec = (over: Record<string, unknown> = {}) => ({ id: ID(500), accountId: ID(2), candidateId: ID(1), outcome: "QUALIFIED", workflowState: "PENDING", explanation: expl, stopLossValidation: { ruleVersion: "v1", result: "VALID", reasonCode: null, detail: null }, permittedSize: { lots: 2, quantity: 100, maxLossAtStop: "1250.50", riskPerLot: "625.25", grossExposure: "10050.00", sizeMultiplier: 1, binding: "LOSS_CAP" }, evidenceRefs: [], versions: {}, validFrom: T, validUntil: T, supersedesId: null, createdAt: T, invalidated: null, simulationId: null, riskAssessmentId: null, secretInternal: "x", ...over });
const pb = { id: ID(700), sourceKind: "INDEPENDENT", telegramSourceId: null, name: "P", createdAt: T, versions: 1, activeVersion: null, latestVersion: 1 };
const answer = (path: string): { status: number; body: unknown } => {
  if (path === "/decisions") return { status: 200, body: { decisions: [dec()] } };
  if (path === `/decisions/${ID(500)}`) return { status: 200, body: { decision: dec(), events: [], approval: null, watching: false } };
  if (path === `/decisions/${ID(500)}/comparables`) return { status: 200, body: { decisionId: ID(500), comparables: { state: "NOT_AVAILABLE", version: "v1", reason: "NO_PATTERN_REPORT", detail: "d", patterns: [] } } };
  if (path === "/intelligence/playbooks") return { status: 200, body: { state: "OK", playbooks: [pb] } };
  if (path === `/intelligence/playbooks/${ID(700)}`) return { status: 200, body: { playbook: pb, versions: [{ version: 1, state: "DRAFT", sampleSize: 0, confidence: null, limitations: "", createdAt: T, updatedAt: T, influencesLive: null, activatedAt: null, events: [], content: { hidden: 1 }, performance: { hidden: 2 } }], drift: [], note: "n" } };
  return { status: 404, body: { error: "NOT_FOUND", message: "not found", reasons: [] } };
};
const rel = (path: string, headers: Record<string, string> = { cookie: sessionCookie }) => get(`/api/session${path}`, headers);
const seg = (p: string): string[] => p.split("?")[0]!.split("/").filter(Boolean);
const run = (path: string, a: (p: string) => { status: number; body: unknown } = answer, headers?: Record<string, string>) => { const f = fakeFetch((s) => a(new URL(s.url).pathname)); return relay(rel(path, headers), seg(path), { cfg: cfgHost(), fetcher: f.fetcher }).then((res) => ({ res, f })); };
const READS = [`/decisions?limit=200`, `/decisions?state=PENDING&limit=200`, `/decisions/${ID(500)}`, `/decisions/${ID(500)}/comparables`, "/intelligence/playbooks?limit=25&offset=0", `/intelligence/playbooks/${ID(700)}`];

describe("decisions and playbooks through the relay", () => {
  for (const path of READS) it(`${path}: GET only, the session token only, a strict response reaches the browser`, async () => {
    const { res, f } = await run(path); expect(res.status).toBe(200); expect(f.seen).toHaveLength(1); const u = f.seen[0]!;
    expect(u.method).toBe("GET"); expect(u.headers["authorization"]).toBe(`Bearer ${TOKEN}`); expect(u.headers["cookie"]).toBeUndefined(); expect(u.headers["x-api-key"]).toBeUndefined();
    const text = await res.text(); expect(text).not.toMatch(/secretInternal|hidden/);
  });
  it("money reaches the browser as the exact decimal strings the backend sent", async () => {
    const { res } = await run(`/decisions/${ID(500)}`), b = (await res.json()) as { decision: { permittedSize: { maxLossAtStop: unknown; grossExposure: unknown } } };
    expect(b.decision.permittedSize.maxLossAtStop).toBe("1250.50"); expect(b.decision.permittedSize.grossExposure).toBe("10050.00");
  });
  it("a contract break (numeric money, an unknown workflow state) becomes a neutral error with NO data", async () => {
    for (const bad of [dec({ permittedSize: { lots: 2, quantity: 100, maxLossAtStop: 1250.5, riskPerLot: "1", grossExposure: "1", sizeMultiplier: 1, binding: "x" } }), dec({ workflowState: "APPROVED_AND_EXECUTED" })]) {
      const { res } = await run(`/decisions/${ID(500)}`, () => ({ status: 200, body: { decision: bad, events: [], approval: null, watching: false } })); expect(res.status).toBe(502); expect(JSON.stringify(await res.json())).not.toMatch(/permittedSize|APPROVED_AND_EXECUTED|1250/);
    }
  });
  it("another user's decision and an ADMIN session are the backend's 404, passed on with no data; a backend failure is a neutral 502", async () => {
    const nf = await run(`/decisions/${ID(501)}`); expect(nf.res.status).toBe(404);
    const boom = await run(`/decisions/${ID(500)}`, () => ({ status: 500, body: { internal: "stack trace" } })); expect(boom.res.status).toBe(502); expect(await boom.res.text()).not.toMatch(/stack trace/);
  });
  it("no empty playbook list is invented: EMPTY stays EMPTY", async () => { const { res } = await run("/intelligence/playbooks", () => ({ status: 200, body: { state: "EMPTY", playbooks: [] } })); expect(await res.json()).toEqual({ state: "EMPTY", playbooks: [] }); });
  it("unknown query keys (offset on decisions, anything on a detail) and unsafe values are refused before the backend is contacted", async () => {
    for (const p of ["/decisions?offset=10", "/decisions?candidateId=" + ID(1), `/decisions/${ID(500)}?x=1`, `/decisions/${ID(500)}/comparables?x=1`, "/intelligence/playbooks?q=1", "/decisions?state=PENDING%20OR%201"]) { const { res, f } = await run(p); expect(res.status, p).toBe(422); expect(f.seen, p).toHaveLength(0); }
  });
  it("nothing but GET works: approve, reject, cancel, watch, unwatch and every write verb are refused and never reach the backend", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} })), d = { cfg: cfgHost(), fetcher: f.fetcher };
    for (const verb of ["approve", "reject", "cancel", "watch", "unwatch"]) for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await relay(new Request(`${ORIGIN}/api/session/decisions/${ID(500)}/${verb}`, { method: m, headers: { cookie: sessionCookie, origin: ORIGIN }, body: m === "POST" ? "{}" : null }), ["decisions", ID(500), verb], d); expect([404, 405], `${m} ${verb}`).toContain(res.status);
    }
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect([404, 405]).toContain((await relay(new Request(`${ORIGIN}/api/session/intelligence/playbooks`, { method: m, headers: { cookie: sessionCookie, origin: ORIGIN }, body: m === "POST" ? "{}" : null }), ["intelligence", "playbooks"], d)).status);
    expect(f.seen).toHaveLength(0);
  });
  it("no session sends nothing upstream; ids must be UUIDs", async () => {
    const a = await run("/decisions", answer, {}); expect(a.res.status).toBe(401); expect(a.f.seen).toHaveLength(0);
    const b = await run("/decisions/not-a-uuid"); expect(b.res.status).toBe(404); expect(b.f.seen).toHaveLength(0);
    const c = await run("/intelligence/playbooks/not-a-uuid"); expect(c.res.status).toBe(404); expect(c.f.seen).toHaveLength(0);
  });
});
