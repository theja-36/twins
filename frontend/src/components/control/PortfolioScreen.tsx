"use client";
import Link from "next/link";
import { usePortfolio, useSelectedAccount } from "@/api/controlHooks";
import { deriveState } from "@/state/dataState";
import { formatDecimal, formatMoney } from "@/lib/format";
import { AvailabilityBadge, PnlValue, ProvenanceBadge } from "@/ui/badges";
import { Banner, PageHead } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import { LoadedAt, Section } from "@/components/desk/parts";

const NA_CAPITAL = "The backend returned no value: no capital profile is in force for this account right now. Nothing is estimated.";
function Maybe({ v, money = true }: { v: string | null; money?: boolean }) { return v === null ? <span><AvailabilityBadge kind="UNAVAILABLE" /> <span className="small muted">not provided</span></span> : <span className="num">{money ? formatMoney(v) : formatDecimal(v)}</span>; }

/**
 * Portfolio (read-only, PAPER): the account facts exactly as the backend reports them. Money stays the decimal string that was sent; an absent capital figure is "not provided", never zero. The backend holds no market prices, so there is no unrealised result,
 * no mark price and no live balance, and the screen says so instead of showing a blank.
 */
export function PortfolioScreen() {
  const sel = useSelectedAccount(), q = usePortfolio(sel.accountId), f = q.data?.facts ?? null;
  const accountsState = deriveState({ loading: sel.query.isLoading, error: sel.query.error, hasData: !!sel.query.data, empty: sel.accounts.length === 0, privateRoute: true });
  const state = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: false, privateRoute: true });
  return (
    <>
      <PageHead eyebrow="Control" title="Portfolio"><p>Allocated paper notional, open positions and realised result for the selected account. Read-only: nothing here places, changes or closes anything.</p></PageHead>
      <div className="grid">
        <Banner tone="info" label="PAPER">Live trading is disabled. These figures describe simulated paper trading; they are not a broker balance. <ProvenanceBadge kind="PAPER" /></Banner>
        <DataRegion state={accountsState} what="accounts" deniedNote="Portfolio data is private to a trading account." emptyHint="No trading account is set up for you yet. The operator creates it." onRetry={() => void sel.query.refetch()}>
          {sel.account && (
            <Section id="pf-h" title={`Account facts: ${sel.account.name}`} aside={<LoadedAt updatedAt={q.dataUpdatedAt} />}>
              <DataRegion state={state} what="portfolio facts" deniedNote="This account is not available to you." onRetry={() => void q.refetch()}>
                {f ? (
                  <>
                    <dl className="kv stack">
                      <dt>Open positions</dt><dd className="num">{f.openPositions}</dd>
                      <dt>Allocated notional (at entry price)</dt><dd><Maybe v={f.allocatedNotional} /></dd>
                      <dt>Realised result</dt><dd><PnlValue value={f.realizedPnl} /></dd>
                      <dt>Total capital</dt><dd><Maybe v={f.totalCapital} /></dd>
                      <dt>Available capital</dt><dd><Maybe v={f.availableCapital} /></dd>
                      <dt>Unallocated capital</dt><dd><Maybe v={f.unallocatedCapital} /></dd>
                      <dt>Capital profile version</dt><dd>{f.capitalProfileVersion === null ? <span className="muted">not provided</span> : <span className="num">{f.capitalProfileVersion}</span>}</dd>
                    </dl>
                    {(f.totalCapital === null || f.availableCapital === null || f.unallocatedCapital === null) && <p className="small muted">{NA_CAPITAL}</p>}
                    {(q.data?.notes ?? []).map((n, i) => <p key={i} className="small muted">{n}</p>)}
                  </>
                ) : <PlannedPanel title="Portfolio facts" kind="UNAVAILABLE">The backend returned no facts for this account. None are inferred.</PlannedPanel>}
              </DataRegion>
            </Section>
          )}
        </DataRegion>
        <Section id="na-h" title="Not available">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {[["Unrealised result", "The platform holds no market prices, so an open position has no mark and no unrealised result."], ["Mark price", "No live or delayed quote source is connected to the portfolio."], ["Live balance", "No broker account is connected. Capital shown above comes from the stored capital profile, not from a broker."]].map(([t, why]) => <li key={t}><AvailabilityBadge kind="UNAVAILABLE" /> <b>{t}</b><div className="small muted">{why}</div></li>)}
          </ul>
        </Section>
        <p className="small muted">Positions and orders are on <Link href="/paper">Paper Trading</Link>. Performance records are on <Link href="/performance">Outcomes &amp; Performance</Link>.</p>
      </div>
    </>
  );
}
