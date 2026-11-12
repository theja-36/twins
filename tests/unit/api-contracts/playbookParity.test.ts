/** Stage 09.3B.4: the playbook response keys the frontend relay schemas declare equal what the REAL routes return (list, detail, empty, 404, bounds, roles). Fake data layer; real handlers; no production code is touched. */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { registerAuthRoutes } from "../../../apps/api/src/authApi";
import { registerTelegramIntelRoutes, type TelegramIntelOps } from "../../../apps/api/src/telegramIntelApi";

const PW = "correct horse battery staple", ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, T = new Date("2031-01-06T04:30:00Z");
/** The keys the frontend's strict schemas (frontend/src/bff/schemas.strategies.ts) declare, plus the fields the backend sends and the frontend deliberately never forwards. */
const SUMMARY_KEYS = ["activeVersion", "createdAt", "id", "latestVersion", "name", "sourceKind", "telegramSourceId", "versions"];
const LIST_KEYS = ["playbooks", "state"];
const DETAIL_KEYS = ["drift", "note", "playbook", "versions"];
const VERSION_KEYS_FORWARDED = ["activatedAt", "confidence", "createdAt", "events", "influencesLive", "limitations", "sampleSize", "state", "updatedAt", "version"];
const VERSION_KEYS_NEVER_FORWARDED = ["content", "performance"];
const EVENT_KEYS = ["actor", "at", "fromState", "reason", "toState"];
const DRIFT_KEYS = ["baseline", "detectedAt", "kind", "metric", "observed", "version"];
const keys = (o: unknown): string[] => Object.keys(o as object).sort();
let empty = false;
const summary = { id: ID(700), sourceKind: "INDEPENDENT", telegramSourceId: null, name: "P", createdAt: T, versions: 1, activeVersion: null, latestVersion: 1 };
const ops = {
  async playbooks() { return empty ? [] : [summary]; },
  async playbook(id: string) { return id === ID(700) ? { playbook: summary, versions: [{ version: 1, state: "DRAFT", sampleSize: 0, confidence: null, limitations: "", performance: null, content: {}, createdAt: T, updatedAt: T, influencesLive: null, activatedAt: null, events: [{ fromState: null, toState: "DRAFT", actor: "owner", reason: null, at: T }] }], drift: [{ version: 1, kind: "WIN_RATE", metric: "winRate", baseline: 0.6, observed: 0.4, detectedAt: T }] } : null; },
} as unknown as TelegramIntelOps;

async function build(role: "TRADER" | "ADMIN" = "TRADER") {
  const auth = new AuthService({ store: memoryAuthStore(), audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: role === "TRADER" } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerTelegramIntelRoutes(app, { auth, ops, now: () => T });
  if (role === "TRADER") await auth.register({ email: "t@example.com", password: PW }); else await auth.bootstrapAdmin({ email: "t@example.com", password: PW });
  const token = (await auth.login({ email: "t@example.com", password: PW })).token;
  return (u: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => app.inject({ method: "GET", url: u, headers }).then((r) => ({ status: r.statusCode, body: r.json() as Record<string, unknown> }));
}

describe("playbook routes equal the frontend relay schema", () => {
  it("list and detail keys, including the fields the frontend never forwards", async () => {
    empty = false; const get = await build(), l = await get("/intelligence/playbooks"), d = await get(`/intelligence/playbooks/${ID(700)}`);
    expect(l.status).toBe(200); expect(keys(l.body)).toEqual(LIST_KEYS); expect(l.body["state"]).toBe("OK"); expect(keys((l.body["playbooks"] as unknown[])[0])).toEqual(SUMMARY_KEYS);
    expect(d.status).toBe(200); expect(keys(d.body)).toEqual(DETAIL_KEYS); expect(keys(d.body["playbook"])).toEqual(SUMMARY_KEYS);
    const v = (d.body["versions"] as unknown[])[0]; expect(keys(v)).toEqual([...VERSION_KEYS_FORWARDED, ...VERSION_KEYS_NEVER_FORWARDED].sort()); expect(keys((v as { events: unknown[] }).events[0])).toEqual(EVENT_KEYS); expect(keys((d.body["drift"] as unknown[])[0])).toEqual(DRIFT_KEYS);
  });
  it("an empty store answers state EMPTY with no rows (nothing is invented)", async () => { empty = true; const l = await (await build())("/intelligence/playbooks"); expect(l.body).toEqual({ state: "EMPTY", playbooks: [] }); empty = false; });
  it("an unknown playbook is 404 and a malformed id or parameter is a validation error (422)", async () => {
    const get = await build(); expect((await get(`/intelligence/playbooks/${ID(701)}`)).status).toBe(404); expect((await get("/intelligence/playbooks/not-a-uuid")).status).toBe(422);
    for (const q of ["limit=0", "limit=201", "offset=-1", "x=1"]) expect((await get(`/intelligence/playbooks?${q}`)).status, q).toBe(422);
  });
  it("both roles may read playbooks (shared intelligence); no session or the service key gets 401", async () => {
    for (const role of ["TRADER", "ADMIN"] as const) { const get = await build(role); expect((await get("/intelligence/playbooks")).status, role).toBe(200); expect((await get("/intelligence/playbooks", {})).status).toBe(401); expect((await get("/intelligence/playbooks", { authorization: "Bearer test-api-key-default" })).status).toBe(401); }
  });
});
