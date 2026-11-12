/**
 * Stage 09.3B.3: the research routes against REAL output. The package comes from the real orchestrator and package builder (no providers configured, so most agents report UNAVAILABLE: that is what the real engine produces),
 * stored in an in-memory fake of the store and served by the REAL handlers; the agent roster comes from the real production registry. Complements the PostgreSQL test of the by-candidate route (tests/integration/api-contracts).
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { buildResearchPackage, candidateToAgentInputs, createProductionRegistry, DEFAULT_AGENT_RULES, loadAgentEngineConfig, mapOptionsRisk, orchestrate } from "@twins/agents";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerResearchRoutes, type ResearchOps } from "../../../apps/api/src/researchApi";
import * as C from "../../../packages/api-contracts/src/index";

const NOW = new Date("2031-01-06T05:00:00Z"), cfg = loadAgentEngineConfig({ TWINS_AGENT_ENGINE_ENABLED: "true" }), PW = "correct horse battery staple", ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { exchange: "NSE", side: "BUY" as const, entryKind: "at" as const, stopLoss: 90, targets: [150, 180], dataSource: "FIXTURE" as const, createdAt: new Date("2031-01-06T04:55:00Z") };
const CANDS = [{ ...base, id: ID(1), source: "INDEPENDENT" as const, underlying: "AAA", strike: null, optionType: null, expiry: null, entryLow: 100, entryHigh: 100 }, { ...base, id: ID(2), source: "TELEGRAM" as const, underlying: "NIFTY", strike: 24500, optionType: "CE" as const, expiry: "2031-01-30", entryLow: 120, entryHigh: null }];
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
function exact(o: unknown, required: readonly string[], optional: readonly string[] = [], label = "object"): void { const k = keys(o); expect(k.filter((x) => !required.includes(x) && !optional.includes(x)), `${label}: undeclared`).toEqual([]); expect(required.filter((x) => !k.includes(x)), `${label}: missing`).toEqual([]); }

async function build() {
  const stored = new Map<string, { id: string; version: number; assessment: string; haltReason: string | null; agentResults: unknown; createdAt: Date }>();
  for (const [i, c] of CANDS.entries()) {
    const out = await orchestrate(createProductionRegistry({ rules: DEFAULT_AGENT_RULES }).resolve(cfg), cfg, candidateToAgentInputs(c as never) as never, { riskDecisionId: c.id, decisionVersion: 1 }, { now: () => NOW, sleep: async () => undefined });
    const pkg = buildResearchPackage(c as never, 1, out, { optionsRiskMapping: mapOptionsRisk({ candidate: c as never, now: NOW, contract: null }) });
    stored.set(c.id, { id: ID(900 + i), version: 1, assessment: pkg.assessment, haltReason: pkg.haltReason, agentResults: JSON.parse(JSON.stringify(pkg)), createdAt: NOW });
  }
  const ops: ResearchOps = { latest: async (id) => stored.get(id) ?? null, byId: async (id) => [...stored.values()].find((p) => p.id === id) ?? null, candidate: async (id) => (stored.has(id) ? { state: "NEW", attempts: 1 } : null) };
  const auth = new AuthService({ store: memoryAuthStore(), audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerResearchRoutes(app, { auth, ops });
  await auth.register({ email: "t@example.com", password: PW }); const token = (await auth.login({ email: "t@example.com", password: PW })).token;
  return { app, token, get: (u: string, t = token) => app.inject({ method: "GET", url: u, headers: { authorization: `Bearer ${t}` } }).then((r) => ({ status: r.statusCode, body: r.json() as Record<string, unknown> })) };
}

describe("research routes with real orchestrator output", () => {
  it("/research/packages/:id returns the same envelope and body shape as the by-candidate route, for an equity and an option candidate", async () => {
    const h = await build();
    for (const [n, c] of CANDS.entries()) {
      const a = await h.get(`/research/candidates/${c.id}/package`), b = await h.get(`/research/packages/${ID(900 + n)}`);
      expect(a.status).toBe(200); expect(b.status).toBe(200); exact(a.body, C.RESEARCH_PACKAGE_KEYS, [], "by candidate"); exact(b.body, C.RESEARCH_PACKAGE_KEYS, [], "by id");
      expect(b.body["package"]).toEqual(a.body["package"]); expect(b.body["candidateId"]).toBe(c.id);
      const p = b.body["package"] as Record<string, unknown>; exact(p, C.RESEARCH_PACKAGE_BODY_KEYS, C.RESEARCH_PACKAGE_BODY_OPTIONAL_KEYS, "package"); expect(p["grantsApproval"]).toBe(false);
      for (const r of p["reports"] as unknown[]) exact(r, C.AGENT_REPORT_KEYS, C.AGENT_REPORT_OPTIONAL_KEYS, "report");
      expect(typeof p["asOf"]).toBe("string"); expect((p["reports"] as unknown[]).length).toBeGreaterThan(10);
    }
  });
  it("a real run without providers is INCOMPLETE and halted, every non-completed agent says INCOMPLETE with an error code, and the option candidate carries an options-risk context (structure left unknown)", async () => {
    const h = await build();
    for (const c of CANDS) {
      const p = (await h.get(`/research/candidates/${c.id}/package`)).body["package"] as Record<string, unknown>;
      expect(p["assessment"]).toBe("RESEARCH_INCOMPLETE"); expect(p["halt"]).toBe(true); expect(typeof p["haltReason"]).toBe("string"); expect((p["missingRequired"] as unknown[]).length).toBeGreaterThan(0);
      for (const r of (p["reports"] as Array<Record<string, unknown>>).filter((x) => x["executionStatus"] !== "COMPLETED")) { expect(r["verdict"]).toBe("INCOMPLETE"); expect(typeof r["errorCode"]).toBe("string"); expect(r["confidence"]).toBeNull(); }
    }
    expect("optionsRisk" in ((await h.get(`/research/candidates/${ID(2)}/package`)).body["package"] as object)).toBe(true); expect("optionsRisk" in ((await h.get(`/research/candidates/${ID(1)}/package`)).body["package"] as object)).toBe(false);
  });
  it("/research/agents matches the contract and the real production registry: 13 agents, 12 roles, one extra specialist, metadata only", async () => {
    const h = await build(), r = await h.get("/research/agents"); expect(r.status).toBe(200); exact(r.body, C.AGENT_REGISTRY_KEYS, [], "registry");
    const agents = r.body["agents"] as Array<Record<string, unknown>>, roles = r.body["roles"] as Array<Record<string, unknown>>; expect(agents).toHaveLength(13); expect(roles).toHaveLength(12);
    for (const a of agents) { exact(a, C.AGENT_REGISTRY_ROW_KEYS, [], `agent ${String(a["agentId"])}`); expect(typeof a["weight"]).toBe("number"); expect(typeof a["timeoutMs"]).toBe("number"); expect(Array.isArray(a["requiredInputs"])).toBe(true); }
    for (const x of roles) exact(x, C.ROLE_ROW_KEYS, [], "role"); expect(r.body["extraSpecialists"]).toEqual(["options-risk-v1"]); expect(String(r.body["note"])).toMatch(/none uses a model/); expect(JSON.stringify(r.body)).not.toMatch(/candidateId|userId|accountId/);
  });
  it("the routes are session-only and read-only; an unknown package or candidate is 404; the service key is refused", async () => {
    const h = await build();
    for (const u of [`/research/candidates/${ID(1)}/package`, `/research/packages/${ID(900)}`, "/research/agents"]) {
      for (const t of ["test-api-key-default", "tws_short"]) expect((await h.get(u, t)).status, `${u} ${t}`).toBe(401);
      for (const m of ["POST", "PUT", "PATCH", "DELETE"] as const) expect([404, 405], `${m} ${u}`).toContain((await h.app.inject({ method: m, url: u, headers: { authorization: `Bearer ${h.token}` }, payload: {} })).statusCode);
    }
    expect((await h.get(`/research/packages/${ID(777)}`)).status).toBe(404); expect((await h.get(`/research/candidates/${ID(778)}/package`)).status).toBe(404);
  });
});
