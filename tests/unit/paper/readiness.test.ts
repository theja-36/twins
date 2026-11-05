import { describe, expect, it } from "vitest";
import { evaluateReadiness, type ReadinessInput } from "../../../packages/paper/src/index";
import { marketOpenIst } from "../../../apps/api/src/liveApi";

const ok: ReadinessInput = { killSwitchActive: false, intakeEnabled: true, liveGuardPasses: true, tradingModePaper: true, paperTablesReadable: true, switchReadable: true, switchOn: false, armedByHost: false, adminConfigured: true, snapshotComplete: true, snapshotAgeSec: 120, priceAgeSec: 30, maxPriceAgeSec: 120, marketOpen: true, approvedDecisions: 2 };
const idsFailing = (r: ReturnType<typeof evaluateReadiness>) => r.items.filter((x) => x.status === "fail").map((x) => x.id);

describe("paper enable checklist", () => {
  it("is ready when nothing blocks it, and is NOT enabled (enabling is the owner's two separate actions)", () => {
    const r = evaluateReadiness(ok);
    expect(r).toMatchObject({ readyToEnable: true, enabledNow: false, blockers: [] });
    expect(r.items.find((x) => x.id === "armed")!.status).toBe("info"); expect(r.items.find((x) => x.id === "switch")!.status).toBe("info");
  });
  it("each blocking condition blocks on its own", () => {
    const cases: Array<[Partial<ReadinessInput>, string]> = [[{ killSwitchActive: true }, "kill_switch"], [{ killSwitchActive: undefined }, "kill_switch"], [{ liveGuardPasses: false }, "live_guard"], [{ tradingModePaper: false }, "live_guard"], [{ paperTablesReadable: false }, "db"], [{ switchReadable: false }, "db"], [{ adminConfigured: false }, "admin"], [{ snapshotComplete: false }, "snapshot"], [{ snapshotComplete: null }, "snapshot"], [{ priceAgeSec: 500 }, "price"], [{ priceAgeSec: null }, "price"]];
    for (const [patch, id] of cases) { const r = evaluateReadiness({ ...ok, ...patch }); expect(r.readyToEnable, JSON.stringify(patch)).toBe(false); expect(r.blockers, JSON.stringify(patch)).toContain(id); }
  });
  it("price freshness is only required while the market is open", () => {
    expect(evaluateReadiness({ ...ok, marketOpen: false, priceAgeSec: 99999 })).toMatchObject({ readyToEnable: true });
    expect(idsFailing(evaluateReadiness({ ...ok, marketOpen: true, priceAgeSec: 99999 }))).toEqual(["price"]);
  });
  it("non-blocking items never block, and enabledNow needs BOTH keys", () => {
    expect(evaluateReadiness({ ...ok, intakeEnabled: false, approvedDecisions: 0 }).readyToEnable).toBe(true);
    expect(evaluateReadiness({ ...ok, armedByHost: true }).enabledNow).toBe(false); expect(evaluateReadiness({ ...ok, switchOn: true }).enabledNow).toBe(false); expect(evaluateReadiness({ ...ok, armedByHost: true, switchOn: true }).enabledNow).toBe(true);
  });
  it("an unreadable kill switch is never treated as clear", () => {
    expect(evaluateReadiness({ ...ok, killSwitchActive: undefined }).items.find((x) => x.id === "kill_switch")!.detail).toMatch(/NOT clear/);
  });
  it("knows IST market hours", () => {
    expect(marketOpenIst(new Date("2026-11-05T05:00:00Z"))).toBe(true); // 10:30 IST Thursday
    expect(marketOpenIst(new Date("2026-11-05T03:30:00Z"))).toBe(false); // 09:00 IST
    expect(marketOpenIst(new Date("2026-11-05T10:00:00Z"))).toBe(false); // 15:30 IST: closed at the bell
    expect(marketOpenIst(new Date("2026-11-07T05:00:00Z"))).toBe(false); // Saturday
  });
});
