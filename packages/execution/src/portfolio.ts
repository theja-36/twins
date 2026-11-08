import { paperPortfolioFacts, type Db } from "@twins/database";
import { abs, ceilTo2, dec, mul, str, ZERO, type PortfolioProvider } from "@twins/planning";

/**
 * The PAPER portfolio as a PortfolioProvider (resolves the paper half of G-22). Open risk of a position is its remaining quantity times the distance from its average entry to its CURRENT stop (a stop moved past entry
 * leaves no open risk), exposure is quantity times average entry, and the realised loss is the net result of paper positions closed since the start of the current IST day. It carries no equity curve (none exists), so drawdown is
 * reported as unevaluated rather than guessed. It describes paper trading only; it says nothing about any real account.
 */
export function paperPortfolioProvider(db: Pick<Db, "transaction">): PortfolioProvider {
  return {
    name: "paper-portfolio",
    async portfolioFor({ userId, accountId, now }) {
      const ist = new Date(now.getTime() + 330 * 60_000), dayStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
      const f = await paperPortfolioFacts(db, userId, accountId, dayStart);
      const net = dec(f.realizedNetSince);
      return {
        openPositions: f.open.map((p) => {
          const qty = dec(p.quantity), avg = dec(p.avgEntryPrice), stop = dec(p.stopLoss), exposed = p.side === "BUY" ? avg - stop : stop - avg;
          return { underlying: p.instrument, side: p.side, notional: str(ceilTo2(mul(avg, qty, "up"))), riskAmount: str(exposed > ZERO ? ceilTo2(mul(abs(exposed), qty, "up")) : ZERO) };
        }),
        realizedLossToday: str(net < ZERO ? ceilTo2(-net) : ZERO), equityCurve: null, asOf: now.toISOString(),
      };
    },
  };
}
