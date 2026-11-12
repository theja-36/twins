"use client";
import Link from "next/link";
import type { PublicUser } from "@twins/api-contracts";
import { useAccounts, useApprovals, useCandidates, useDecisions, useOpenPositions, useScans } from "@/api/hooks";
import { deriveState } from "@/state/dataState";
import { formatIst } from "@/lib/format";
import { AvailabilityBadge, DecisionStatusBadge, PnlValue, PositionStatusBadge, ProvenanceBadge } from "@/ui/badges";
import { Banner, PageHead } from "@/ui/primitives";
import { DataRegion } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { DataSourceBadge, LoadedAt, Section, SOURCE_LABEL, instrumentLabel, label } from "./parts";

const NOT_AVAILABLE: ReadonlyArray<[string, string]> = [
  ["Portfolio equity and cash balance", "No live balance source is connected; capital facts are on the Portfolio screen when it arrives."],
  ["Unrealised profit and loss, mark prices", "The backend holds no market prices, so open positions show entry and stop only."],
  ["Account performance", "Recorded outcomes are fixture-backed today and live in Outcomes and Performance."],
  ["Notifications inbox", "There is no per-user notification route."],
];

/** The trader's desk: only verified reads, each region with its own state and load time. */
export function OverviewScreen({ user }: { user: PublicUser }) {
  const acc = useAccounts(), appr = useApprovals(), dec = useDecisions(8), pos = useOpenPositions(8), cands = useCandidates({ limit: 50, offset: 0 }), scans = useScans(3);
  const accounts = acc.data?.accounts ?? [], pending = appr.data?.pending ?? [], decisions = dec.data?.decisions ?? [], positions = pos.data?.positions ?? [], list = cands.data?.candidates ?? [], scanRows = scans.data?.scans ?? [];
  const name = new Map(list.map((c) => [c.id, instrumentLabel(c)] as const));
  const s = (q: { isLoading: boolean; error: unknown; data: unknown }, empty: boolean, priv = true) => deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty, privateRoute: priv });
  const fixture = scanRows.some((x) => x.dataSource === "FIXTURE");
  return (
    <>
      <PageHead eyebrow="Desk" title="Overview"><p>Your trading environment at a glance. Paper trading only: no order here reaches a broker.</p></PageHead>
      <div className="grid">
        <Banner tone="info" label="PAPER">Live trading is disabled. Everything shown is simulated paper trading or read-only intelligence.</Banner>
        {fixture && <Banner label="FIXTURE">The latest scans ran on synthetic fixture data, so candidates and outcomes derived from them are illustrative.</Banner>}
        <div className="grid g2">
          <Section id="acct-h" title="Account and session" aside={<LoadedAt updatedAt={acc.dataUpdatedAt} />}>
            <dl className="kv"><dt>Signed in as</dt><dd>{user.displayName ?? user.email}</dd><dt>Role</dt><dd>{user.role}</dd><dt>Mode</dt><dd><ProvenanceBadge kind="PAPER" /></dd><dt>Session</dt><dd>Active</dd></dl>
            <DataRegion state={s(acc, accounts.length === 0)} what="accounts" emptyHint="No trading account is set up for you yet. The operator creates it." onRetry={() => void acc.refetch()}>
              <DataTable caption="Your accounts" rows={accounts} rowKey={(a) => a.id} columns={[{ key: "n", header: "Account", render: (a) => <b>{a.name}</b> }, { key: "m", header: "Mode", render: (a) => <ProvenanceBadge kind={a.tradingMode.toLowerCase() === "paper" ? "PAPER" : a.tradingMode.toUpperCase()} /> }, { key: "a", header: "Active", render: (a) => (a.isActive ? "Yes" : "No") }]} />
            </DataRegion>
          </Section>
          <Section id="dec-h" title="Needs your decision" aside={<LoadedAt updatedAt={appr.dataUpdatedAt} />}>
            <DataRegion state={s(appr, pending.length === 0)} what="pending decisions" emptyHint="Nothing needs a decision right now." onRetry={() => void appr.refetch()}>
              <p style={{ margin: "0 0 8px" }}><b className="num" style={{ fontSize: 28 }}>{pending.length}</b> <span className="muted">pending {pending.length === 1 ? "decision" : "decisions"}</span></p>
              <p className="small muted" style={{ margin: 0 }}>{pending.filter((p) => p.action.available).length} can be acted on now (as the server reports). <Link href="/approvals">Open the Approval Center</Link></p>
            </DataRegion>
          </Section>
        </div>
        <Section id="opp-h" title="Opportunities" aside={<LoadedAt updatedAt={cands.dataUpdatedAt} />}>
          <DataRegion state={s(cands, list.length === 0, false)} what="candidates" emptyHint="No candidates have been found yet." onRetry={() => void cands.refetch()}>
            <dl className="kv"><dt>{SOURCE_LABEL["TELEGRAM"]}</dt><dd className="num">{list.filter((c) => c.source === "TELEGRAM").length}</dd><dt>{SOURCE_LABEL["INDEPENDENT"]}</dt><dd className="num">{list.filter((c) => c.source === "INDEPENDENT").length}</dd><dt>Ready for a decision</dt><dd className="num">{list.filter((c) => c.state === "READY_FOR_DECISION").length}</dd></dl>
            <p className="small muted">Counts are of the {list.length} most recent candidates; the API has no “today” filter, so this is not a daily total. <Link href="/opportunities">Browse opportunities</Link></p>
          </DataRegion>
        </Section>
        <Section id="rdec-h" title="Recent decisions" aside={<LoadedAt updatedAt={dec.dataUpdatedAt} />}>
          <DataRegion state={s(dec, decisions.length === 0)} what="decisions" emptyHint="No decisions yet." onRetry={() => void dec.refetch()}>
            <DataTable caption="Recent decisions" rows={decisions} rowKey={(d) => d.id} columns={[
              { key: "i", header: "Candidate", render: (d) => <Link href={`/opportunities/${d.candidateId}`}>{name.get(d.candidateId) ?? "open candidate"}</Link> },
              { key: "s", header: "Status", render: (d) => <DecisionStatusBadge state={d.workflowState} /> }, { key: "o", header: "Outcome", hideOnMobile: true, render: (d) => label(d.outcome) },
              { key: "c", header: "Created", hideOnMobile: true, render: (d) => formatIst(d.createdAt) },
            ]} />
          </DataRegion>
        </Section>
        <Section id="pos-h" title="Open paper positions" aside={<LoadedAt updatedAt={pos.dataUpdatedAt} />}>
          <DataRegion state={s(pos, positions.length === 0)} what="open positions" emptyHint="You have no open paper positions." onRetry={() => void pos.refetch()}>
            <DataTable caption="Open paper positions" rows={positions} rowKey={(p) => p.id} columns={[
              { key: "i", header: "Instrument", render: (p) => <b>{p.instrument}</b> }, { key: "sd", header: "Side", render: (p) => p.side }, { key: "st", header: "Status", render: (p) => <PositionStatusBadge status={p.status} /> },
              { key: "q", header: "Quantity", align: "right", render: (p) => <span className="num">{p.quantity}</span> }, { key: "e", header: "Avg entry", align: "right", hideOnMobile: true, render: (p) => <span className="num">{p.avgEntryPrice}</span> },
              { key: "sl", header: "Stop-loss", align: "right", hideOnMobile: true, render: (p) => <span className="num">{p.stopLoss}</span> }, { key: "r", header: "Realised", align: "right", hideOnMobile: true, render: (p) => <PnlValue value={p.realizedPnl} /> },
            ]} />
            <p className="small muted">Unrealised result is NOT AVAILABLE: the platform holds no market prices.</p>
          </DataRegion>
        </Section>
        <Section id="act-h" title="Recent activity" aside={<LoadedAt updatedAt={scans.dataUpdatedAt} />}>
          <DataRegion state={s(scans, scanRows.length === 0, false)} what="scan activity" emptyHint="No scan has run yet." onRetry={() => void scans.refetch()}>
            <DataTable caption="Latest opportunity scans" rows={scanRows} rowKey={(x) => x.id} columns={[{ key: "k", header: "Scan", render: (x) => label(x.kind) }, { key: "s", header: "Status", render: (x) => label(x.status) }, { key: "d", header: "Data", render: (x) => <DataSourceBadge dataSource={x.dataSource} /> }, { key: "c", header: "Candidates", align: "right", render: (x) => <span className="num">{x.candidates}</span> }, { key: "t", header: "Started", render: (x) => formatIst(x.startedAt) }]} />
          </DataRegion>
        </Section>
        <Section id="na-h" title="Not available">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>{NOT_AVAILABLE.map(([t, why]) => <li key={t}><AvailabilityBadge kind="UNAVAILABLE" /> <b>{t}</b><div className="small muted">{why}</div></li>)}</ul>
        </Section>
        <nav aria-label="Quick links" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}><Link href="/opportunities">Opportunities</Link><Link href="/market">Market intelligence</Link><Link href="/approvals">Approval Center</Link></nav>
      </div>
    </>
  );
}
