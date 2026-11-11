import { describe, expect, it } from "vitest";
import * as T from "../../../packages/types/src/platform/index";

const A = T.asUserId("11111111-1111-4111-8111-111111111111");
const B = T.asUserId("22222222-2222-4222-8222-222222222222");
const trader = (id: T.UserId): T.Principal => ({ kind: "user", userId: id, roles: ["TRADER"] });
const admin: T.Principal = { kind: "user", userId: B, roles: ["ADMIN"] };
const system: T.Principal = { kind: "system", service: "worker" };
const code = (f: () => void): string | null => { try { f(); return null; } catch (e) { return e instanceof T.PlatformError ? e.code : "OTHER"; } };

describe("ids", () => {
  it("accepts UUIDs only", () => { expect(() => T.asUserId("nope")).toThrow(); expect(T.isUuid(A)).toBe(true); });
});

describe("authorisation and user isolation (Part 4)", () => {
  it("decisions:watch is a private, owner-only permission distinct from decisions:read and decisions:approve (M13-09)", () => {
    expect(T.PRIVATE_PERMISSIONS).toContain("decisions:watch");
    for (const list of [T.SHARED_PERMISSIONS, T.ADMIN_PERMISSIONS] as readonly string[][]) expect(list).not.toContain("decisions:watch");
    expect(new Set(["decisions:read", "decisions:watch", "decisions:approve"]).size).toBe(3);
    expect(T.hasPermission(trader(A), "decisions:watch")).toBe(true);
    expect(T.hasPermission(admin, "decisions:watch")).toBe(false);
    expect(T.hasPermission(system, "decisions:watch")).toBe(false);
    expect(code(() => T.authorize(trader(A), "decisions:watch", A))).toBeNull();
    expect(code(() => T.authorize(trader(A), "decisions:watch", B))).toBe("NOT_FOUND"); // another user's decision: existence is not revealed
    expect(code(() => T.authorize(admin, "decisions:watch", A))).toBe("NOT_FOUND");
    expect(code(() => T.authorize(null, "decisions:watch", A))).toBe("UNAUTHENTICATED");
  });
  it("a trader can use own private data", () => { for (const p of T.PRIVATE_PERMISSIONS) expect(code(() => T.authorize(trader(A), p, A)), p).toBeNull(); });
  it("one user can never reach another user's private data, and the refusal does not reveal existence", () => {
    for (const p of T.PRIVATE_PERMISSIONS) expect(code(() => T.authorize(trader(A), p, B)), p).toBe("NOT_FOUND");
  });
  it("an admin has NO access to private trading data, even their own role-wise", () => {
    for (const p of T.PRIVATE_PERMISSIONS) { expect(T.hasPermission(admin, p), p).toBe(false); expect(code(() => T.authorize(admin, p, A)), p).toBe("NOT_FOUND"); }
    expect(T.hasPermission(admin, "audit:read")).toBe(true); expect(T.hasPermission(admin, "users:manage")).toBe(true);
  });
  it("traders cannot manage users or read admin-only data", () => { expect(T.hasPermission(trader(A), "users:manage")).toBe(false); expect(code(() => T.authorize(trader(A), "users:manage"))).toBe("FORBIDDEN"); });
  it("system principals never hold private permissions (they must act with an explicit userId)", () => { for (const p of T.PRIVATE_PERMISSIONS) expect(T.hasPermission(system, p)).toBe(false); expect(T.hasPermission(system, "market:read")).toBe(true); });
  it("an unauthenticated request is refused first", () => { expect(code(() => T.authorize(null, "market:read"))).toBe("UNAUTHENTICATED"); });
  it("a private resource with no owner is refused", () => { expect(code(() => T.authorize(trader(A), "capital:read", null))).toBe("NOT_FOUND"); });
  it("ownerScope returns the caller's own id only, for users", () => { expect(T.ownerScope(trader(A))).toBe(A); expect(code(() => T.ownerScope(system))).toBe("FORBIDDEN"); expect(code(() => T.ownerScope(null))).toBe("UNAUTHENTICATED"); });
  it("every permission is classified exactly once", () => {
    const all = [...T.SHARED_PERMISSIONS, ...T.PRIVATE_PERMISSIONS, ...T.ADMIN_PERMISSIONS]; expect(new Set(all).size).toBe(all.length);
  });
});

describe("errors", () => {
  it("maps codes to HTTP and never leaks details for unknown errors", () => {
    expect(T.toErrorBody(new T.PlatformError("FORBIDDEN", "x")).status).toBe(403);
    expect(T.toErrorBody(new Error("secret db password")).body).toEqual({ error: "INTERNAL", message: "internal error", reasons: [] });
  });
});

describe("events", () => {
  const deps = { newId: () => "evt-1", now: () => new Date("2026-01-01T00:00:00Z") };
  const cid = T.asCorrelationId("33333333-3333-4333-8333-333333333333");
  it("private events must name a user; shared events must not", () => {
    expect(() => T.buildEnvelope(deps, "decision.created", { correlationId: cid, payload: {} })).toThrow(/user-private/);
    expect(() => T.buildEnvelope(deps, "signal.parsed", { correlationId: cid, userId: A, payload: {} })).toThrow(/shared/);
    expect(T.buildEnvelope(deps, "decision.created", { correlationId: cid, userId: A, payload: { x: 1 } }).userId).toBe(A);
    expect(T.buildEnvelope(deps, "signal.parsed", { correlationId: cid, payload: {} }).userId).toBeNull();
  });
  it("the catalogue has no duplicates and execution events are all private", () => {
    expect(new Set(T.EVENT_TYPES).size).toBe(T.EVENT_TYPES.length);
    for (const t of T.EVENT_TYPES.filter((x) => x.startsWith("execution.") || x.startsWith("approval."))) expect(T.isSharedEvent(t), t).toBe(false);
  });
});

describe("jobs", () => {
  it("idempotency keys are stable and execution jobs are never retried", () => {
    expect(T.idempotencyKey("signal.parsed", "m1")).toBe(T.idempotencyKey("signal.parsed", "m1")); expect(T.idempotencyKey("signal.parsed", "m1")).not.toBe(T.idempotencyKey("signal.parsed", "m1", 2));
    expect(T.retryFor("execution").attempts).toBe(1); expect(T.retryFor("research").attempts).toBeGreaterThan(1);
  });
  it("backoff doubles and is capped", () => { const p = { attempts: 9, backoffMs: 1000, maxBackoffMs: 5000 }; expect([1, 2, 3, 4, 5].map((n) => T.backoffDelay(p, n))).toEqual([1000, 2000, 4000, 5000, 5000]); });
});

describe("decision vocabulary", () => {
  it("outcomes and workflow states are separate sets, as in the spec", () => {
    expect(T.DECISION_OUTCOMES).toEqual(["QUALIFIED", "WAIT", "REJECT", "EVALUATION_ONLY", "NO_TRADE"]);
    expect(T.WORKFLOW_STATES).toEqual(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"]);
  });
  it("only PENDING can move, and terminal states never change", () => {
    for (const to of T.WORKFLOW_STATES.filter((s) => s !== "PENDING")) expect(T.isLegalTransition("PENDING", to)).toBe(true);
    for (const from of T.TERMINAL_STATES) for (const to of T.WORKFLOW_STATES) expect(T.isLegalTransition(from, to), `${from}->${to}`).toBe(false);
  });
  it("maps legacy statuses without inventing an approval", () => {
    expect(T.legacyStatusToWorkflow("APPROVED_FOR_REVIEW", false)).toBe("PENDING"); expect(T.legacyStatusToWorkflow("APPROVED_FOR_REVIEW", true)).toBe("APPROVED"); expect(T.legacyStatusToWorkflow("EXPIRED", false)).toBe("EXPIRED");
  });
  it("only QUALIFIED may enter approval", () => { expect(T.DECISION_OUTCOMES.filter(T.mayEnterApproval)).toEqual(["QUALIFIED"]); });
});

describe("verdicts: missing data is never supportive", () => {
  it("anything that did not complete is INCOMPLETE whatever verdict it carried", () => {
    for (const status of ["FAILED", "TIMEOUT", "SKIPPED", "UNAVAILABLE"] as const) expect(T.toSpecVerdict("SUPPORTIVE", status)).toBe("INCOMPLETE");
    expect(T.toSpecVerdict("UNAVAILABLE", "COMPLETED")).toBe("INCOMPLETE"); expect(T.toSpecVerdict("ADVERSE", "COMPLETED")).toBe("ADVERSE");
    expect(T.countsAsSupport("INCOMPLETE")).toBe(false); expect(T.isHardStop("BLOCKING")).toBe(true);
  });
});

describe("opportunity candidates (two independent pipelines)", () => {
  it("origin must match source, and an independent candidate cites no Telegram message", () => {
    expect(T.originMatchesSource({ source: "TELEGRAM", origin: { messageId: "m" } })).toBe(true); expect(T.originMatchesSource({ source: "TELEGRAM", origin: { scanId: "s" } })).toBe(false);
    expect(T.originMatchesSource({ source: "INDEPENDENT", origin: { scanId: "s" } })).toBe(true);
    expect(T.INDEPENDENT_NEEDS_NO_TELEGRAM({ source: "INDEPENDENT", evidence: [{ kind: "telegram_message", id: "x" }] })).toBe(false);
    expect(T.INDEPENDENT_NEEDS_NO_TELEGRAM({ source: "INDEPENDENT", evidence: [{ kind: "market_observation", id: "x" }] })).toBe(true);
  });
  it("expires at its deadline", () => { const c = { expiresAt: "2026-01-01T00:00:00Z", state: "NEW" as const }; expect(T.hasExpired(c, new Date("2025-12-31T23:59:59Z"))).toBe(false); expect(T.hasExpired(c, new Date("2026-01-01T00:00:00Z"))).toBe(true); });
});

const base: T.GateInput = { mode: "PAPER", liveExecutionEnabled: false, paperEnabled: true, userPermitsMode: true, killSwitchActive: false, riskRecheckPassed: true, decisionState: "APPROVED", decisionOutcome: "QUALIFIED", orderConfirmationId: null, autoPolicyId: null, brokerAndRegulatoryGatesVerified: false };
describe("execution gate (never live by default)", () => {
  it("allows paper only when everything holds", () => { expect(T.checkExecutionGate(base).allowed).toBe(true); });
  it("defaults keep both live modes off", () => { expect(T.DEFAULT_EXECUTION_PERMISSIONS).toEqual({ PAPER: true, ASSISTED_LIVE: false, CONTROLLED_AUTO: false }); });
  it("live modes are refused with the operator switch off, even with every other condition met", () => {
    const live = { ...base, userPermitsMode: true, brokerAndRegulatoryGatesVerified: true, orderConfirmationId: "c1", autoPolicyId: "p1" };
    for (const mode of ["ASSISTED_LIVE", "CONTROLLED_AUTO"] as const) { const r = T.checkExecutionGate({ ...live, mode }); expect(r.allowed).toBe(false); expect(r.reasons).toContain("live_execution_disabled"); }
  });
  it("live modes need confirmation / policy / verified gates when the switch is on", () => {
    const on = { ...base, liveExecutionEnabled: true };
    expect(T.checkExecutionGate({ ...on, mode: "ASSISTED_LIVE", brokerAndRegulatoryGatesVerified: true }).reasons).toEqual(["no_explicit_order_confirmation"]);
    expect(T.checkExecutionGate({ ...on, mode: "CONTROLLED_AUTO", brokerAndRegulatoryGatesVerified: true }).reasons).toEqual(["no_authorised_auto_policy"]);
    expect(T.checkExecutionGate({ ...on, mode: "ASSISTED_LIVE", orderConfirmationId: "c" }).reasons).toEqual(["broker_or_regulatory_gate_not_verified"]);
    expect(T.checkExecutionGate({ ...on, mode: "ASSISTED_LIVE", orderConfirmationId: "c", brokerAndRegulatoryGatesVerified: true }).allowed).toBe(true);
  });
  it("a kill switch, an unqualified or unapproved decision, a failed recheck or a missing user permission each refuse, in every mode", () => {
    const cases: Array<[Partial<T.GateInput>, string]> = [[{ killSwitchActive: true }, "kill_switch_active"], [{ decisionOutcome: "WAIT" }, "decision_not_qualified"], [{ decisionState: "PENDING" }, "decision_not_approved"], [{ riskRecheckPassed: false }, "risk_recheck_failed"], [{ userPermitsMode: false }, "user_has_not_enabled_mode"], [{ paperEnabled: false }, "paper_trading_disabled"]];
    for (const [o, reason] of cases) { const r = T.checkExecutionGate({ ...base, ...o }); expect(r.allowed, reason).toBe(false); expect(r.reasons).toContain(reason); }
  });
});

describe("AI boundary", () => {
  const prov = { provider: "p", model: "m", promptVersion: "v1", requestId: "r", receivedAt: "2026-01-01T00:00:00Z" };
  const guard = (v: unknown): v is { verdict: string } => typeof v === "object" && v !== null && typeof (v as { verdict?: unknown }).verdict === "string";
  it("accepts only valid structured output and never repairs it", () => {
    expect(T.parseStructured(T.untrusted('{"verdict":"CAUTION"}'), guard, prov).ok).toBe(true);
    expect(T.parseStructured(T.untrusted("Sure! {\"verdict\":\"CAUTION\"}"), guard, prov)).toMatchObject({ ok: false, reason: "NOT_JSON" });
    expect(T.parseStructured(T.untrusted('{"verdict":5}'), guard, prov)).toMatchObject({ ok: false, reason: "SCHEMA_MISMATCH" });
    expect(T.parseStructured(T.untrusted("  "), guard, prov)).toMatchObject({ ok: false, reason: "EMPTY" });
  });
  it("a route cannot fall back to itself", () => {
    const r = { task: "t", provider: "a", model: "m", maxOutputTokens: 100, timeoutMs: 1000, fallbacks: [{ provider: "b", model: "m" }] };
    expect(T.routeIsSane(r)).toBe(true); expect(T.routeIsSane({ ...r, fallbacks: [{ provider: "a", model: "m" }] })).toBe(false);
  });
});
