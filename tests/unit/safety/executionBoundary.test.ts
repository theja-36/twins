import { afterEach, describe, expect, it, vi } from "vitest";
import { executionProviders, guardExecutionProvider } from "../../../adapters/broker/src/index";
import { assertOrderIntentAllowed, configureRuntimeState, inMemoryStateSource, SafetyRefusalError, type InMemoryStateSource } from "../../../packages/runtime-state/src/index";
import { LiveGuardError } from "../../../packages/config/src/liveGuard";
import type { ExecutionProvider } from "../../../packages/types/src/index";

const request = { instrument: { symbol: "RELIANCE", exchange: "NSE" }, side: "buy" as const, orderType: "market", quantity: 1, idempotencyKey: "k" };

function provider() {
  const calls = { place: 0, cancel: 0, status: 0, health: 0 };
  const p: ExecutionProvider = {
    providerName: "boundary-fixture",
    async placeOrder() { calls.place += 1; return { brokerOrderId: "b1", status: "submitted" }; },
    async cancelOrder() { calls.cancel += 1; },
    async getOrderStatus(id) { calls.status += 1; return { brokerOrderId: id, status: "filled", filledQuantity: 1 }; },
    async getHealth() { calls.health += 1; return { providerName: "boundary-fixture", providerType: "broker", status: "healthy", checkedAt: new Date() }; },
  };
  return { p, calls };
}
function state(initial = {}): InMemoryStateSource {
  const s = inMemoryStateSource(initial);
  configureRuntimeState({ source: s, ttlMs: 0, failureTtlMs: 0 });
  return s;
}
afterEach(() => {
  vi.unstubAllEnvs();
  configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 });
});

describe("order-intent / broker-call boundary (no broker code exists; this is the gate every future adapter passes through)", () => {
  it("allows placeOrder only with trading enabled and the kill switch inactive", async () => {
    state({ TRADING_ENABLED: true });
    const { p, calls } = provider();
    const guarded = guardExecutionProvider(p);
    expect((await guarded.placeOrder(request)).status).toBe("submitted");
    expect(calls.place).toBe(1);
  });

  it.each([
    ["trading disabled (the seeded default)", {}, "trading_disabled"],
    ["kill switch active (even with trading enabled)", { TRADING_ENABLED: true, KILL_SWITCH_ACTIVE: true }, "kill_switch_active"],
  ])("refuses placeOrder: %s - the broker is never contacted", async (_name, initial, reason) => {
    state(initial);
    const { p, calls } = provider();
    await expect(guardExecutionProvider(p).placeOrder(request)).rejects.toMatchObject({ name: "SafetyRefusalError", reason });
    expect(calls.place).toBe(0);
  });

  it("refuses placeOrder when the state is unreadable (fail closed), a missing row included", async () => {
    const s = state({ TRADING_ENABLED: true });
    const { p, calls } = provider();
    s.failWith(new Error("db down"));
    await expect(guardExecutionProvider(p).placeOrder(request)).rejects.toMatchObject({ reason: "state_unavailable" });
    s.failWith(null);
    s.remove("KILL_SWITCH_ACTIVE");
    await expect(guardExecutionProvider(p).placeOrder(request)).rejects.toBeInstanceOf(SafetyRefusalError);
    expect(calls.place).toBe(0);
  });

  it("also enforces the shared live-trading guard first: a live configuration is refused even if the database says trading is on", async () => {
    state({ TRADING_ENABLED: true });
    vi.stubEnv("LIVE_TRADING", "true");
    const { p, calls } = provider();
    await expect(guardExecutionProvider(p).placeOrder(request)).rejects.toBeInstanceOf(LiveGuardError);
    await expect(assertOrderIntentAllowed("x")).rejects.toBeInstanceOf(LiveGuardError);
    expect(calls.place).toBe(0);
  });

  it("does not gate risk-reducing or read-only calls: cancel, status and health keep working during a kill switch", async () => {
    state({ TRADING_ENABLED: true, KILL_SWITCH_ACTIVE: true });
    const { p, calls } = provider();
    const guarded = guardExecutionProvider(p);
    await guarded.cancelOrder("b1");
    await guarded.getOrderStatus("b1");
    await guarded.getHealth();
    expect(calls).toMatchObject({ cancel: 1, status: 1, health: 1 });
    expect(guarded.providerName).toBe("boundary-fixture");
  });

  it("the execution registry wraps every provider on register, so no un-gated placeOrder can be obtained through it", async () => {
    state({});
    const { p, calls } = provider();
    executionProviders.register(p.providerName, p);
    try {
      await expect(executionProviders.get(p.providerName).placeOrder(request)).rejects.toMatchObject({ reason: "trading_disabled" });
      expect(calls.place).toBe(0);
    } finally {
      executionProviders.unregister(p.providerName);
    }
  });
});
