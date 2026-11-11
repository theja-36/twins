/**
 * Response-shape parity for the routes that have a typed wire contract. Each expected key list is compile-time checked against the contract interface (`satisfies readonly (keyof T)[]`)
 * and compared with the keys the REAL route returns for synthetic data. This proves the verified fields exist and that the route adds no undeclared field.
 * Fields declared `unknown` in the contract are present but their inner shape is deliberately NOT asserted here (see docs/frontend/contracts-verification.md).
 */
import { describe, expect, it } from "vitest";
import type { AccountView, ApprovalActionResponse, CancelResponse, DecisionDetailResponse, DecisionEventView, DecisionView, PendingApprovalView, PermittedSize, PortfolioFacts, PortfolioResponse, PublicUser, WatchResponse, CapitalProfileView, CapitalProfileResponse } from "../../../packages/api-contracts/src/index";
import { ACCOUNT, DECISION, build } from "../../support/contractHarness";

const sorted = (o: unknown): string[] => Object.keys(o as object).sort();
const exp = <T>(k: readonly (keyof T & string)[]): string[] => [...k].sort();

const DECISION_KEYS = exp<DecisionView>(["id", "accountId", "candidateId", "outcome", "workflowState", "explanation", "stopLossValidation", "permittedSize", "evidenceRefs", "versions", "validFrom", "validUntil", "supersedesId", "createdAt", "invalidated", "simulationId", "riskAssessmentId"]);

describe("typed wire contracts match the real routes", () => {
  it("GET /accounts, /auth/me", async () => {
    const h = await build(), t = await h.trader();
    const acc = (await h.call("GET", "/accounts", t.token)).json() as { accounts: unknown[] };
    expect(sorted(acc)).toEqual(["accounts"]); expect(sorted(acc.accounts[0])).toEqual(exp<AccountView>(["id", "name", "tradingMode", "baseCurrency", "isActive"]));
    const me = (await h.call("GET", "/auth/me", t.token)).json() as { user: PublicUser };
    expect(sorted(me)).toEqual(["user"]); expect(sorted(me.user)).toEqual(exp<PublicUser>(["id", "email", "displayName", "role", "isActive"]));
    expect(me.user.role).toBe("TRADER"); expect(me).not.toHaveProperty("permissions"); expect(me.user).not.toHaveProperty("roles"); // a single role; no permission list
  });
  it("GET /approvals and /decisions/:id", async () => {
    const h = await build(), t = await h.trader();
    const ap = (await h.call("GET", "/approvals", t.token)).json() as { pending: PendingApprovalView[]; history: DecisionView[] };
    expect(sorted(ap)).toEqual(["history", "pending"]);
    expect(sorted(ap.pending[0])).toEqual([...DECISION_KEYS, "action", "expired"].sort());
    expect(ap.pending[0]?.action).toEqual({ available: true }); expect(typeof ap.pending[0]?.expired).toBe("boolean");
    expect(sorted(ap.pending[0]?.permittedSize)).toEqual(exp<PermittedSize>(["lots", "quantity", "maxLossAtStop", "riskPerLot", "grossExposure", "sizeMultiplier", "binding"]));
    const ps = ap.pending[0]?.permittedSize as PermittedSize; expect([typeof ps.lots, typeof ps.quantity, typeof ps.sizeMultiplier]).toEqual(["number", "number", "number"]); expect([typeof ps.maxLossAtStop, typeof ps.riskPerLot, typeof ps.grossExposure]).toEqual(["string", "string", "string"]);
    const d = (await h.call("GET", `/decisions/${DECISION}`, t.token)).json() as DecisionDetailResponse;
    expect(sorted(d)).toEqual(exp<DecisionDetailResponse>(["decision", "events", "approval", "watching"])); expect(sorted(d.decision)).toEqual(DECISION_KEYS);
    expect(sorted(d.events[0])).toEqual(exp<DecisionEventView>(["fromState", "toState", "actor", "reason", "at"])); expect(typeof d.events[0]?.at).toBe("string");
  });
  it("action responses: approve / reject, cancel, watch / unwatch", async () => {
    const h = await build(), t = await h.trader(), body = { idempotencyKey: "key-0000001" };
    const a = (await h.call("POST", `/decisions/${DECISION}/approve`, t.token, body)).json() as ApprovalActionResponse; expect(sorted(a)).toEqual(exp<ApprovalActionResponse>(["decisionId", "status"]));
    const c = (await h.call("POST", `/decisions/${DECISION}/cancel`, t.token, { reason: "no longer wanted" })).json() as CancelResponse; expect(sorted(c)).toEqual(exp<CancelResponse>(["decisionId", "result"]));
    for (const v of ["watch", "unwatch"]) { const w = (await h.call("POST", `/decisions/${DECISION}/${v}`, t.token, body)).json() as WatchResponse; expect(sorted(w)).toEqual(exp<WatchResponse>(["decisionId", "status", "watching", "grantsApproval"])); expect(w.grantsApproval).toBe(false); }
  });
  it("GET /capital/profile and /portfolio (money as strings, counts as numbers, no unrealised P&L)", async () => {
    const h = await build(), t = await h.trader();
    const cp = (await h.call("GET", `/capital/profile?accountId=${ACCOUNT}`, t.token)).json() as CapitalProfileResponse;
    expect(sorted(cp)).toEqual(exp<CapitalProfileResponse>(["accountId", "isolation", "effective", "versions"])); expect(cp.isolation).toBe("PER_USER_ACCOUNT");
    expect(sorted(cp.effective)).toEqual(exp<CapitalProfileView>(["id", "accountId", "version", "totalCapital", "availableCapital", "maxPositionNotionalPct", "currency", "effectiveFrom", "createdBy"]));
    const pf = (await h.call("GET", `/portfolio?accountId=${ACCOUNT}`, t.token)).json() as PortfolioResponse;
    expect(sorted(pf)).toEqual(exp<PortfolioResponse>(["accountId", "mode", "isolation", "facts", "notes"])); expect(pf.mode).toBe("PAPER");
    expect(sorted(pf.facts)).toEqual(exp<PortfolioFacts>(["accountId", "openPositions", "allocatedNotional", "realizedPnl", "totalCapital", "availableCapital", "unallocatedCapital", "capitalProfileVersion"]));
    expect(typeof pf.facts?.openPositions).toBe("number"); expect(typeof pf.facts?.allocatedNotional).toBe("string");
    expect(JSON.stringify(pf).toLowerCase()).not.toMatch(/unrealis|unrealiz|markprice|mark_price|livebalance/);
    expect(pf.notes.join(" ")).toContain("no live portfolio source is connected");
  });
  it("empty lists have the declared envelope keys (rows are returned verbatim from the stores, typed from their row interfaces)", async () => {
    const h = await build(), t = await h.trader();
    for (const [url, key] of [["/execution/orders", "orders"], ["/execution/positions", "positions"], ["/risk/controls", "controls"], [`/execution/orders/${DECISION}/fills`, "fills"], [`/execution/positions/${DECISION}/events`, "events"]] as const) expect(sorted((await h.call("GET", url, t.token)).json()), url).toEqual([key]);
    const rp = (await h.call("GET", `/risk/policy?accountId=${ACCOUNT}`, t.token)).json() as { policy: unknown }; expect(sorted(rp)).toEqual(["accountId", "policy"]); expect(rp.policy).toBeNull();
  });
});
