import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISABLED_BROKER_ADAPTER, checkAssistedLive, checkControlledAuto, classifyBrokerReport, proposalDigest, toScaled, validateAutoPolicy, type AutoPolicy, type AutoState, type LiveOrderProposal, type OrderConfirmation } from "../../../packages/types/src";

const NOW = new Date("2031-01-06T05:00:00Z"), at = (m: number) => new Date(NOW.getTime() + m * 60_000);
const gate = (o: Record<string, unknown> = {}) => ({ liveExecutionEnabled: true, riskRecheckPassed: true, paperEnabled: true, userPermitsMode: true, killSwitchActive: false, decisionState: "APPROVED" as const, decisionOutcome: "QUALIFIED" as const, brokerAndRegulatoryGatesVerified: true, ...o });
const proposal: LiveOrderProposal = { userId: "u1", accountId: "a1", decisionId: "d1", instrument: "ACME", exchange: "NSE", side: "BUY", quantity: "25", orderType: "LIMIT", limitPrice: "100.05", proposedAt: at(-10) };
const conf = (o: Partial<OrderConfirmation> = {}): OrderConfirmation => ({ id: "c1", userId: "u1", digest: proposalDigest(proposal), confirmedAt: at(-5), expiresAt: at(5), consumedAt: null, revokedAt: null, ...o });
const recheck = { passed: true, at: at(-1) };
const al = (o: Record<string, unknown> = {}) => checkAssistedLive({ gate: gate(), proposal, confirmation: conf(), recheck, now: NOW, maxRecheckAgeSeconds: 120, ...o } as never);

describe("Assisted Live architecture (M13-18..22)", () => {
  it("allows only when the owner confirmed THIS order once, risk was just rechecked and every gate is open", () => { expect(al()).toEqual({ allowed: true, reasons: [] }); });
  it("the operator switch off refuses everything, whatever else is satisfied (the master build always passes false)", () => {
    expect(al({ gate: gate({ liveExecutionEnabled: false }) })).toMatchObject({ allowed: false, reasons: expect.arrayContaining(["live_execution_disabled"]) });
  });
  it("refuses without a confirmation, with another user's, a changed order, an expired, used or revoked one", () => {
    expect(al({ confirmation: null }).reasons).toContain("no_explicit_order_confirmation");
    expect(al({ confirmation: conf({ userId: "u2" }) }).reasons).toContain("confirmation_not_by_owner");
    expect(al({ proposal: { ...proposal, quantity: "26" } }).reasons).toContain("confirmation_does_not_match_order");
    expect(al({ confirmation: conf({ expiresAt: at(-1) }) }).reasons).toContain("confirmation_expired");
    expect(al({ confirmation: conf({ consumedAt: at(-2) }) }).reasons).toContain("confirmation_already_used");
    expect(al({ confirmation: conf({ revokedAt: at(-2) }) }).reasons).toContain("confirmation_revoked");
    expect(al({ confirmation: conf({ confirmedAt: at(-20) }) }).reasons).toContain("confirmation_predates_proposal");
  });
  it("refuses on a missing, stale, future-dated or failed risk recheck", () => {
    expect(al({ recheck: null }).reasons).toContain("risk_recheck_missing_or_stale");
    expect(al({ recheck: { passed: true, at: at(-30) } }).reasons).toContain("risk_recheck_missing_or_stale");
    expect(al({ recheck: { passed: true, at: at(3) } }).reasons).toContain("risk_recheck_missing_or_stale");
    expect(al({ recheck: { passed: false, at: at(-1) } }).reasons).toContain("risk_recheck_failed");
  });
  it("a kill switch, an unapproved or unqualified decision, a missing permission or an unverified broker gate each refuse", () => {
    for (const [o, r] of [[{ killSwitchActive: true }, "kill_switch_active"], [{ decisionState: "PENDING" }, "decision_not_approved"], [{ decisionOutcome: "WAIT" }, "decision_not_qualified"], [{ userPermitsMode: false }, "user_has_not_enabled_mode"], [{ brokerAndRegulatoryGatesVerified: false }, "broker_or_regulatory_gate_not_verified"]] as const) expect(al({ gate: gate(o) }).reasons).toContain(r);
  });
});

const policy = (o: Partial<AutoPolicy> = {}): AutoPolicy => ({ id: "p1", userId: "u1", accountId: "a1", authorisedBy: "u1", authorisedAt: at(-60), expiresAt: at(600), revokedAt: null, strategies: ["BREAKOUT"], maxOrderQuantity: "100", maxOrderNotional: "50000", maxOpenNotional: "150000", maxDailyLoss: "5000", maxOpenPositions: 3, maxOrdersPerDay: 10, ...o });
const state = (o: Partial<AutoState> = {}): AutoState => ({ openNotional: "0", openPositions: 0, realisedLossToday: "0", ordersToday: 0, emergencyStop: false, ...o });
const order = { userId: "u1", accountId: "a1", strategy: "BREAKOUT", quantity: "50", notional: "40000" };
const ca = (o: Record<string, unknown> = {}) => checkControlledAuto({ gate: gate(), policy: policy(), order, state: state(), now: NOW, ...o } as never);

describe("Controlled Auto architecture (M13-23..29)", () => {
  it("allows only inside a valid, owner-authorised, unrevoked policy with every limit respected", () => { expect(ca()).toEqual({ allowed: true, reasons: [] }); });
  it("the operator switch off refuses everything", () => { expect(ca({ gate: gate({ liveExecutionEnabled: false }) }).allowed).toBe(false); });
  it("limits are exact at the boundary: at the limit passes, one unit above refuses", () => {
    expect(ca({ order: { ...order, quantity: "100" } }).allowed).toBe(true);
    expect(ca({ order: { ...order, quantity: "100.00000001" } }).reasons).toContain("order_quantity_above_limit");
    expect(ca({ order: { ...order, notional: "50000" } }).allowed).toBe(true);
    expect(ca({ order: { ...order, notional: "50000.01" } }).reasons).toContain("order_notional_above_limit");
    expect(ca({ state: state({ openNotional: "110000" }) }).allowed).toBe(true);
    expect(ca({ state: state({ openNotional: "110000.01" }) }).reasons).toContain("open_notional_would_exceed_limit");
    expect(ca({ state: state({ realisedLossToday: "4999.99" }) }).allowed).toBe(true);
    expect(ca({ state: state({ realisedLossToday: "5000" }) }).reasons).toContain("daily_loss_limit_reached");
    expect(ca({ state: state({ openPositions: 2 }) }).allowed).toBe(true);
    expect(ca({ state: state({ openPositions: 3 }) }).reasons).toContain("open_positions_at_limit");
    expect(ca({ state: state({ ordersToday: 10 }) }).reasons).toContain("orders_per_day_at_limit");
  });
  it("the emergency stop, revocation and expiry refuse at once", () => {
    expect(ca({ state: state({ emergencyStop: true }) }).reasons).toContain("emergency_stop_active");
    expect(ca({ policy: policy({ revokedAt: at(-1) }) }).reasons).toContain("policy_revoked");
    expect(ca({ policy: policy({ revokedAt: at(1) }) }).allowed).toBe(true); // a revocation scheduled for later has not happened yet
    expect(ca({ policy: policy({ expiresAt: at(-1) }) }).reasons).toContain("policy_expired");
    expect(ca({ policy: null }).reasons).toContain("no_authorised_auto_policy");
    expect(ca({ gate: gate({ killSwitchActive: true }) }).reasons).toContain("kill_switch_active");
  });
  it("another user's or account's policy, an unlisted strategy and an unparseable amount refuse", () => {
    expect(ca({ order: { ...order, userId: "u2" } }).reasons).toContain("policy_belongs_to_another_account");
    expect(ca({ order: { ...order, accountId: "a2" } }).reasons).toContain("policy_belongs_to_another_account");
    expect(ca({ order: { ...order, strategy: "OTHER" } }).reasons).toContain("strategy_not_authorised");
    expect(ca({ order: { ...order, notional: "1e5" } }).reasons).toContain("amount_unparseable");
    expect(ca({ order: { ...order, quantity: "-1" } }).reasons).toContain("amount_unparseable");
  });
  it("a policy missing any limit, not authorised by its owner or naming no strategy is invalid", () => {
    expect(validateAutoPolicy(policy({ maxDailyLoss: "0" }), NOW)).toContain("policy_maxDailyLoss_invalid");
    expect(validateAutoPolicy(policy({ maxOrderQuantity: "" }), NOW)).toContain("policy_maxOrderQuantity_invalid");
    expect(validateAutoPolicy(policy({ maxOpenPositions: 0 }), NOW)).toContain("policy_maxOpenPositions_invalid");
    expect(validateAutoPolicy(policy({ maxOrdersPerDay: 1.5 }), NOW)).toContain("policy_maxOrdersPerDay_invalid");
    expect(validateAutoPolicy(policy({ authorisedBy: "admin" }), NOW)).toContain("policy_not_authorised_by_owner");
    expect(validateAutoPolicy(policy({ strategies: [] }), NOW)).toContain("policy_names_no_strategy");
    expect(ca({ policy: policy({ maxDailyLoss: "0" }) }).allowed).toBe(false);
  });
});

describe("broker report classification (M13-22): never assume a fill", () => {
  const rep = (status: never, fills: Array<[string, string]> = []) => ({ status, fills: fills.map(([quantity, price]) => ({ quantity, price })) });
  it("submission and acknowledgement are not fills", () => {
    expect(classifyBrokerReport("25", rep("SUBMITTED" as never))).toBe("NOT_FILLED");
    expect(classifyBrokerReport("25", rep("ACKNOWLEDGED" as never))).toBe("NOT_FILLED");
  });
  it("FILLED needs fills that add up to the order quantity; otherwise it is uncertain", () => {
    expect(classifyBrokerReport("25", rep("FILLED" as never, [["25", "100"]]))).toBe("FILLED");
    expect(classifyBrokerReport("25", rep("FILLED" as never, [["10", "100"], ["15", "100.05"]]))).toBe("FILLED");
    expect(classifyBrokerReport("25", rep("FILLED" as never))).toBe("UNCERTAIN");
    expect(classifyBrokerReport("25", rep("FILLED" as never, [["10", "100"]]))).toBe("UNCERTAIN");
  });
  it("partial fills, rejections and cancellations are classified exactly; contradictions are uncertain", () => {
    expect(classifyBrokerReport("25", rep("ACKNOWLEDGED" as never, [["10", "100"]]))).toBe("PARTIALLY_FILLED");
    expect(classifyBrokerReport("25", rep("REJECTED" as never))).toBe("REJECTED");
    expect(classifyBrokerReport("25", rep("REJECTED" as never, [["5", "100"]]))).toBe("UNCERTAIN");
    expect(classifyBrokerReport("25", rep("CANCELLED" as never))).toBe("CANCELLED");
    expect(classifyBrokerReport("25", rep("CANCELLED" as never, [["10", "100"]]))).toBe("PARTIALLY_FILLED");
    expect(classifyBrokerReport("25", rep("UNKNOWN" as never))).toBe("UNCERTAIN");
    expect(classifyBrokerReport("25", rep("FILLED" as never, [["30", "100"]]))).toBe("UNCERTAIN");
    expect(classifyBrokerReport("25", rep("FILLED" as never, [["25", "0"]]))).toBe("UNCERTAIN");
    expect(classifyBrokerReport("x", rep("FILLED" as never, [["25", "100"]]))).toBe("UNCERTAIN");
  });
});

describe("decimal parsing and the disabled adapter", () => {
  it("parses exact decimals only", () => { expect(toScaled("1.5")).toBe(150_000_000n); expect(toScaled("1.123456789")).toBeNull(); expect(toScaled("-1")).toBeNull(); expect(toScaled("")).toBeNull(); expect(toScaled(null)).toBeNull(); });
  it("the only broker adapter refuses to submit anything", async () => { await expect(DISABLED_BROKER_ADAPTER.submit()).rejects.toThrow(/disabled/); expect(DISABLED_BROKER_ADAPTER.kind).toBe("DISABLED"); });
});

describe("the live architecture is not wired into anything (modes stay disabled)", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return f === "node_modules" || f === "dist" ? [] : statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
  it("no application, worker or service code calls the live checks or the broker adapter", () => {
    const roots = ["apps", "services", "adapters", "packages"].map((r) => join(__dirname, "../../..", r));
    for (const root of roots) for (const f of walk(root)) {
      if (f.endsWith("liveArchitecture.ts")) continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(/checkAssistedLive|checkControlledAuto|DISABLED_BROKER_ADAPTER|classifyBrokerReport|validateAutoPolicy/);
    }
  });
  it("a failed risk recheck still refuses Controlled Auto even inside a valid policy", () => {
    expect(ca({ gate: gate({ riskRecheckPassed: false }) }).reasons).toContain("risk_recheck_failed");
  });
});
