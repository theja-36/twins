import { describe, expect, it } from "vitest";
import { analyzeMarketRegime, marketContextAgent, MARKET_CONTEXT_AGENT_ID, type MarketRegimeObject, type RegimeProvider, type TimedBar, type Timeframe } from "../../../packages/agents/src/index";
import { codesOf, evalAgents, inputs, NOW } from "../../support/agentFixtures";

const STEP: Record<Timeframe, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
function series(tf: Timeframe, drift: number): TimedBar[] {
  const out: TimedBar[] = []; let price = 24000;
  for (let i = 0; i < 60; i++) {
    const amp = 0.0005, open = price, close = price * (1 + drift / 100 + (i % 2 === 0 ? amp : -amp));
    out.push({ open, close, high: Math.max(open, close) * 1.0004, low: Math.min(open, close) * 0.9996, at: new Date(NOW.getTime() - 60_000 - (59 - i) * STEP[tf]) }); price = close;
  }
  return out;
}
const regime = (drift: number, over: Partial<Parameters<typeof analyzeMarketRegime>[0]> = {}): MarketRegimeObject =>
  analyzeMarketRegime({ underlying: "NIFTY", timeframes: (["5m", "15m", "1h"] as const).map((tf) => ({ timeframe: tf, bars: series(tf, drift) })), now: NOW, dataSource: "LIVE", ...over });
const provider = (r: MarketRegimeObject | null | "throw"): RegimeProvider => ({ name: "test-regime", async regimeFor() { if (r === "throw") throw new Error("boom SECRET"); return r; } });
const run = async (p: RegimeProvider | null, inp: Record<string, unknown> = inputs({ rd: { symbol: "NIFTY" } })) => (await evalAgents([marketContextAgent(p)], inp, {}, [], NOW)).byId(MARKET_CONTEXT_AGENT_ID);

describe("Market Context Agent", () => {
  it("a trend with the signal (BUY, live data) is SUPPORTIVE and traceable to the regime version", async () => {
    const r = await run(provider(regime(0.15)));
    expect(r).toMatchObject({ status: "COMPLETED", verdict: "SUPPORTIVE" });
    expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["risk_decision", "market_regime"]));
    expect(r.outputSnapshot).toMatchObject({ regime: "TRENDING_UP", regimeVersion: "market-regime-v1", dataSource: "LIVE" });
  });
  it("a fixture-backed regime can never be positive", async () => {
    expect((await run(provider(regime(0.15, { dataSource: "FIXTURE" })))).verdict).toBe("NEUTRAL");
  });
  it("a trend against the signal is ADVERSE, never blocking", async () => {
    const r = await run(provider(regime(-0.15)));
    expect(r.verdict).toBe("ADVERSE"); expect(codesOf(r)).toContain("REGIME_AGAINST");
  });
  it("elevated event risk and mixed indices add caution", async () => {
    const r = await run(provider(regime(0.15, { hoursToHighImpactEvent: 1, siblingDirections: { BANKNIFTY: "BEARISH" } })));
    expect(r.verdict).toBe("CAUTION"); expect(codesOf(r)).toEqual(expect.arrayContaining(["EVENT_RISK"]));
  });
  it("no provider, a throwing provider, no regime, a wrong underlying and a stale regime are UNAVAILABLE, with no error text leaked", async () => {
    for (const p of [null, provider("throw"), provider(null), provider({ ...regime(0.15), underlying: "BANKNIFTY" }), provider(regime(0.15, { now: NOW, timeframes: [] }))]) {
      const r = await run(p);
      expect(r.status).toBe("UNAVAILABLE"); expect(r.verdict).toBe("UNAVAILABLE"); expect(JSON.stringify(r)).not.toContain("SECRET");
    }
  });
  it("never blocks and never raises confidence on its own", () => {
    const a = marketContextAgent(null).contract;
    expect(a.canBlock).toBe(false);
  });
});
