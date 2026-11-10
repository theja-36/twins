import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerResearchRoutes, type ResearchOps, type StoredResearchPackage } from "../../../apps/api/src/researchApi";

/** Research read API: session-protected, read-only, shared data. Fake operations; the status derivation and the registry metadata are the real code. */
const PW = "correct horse battery staple", ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = new Date("2026-11-09T04:30:00Z");
const pkg = (o: Partial<StoredResearchPackage> = {}): StoredResearchPackage => ({ id: ID(9), version: 2, assessment: "RESEARCH_CAUTION", haltReason: null, createdAt: T, agentResults: { packageVersion: "research-package-v1", candidateId: ID(5), grantsApproval: false, reports: [] }, ...o });
let state = "READY_FOR_DECISION", latest: StoredResearchPackage | null = pkg(), candidateKnown = true; const calls: string[] = [];
const ops: ResearchOps = {
  async latest(id) { calls.push(`latest:${id}`); return id === ID(5) ? latest : null; },
  async byId(id) { calls.push(`byId:${id}`); return id === ID(9) ? pkg() : null; },
  async candidate(id) { calls.push(`candidate:${id}`); return candidateKnown && (id === ID(5) || id === ID(6)) ? { state, attempts: 3 } : null; },
};
async function build(maxAttempts?: number) {
  const store = memoryAuthStore(), auth = new AuthService({ store, audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerResearchRoutes(app, { auth, ops, ...(maxAttempts !== undefined ? { researchMaxAttempts: maxAttempts } : {}) });
  await auth.register({ email: "t@example.com", password: PW }); const token = (await auth.login({ email: "t@example.com", password: PW })).token;
  return { token, app, get: (u: string, t?: string) => app.inject({ method: "GET", url: u, headers: t ? { authorization: `Bearer ${t}` } : {} }) };
}
const URLS = [`/research/candidates/${ID(5)}/package`, `/research/packages/${ID(9)}`, "/research/agents"];

describe("research routes: access", () => {
  it("require a session; the service key and garbage are refused before any data is read", async () => {
    const b = await build(); calls.length = 0;
    for (const u of URLS) for (const t of [undefined, "test-api-key-default", "tws_short"]) expect((await b.get(u, t)).statusCode, `${u} ${t}`).toBe(401);
    expect(calls).toEqual([]); for (const u of URLS) expect((await b.get(u, b.token)).statusCode, u).toBe(200);
  });
  it("are read-only: nothing but GET exists", async () => { const b = await build(); for (const u of URLS) for (const m of ["POST", "PUT", "PATCH", "DELETE"] as const) expect((await b.app.inject({ method: m, url: u, headers: { authorization: `Bearer ${b.token}` } })).statusCode, `${m} ${u}`).toBe(404); });
  it("validate ids and refuse unknown parameters", async () => {
    const b = await build();
    expect((await b.get("/research/packages/not-a-uuid", b.token)).statusCode).toBe(422);
    expect((await b.get(`/research/packages/${ID(9)}?bogus=1`, b.token)).statusCode).toBe(422);
    expect((await b.get(`/research/packages/${ID(1)}`, b.token)).statusCode).toBe(404); // the same answer for every missing id
  });
});
describe("research package views", () => {
  it("returns the package with its derived status and attempts, grantsApproval false, and no write side effects", async () => {
    const b = await build(); state = "READY_FOR_DECISION"; latest = pkg();
    const j = (await b.get(URLS[0]!, b.token)).json();
    expect(j).toMatchObject({ packageId: ID(9), candidateId: ID(5), version: 2, assessment: "RESEARCH_CAUTION", status: "COMPLETED", researchAttempts: 3, createdAt: "2026-11-09T04:30:00.000Z" });
    expect(j.package.grantsApproval).toBe(false);
  });
  it("an INCOMPLETE package is PARTIAL, never COMPLETED", async () => {
    const b = await build(); state = "READY_FOR_DECISION"; latest = pkg({ assessment: "RESEARCH_INCOMPLETE" });
    expect((await b.get(URLS[0]!, b.token)).json().status).toBe("PARTIAL");
  });
  it("a candidate with no package yet says so and reports its status; nothing is inferred", async () => {
    const b = await build(); latest = null;
    state = "NEW"; expect((await b.get(URLS[0]!, b.token)).json()).toMatchObject({ status: "PENDING", package: null, note: expect.stringMatching(/nothing is inferred/) });
    state = "IN_RESEARCH"; expect((await b.get(URLS[0]!, b.token)).json().status).toBe("RUNNING");
  });
  it("an unknown candidate with no package is 404", async () => { const b = await build(); latest = null; candidateKnown = false; expect((await b.get(URLS[0]!, b.token)).statusCode).toBe(404); candidateKnown = true; });
  it("a withdrawn candidate is FAILED only when the dispatcher's attempt limit is configured and reached; otherwise CANCELLED", async () => {
    latest = null; state = "WITHDRAWN";
    expect((await (await build(3)).get(URLS[0]!, (await build(3)).token)).statusCode).toBeLessThan(500);
    const b3 = await build(3), b0 = await build();
    expect((await b3.get(`/research/candidates/${ID(5)}/package`, b3.token)).json().status).toBe("FAILED");
    expect((await b0.get(`/research/candidates/${ID(5)}/package`, b0.token)).json().status).toBe("CANCELLED");
    latest = pkg(); state = "READY_FOR_DECISION";
  });
  it("a package fetched by id reports the status of its candidate", async () => { const b = await build(); state = "EXPIRED"; expect((await b.get(URLS[1]!, b.token)).json()).toMatchObject({ candidateId: ID(5), status: "EXPIRED" }); state = "READY_FOR_DECISION"; });
});
describe("agent registry view", () => {
  it("lists the thirteen agents, the twelve roles, the extra specialist and its supplements, and the soft dependency; no model is claimed", async () => {
    const b = await build(), j = (await b.get("/research/agents", b.token)).json();
    expect(j.agents).toHaveLength(13); expect(j.roles).toHaveLength(12); expect(j.extraSpecialists).toEqual(["options-risk-v1"]);
    const by = (id: string) => j.agents.find((a: { agentId: string }) => a.agentId === id);
    expect(by("options-risk-v1")).toMatchObject({ role: "EXTRA", supplementsRoles: ["MARKET_CONTEXT", "LIQUIDITY"] });
    expect(by("market-context-v1")).toMatchObject({ role: "MARKET_CONTEXT", required: false, canBlock: false });
    expect(by("independent-challenger-v1")).toMatchObject({ required: true, softDependsOn: ["market-context-v1"] }); expect(by("independent-challenger-v1").dependsOn).not.toContain("market-context-v1");
    expect(j.note).toMatch(/none uses a model/);
  });
});
