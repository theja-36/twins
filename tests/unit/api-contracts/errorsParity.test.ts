/** Error contracts: the platform taxonomy and the approval-action mapping equal what the real routes answer. */
import { describe, expect, it } from "vitest";
import { PLATFORM_ERROR_CODES as B_CODES, PlatformError } from "../../../packages/types/src/index";
import { APPROVAL_ERROR_CODES, APPROVAL_ERROR_HTTP, PLATFORM_ERROR_CODES, PLATFORM_ERROR_HTTP, isApprovalErrorBody, type ApprovalErrorCode } from "../../../packages/api-contracts/src/index";
import { DECISION, build } from "../../support/contractHarness";

describe("platform error taxonomy", () => {
  it("codes and the HTTP map equal packages/types/src/platform/errors.ts", () => {
    expect([...PLATFORM_ERROR_CODES]).toEqual([...B_CODES]);
    for (const c of B_CODES) expect(PLATFORM_ERROR_HTTP[c], c).toBe(new PlatformError(c, "m").httpStatus);
  });
  it("the real routes answer { error, message, reasons } and nothing else, with the mapped status", async () => {
    const h = await build(), t = await h.trader();
    const anon = await h.call("GET", "/accounts"); expect(anon.statusCode).toBe(PLATFORM_ERROR_HTTP.UNAUTHENTICATED);
    const bad = await h.call("GET", "/capital/profile", t.token); expect(bad.statusCode).toBe(PLATFORM_ERROR_HTTP.VALIDATION);
    const nf = await h.call("GET", `/capital/profile?accountId=${DECISION}`, t.token); expect(nf.statusCode).toBe(PLATFORM_ERROR_HTTP.NOT_FOUND);
    for (const [res, code] of [[anon, "UNAUTHENTICATED"], [bad, "VALIDATION"], [nf, "NOT_FOUND"]] as const) {
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort(), code).toEqual(["error", "message", "reasons"]); expect(body["error"]).toBe(code); expect(Array.isArray(body["reasons"])).toBe(true);
    }
  });
});

describe("approval action errors (approve and reject)", () => {
  it("codes are the seven ApprovalError codes and the map matches APPROVAL_HTTP", () => {
    expect([...APPROVAL_ERROR_CODES]).toEqual(["NOT_FOUND", "NOT_PENDING", "NOT_QUALIFIED", "EXPIRED", "REVALIDATION_FAILED", "ALREADY_ACTIONED", "NOT_PERMITTED"]);
    expect(Object.keys(APPROVAL_ERROR_HTTP).sort()).toEqual([...APPROVAL_ERROR_CODES].sort());
  });
  for (const code of APPROVAL_ERROR_CODES) for (const verb of ["approve", "reject"] as const) {
    it(`${verb}: ${code} -> ${APPROVAL_ERROR_HTTP[code].status} state ${APPROVAL_ERROR_HTTP[code].state}`, async () => {
      const failed = code === "REVALIDATION_FAILED" ? ["STOP_LOSS_VALID", "RISK_BUDGET"] : [];
      const h = await build({ approveError: { code: code as ApprovalErrorCode, ...(failed.length ? { failedChecks: failed } : {}) } }), t = await h.trader();
      const res = await h.call("POST", `/decisions/${DECISION}/${verb}`, t.token, { idempotencyKey: "key-0000001" });
      const body = res.json() as Record<string, unknown>;
      expect(res.statusCode).toBe(APPROVAL_ERROR_HTTP[code].status);
      expect(Object.keys(body).sort()).toEqual(["error", "message", "reasons", "state"]);
      expect(body["error"]).toBe(code); expect(body["state"]).toBe(APPROVAL_ERROR_HTTP[code].state);
      expect(body["reasons"]).toEqual(failed); // the NAMES of the failed re-validation checks, nothing else
      expect(isApprovalErrorBody(body)).toBe(true);
    });
  }
});

describe("login failure contract (resolves the Stage 09.0 UNVERIFIED item)", () => {
  it("wrong credentials and unknown users answer 401 UNAUTHENTICATED 'invalid credentials'; after 5 failures the account is locked: 403 FORBIDDEN, even for the correct password", async () => {
    const h = await build(); await h.trader("lock@example.com");
    const bad = (e: string, i: number) => h.call("POST", "/auth/login", undefined, { email: e, password: `wrong password ${i}` });
    const unknown = await bad("nobody@example.com", 0);
    expect(unknown.statusCode).toBe(401); expect(unknown.json()).toEqual({ error: "UNAUTHENTICATED", message: "invalid credentials", reasons: [] });
    for (let i = 0; i < 5; i++) { const r = await bad("lock@example.com", i); expect(r.statusCode, `failure ${i + 1}`).toBe(401); }
    const locked = await bad("lock@example.com", 9);
    expect(locked.statusCode).toBe(403); expect(locked.json()).toEqual({ error: "FORBIDDEN", message: "too many attempts, try again later", reasons: [] });
    const correct = await h.call("POST", "/auth/login", undefined, { email: "lock@example.com", password: "correct horse battery staple" });
    expect(correct.statusCode).toBe(403); // lockout is keyed by the email, so anyone can lock a known user out (documented residual risk R16)
  });
});
