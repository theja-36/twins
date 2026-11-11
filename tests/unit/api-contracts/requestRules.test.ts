/** Request contracts: required query parameters, body rules, idempotency key, reason rules and identity refusal, each driven against the REAL routes. */
import { describe, expect, it } from "vitest";
import { ADMIN_ROUTES, ANALYTICS_ROUTES, AUTH_ROUTES, IDEMPOTENCY_KEY, LIST_LIMIT, PRIVATE_ROUTES, REASON, REFUSED_IDENTITY_FIELDS, UUID_PATTERN } from "../../../packages/api-contracts/src/index";
import { ACCOUNT, DECISION, ID, build } from "../../support/contractHarness";

const fill = (p: string): string => p.replace(/:id/g, DECISION);
const status = async (h: Awaited<ReturnType<typeof build>>, m: "GET" | "POST", url: string, token: string, payload?: unknown): Promise<number> => (await h.call(m, url, token, payload)).statusCode;

describe("required and allowed query parameters", () => {
  it("every route whose catalogue entry requires accountId refuses a request without it, with a bad id, and a foreign id; accepts a valid own id", async () => {
    const h = await build(), t = await h.trader();
    const required = [...PRIVATE_ROUTES, ...ANALYTICS_ROUTES].filter((e) => e.query.required.length > 0);
    expect(required.map((e) => e.path).sort()).toEqual(["/capital/profile", "/portfolio", "/risk/policy"]);
    for (const e of required) {
      expect(e.query.required).toEqual(["accountId"]);
      expect(await status(h, "GET", e.path, t.token), `${e.path} without`).toBe(422);
      expect(await status(h, "GET", `${e.path}?accountId=nope`, t.token), `${e.path} bad`).toBe(422);
      expect(await status(h, "GET", `${e.path}?accountId=${ID(77)}`, t.token), `${e.path} foreign`).toBe(404);
      expect(await status(h, "GET", `${e.path}?accountId=${ACCOUNT}`, t.token), `${e.path} own`).toBe(200);
    }
  });
  it("routes with no required parameter work without one, and every route refuses an unknown query key", async () => {
    const h = await build(), t = await h.trader();
    for (const e of [...PRIVATE_ROUTES, ...ANALYTICS_ROUTES].filter((x) => x.method === "GET")) {
      const base = fill(e.path), q = e.query.required.map((n) => `${n}=${ACCOUNT}`);
      expect(await status(h, "GET", `${base}${q.length ? `?${q.join("&")}` : ""}`, t.token), `${e.id} baseline`).toBe(200);
      expect(await status(h, "GET", `${base}?${[...q, "bogus=1"].join("&")}`, t.token), `${e.id} unknown key`).toBe(422);
    }
  });
  it("identity fields are REFUSED (422), never ignored, in the query and in the body", async () => {
    const h = await build(), t = await h.trader();
    for (const f of REFUSED_IDENTITY_FIELDS) {
      expect(await status(h, "GET", `/decisions?${f}=${ID(5)}`, t.token), `query ${f}`).toBe(422);
      expect(await status(h, "POST", `/decisions/${DECISION}/approve`, t.token, { idempotencyKey: "key-0000001", [f]: ID(5) }), `body ${f}`).toBe(422);
    }
  });
  it("list limit is an integer from 1 to 200; state must be a known decision state", async () => {
    const h = await build(), t = await h.trader();
    for (const [v, want] of [["0", 422], ["201", 422], ["1.5", 422], ["abc", 422], [String(LIST_LIMIT.min), 200], [String(LIST_LIMIT.max), 200]] as const) expect(await status(h, "GET", `/decisions?limit=${v}`, t.token), `limit=${v}`).toBe(want);
    expect(await status(h, "GET", "/decisions?state=PENDING", t.token)).toBe(200); expect(await status(h, "GET", "/decisions?state=BOGUS", t.token)).toBe(422);
  });
  it("analytics: dataset is accepted on overview only, dimension on strategies only, both validated; accountId is accepted and ignored", async () => {
    const h = await build(), t = await h.trader();
    expect(await status(h, "GET", "/analytics/overview?dataset=ALL", t.token)).toBe(200);
    expect(await status(h, "GET", "/analytics/overview?dataset=VALIDATED&accountId=" + ACCOUNT, t.token)).toBe(200);
    expect(await status(h, "GET", "/analytics/overview?dataset=NOPE", t.token)).toBe(422);
    expect(await status(h, "GET", "/analytics/channels?dataset=ALL", t.token)).toBe(422);
    expect(await status(h, "GET", "/analytics/strategies?dimension=instrument", t.token)).toBe(200);
    expect(await status(h, "GET", "/analytics/strategies?dimension=nope", t.token)).toBe(422);
    expect(await status(h, "GET", "/analytics/overview?dimension=instrument", t.token)).toBe(422);
    expect(await status(h, "GET", "/analytics/outcomes?finality=FINAL&limit=5", t.token)).toBe(200);
    expect(await status(h, "GET", "/analytics/outcomes?finality=BAD", t.token)).toBe(422);
    expect(await status(h, "GET", "/analytics/outcomes?limit=201", t.token)).toBe(422);
  });
});

describe("request bodies", () => {
  it("each catalogue body spec is exact: required keys are required, optional keys are accepted, anything else is refused (private POST routes)", async () => {
    const h = await build(), t = await h.trader();
    const valid: Record<string, unknown> = { idempotencyKey: "key-0000001", reason: "a reason that is long enough" };
    for (const e of PRIVATE_ROUTES.filter((x) => x.method === "POST")) {
      const spec = e.body ?? { required: [], optional: [] }, url = fill(e.path), full = Object.fromEntries([...spec.required, ...spec.optional].map((k) => [k, valid[k]]));
      expect(await status(h, "POST", url, t.token, full), `${e.id} full`).toBe(200);
      expect(await status(h, "POST", url, t.token, { ...full, extra: 1 }), `${e.id} unknown field`).toBe(422);
      for (const k of spec.required) { const { [k]: _drop, ...rest } = full; void _drop; expect(await status(h, "POST", url, t.token, rest), `${e.id} missing ${k}`).toBe(422); }
      if (spec.optional.length === 0) continue;
      const onlyRequired = Object.fromEntries(spec.required.map((k) => [k, valid[k]])); expect(await status(h, "POST", url, t.token, onlyRequired), `${e.id} required only`).toBe(200);
    }
  });
  it("idempotencyKey is a BODY field: 8-128 characters of letters, digits and _ . : - ; the contract pattern agrees with the route on every sample", async () => {
    const h = await build(), t = await h.trader();
    const samples = ["abcdefgh", "a".repeat(128), "a.b_c:d-12345", "short", "a".repeat(7), "a".repeat(129), "has space 1", "bad/char/12", "émoji-key-1", ""];
    for (const k of samples) {
      const ok = IDEMPOTENCY_KEY.pattern.test(k);
      for (const verb of ["approve", "reject", "watch", "unwatch"]) expect(await status(h, "POST", `/decisions/${DECISION}/${verb}`, t.token, { idempotencyKey: k }), `${verb} ${JSON.stringify(k)}`).toBe(ok ? 200 : 422);
    }
    expect(IDEMPOTENCY_KEY.field).toBe("idempotencyKey");
    // a header does not substitute for the body field
    const viaHeader = await h.app.inject({ method: "POST", url: `/decisions/${DECISION}/approve`, headers: { authorization: `Bearer ${t.token}`, "idempotency-key": "key-0000001" }, payload: {} });
    expect(viaHeader.statusCode).toBe(422);
  });
  it("reason on approve / reject / watch: optional; when present trimmed, 1-300 characters", async () => {
    const h = await build(), t = await h.trader();
    for (const verb of ["approve", "reject", "watch", "unwatch"]) {
      const url = `/decisions/${DECISION}/${verb}`, key = "key-0000001";
      expect(await status(h, "POST", url, t.token, { idempotencyKey: key }), `${verb} none`).toBe(200);
      expect(await status(h, "POST", url, t.token, { idempotencyKey: key, reason: "x".repeat(REASON.max) }), `${verb} 300`).toBe(200);
      expect(await status(h, "POST", url, t.token, { idempotencyKey: key, reason: "x".repeat(REASON.max + 1) }), `${verb} 301`).toBe(422);
      expect(await status(h, "POST", url, t.token, { idempotencyKey: key, reason: "   " }), `${verb} blank`).toBe(422);
      expect(await status(h, "POST", url, t.token, { idempotencyKey: key, reason: 5 }), `${verb} number`).toBe(422);
    }
  });
  it("cancel: reason REQUIRED, 5-300 characters after trimming; there is no idempotency key on cancel", async () => {
    const h = await build(), t = await h.trader(), url = `/decisions/${DECISION}/cancel`;
    expect(await status(h, "POST", url, t.token, {})).toBe(422);
    expect(await status(h, "POST", url, t.token, { reason: "abcd" })).toBe(422);
    expect(await status(h, "POST", url, t.token, { reason: "  abcd  " })).toBe(422);
    expect(await status(h, "POST", url, t.token, { reason: "abcde" })).toBe(200);
    expect(await status(h, "POST", url, t.token, { reason: "x".repeat(REASON.max) })).toBe(200);
    expect(await status(h, "POST", url, t.token, { reason: "x".repeat(REASON.max + 1) })).toBe(422);
    expect(await status(h, "POST", url, t.token, { reason: "valid reason", idempotencyKey: "key-0000001" })).toBe(422);
    expect(REASON.cancelMin).toBe(5);
  });
  it("a body must be a JSON object; ids in paths must be UUIDs", async () => {
    const h = await build(), t = await h.trader();
    expect(await status(h, "POST", `/decisions/${DECISION}/approve`, t.token, [1])).toBe(422);
    expect(await status(h, "POST", "/decisions/not-a-uuid/approve", t.token, { idempotencyKey: "key-0000001" })).toBe(422);
    expect(UUID_PATTERN.test(DECISION)).toBe(true); expect(UUID_PATTERN.test("not-a-uuid")).toBe(false);
  });
  it("auth bodies: login and change-password take exactly their catalogue fields", async () => {
    const h = await build(), t = await h.trader("rules@example.com");
    const login = AUTH_ROUTES.find((e) => e.id === "auth.login"), change = AUTH_ROUTES.find((e) => e.id === "auth.changePassword");
    expect(login?.body).toEqual({ required: ["email", "password"], optional: [] }); expect(change?.body).toEqual({ required: ["currentPassword", "newPassword"], optional: [] });
    expect((await h.call("POST", "/auth/login", undefined, { email: "rules@example.com", password: "correct horse battery staple", role: "ADMIN" })).statusCode).toBe(422);
    expect((await h.call("POST", "/auth/login", undefined, { email: "rules@example.com" })).statusCode).toBe(422);
    expect((await h.call("POST", "/auth/change-password", t.token, { currentPassword: "x" })).statusCode).toBe(422);
    expect(ADMIN_ROUTES.every((e) => !e.browser)).toBe(true);
  });
});
