"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { PAPER_LIST_LIMIT, useOrderFills, usePaperOrders, usePaperPositions, usePositionEvents, useSelectedAccount } from "@/api/controlHooks";
import type { PaperOrderT, PaperPositionT } from "@/api/controlTypes";
import { deriveState } from "@/state/dataState";
import { formatDecimal, formatIst } from "@/lib/format";
import { AvailabilityBadge, OrderStatusBadge, PnlValue, PositionStatusBadge, ProvenanceBadge } from "@/ui/badges";
import { Banner, Button, PageHead } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { LoadedAt, Section, label } from "@/components/desk/parts";

const dash = <span className="muted">none</span>;
/** The honest scope statement for both lists: the API returns only the latest rows and cannot filter by account, so this is never a full account history. */
function LimitNote({ loaded, account, filtered, kind }: { loaded: number; account: string; filtered: number; kind: string }) {
  return (
    <p className="small" style={{ margin: "0 0 10px" }}>
      Showing the latest {kind} the API returned (up to {PAPER_LIST_LIMIT}); there is no paging and no total, so older {kind} are not reachable here. The API cannot filter by account, so {account} is narrowed in the browser: {filtered} of the {loaded} loaded rows belong to it.
      {loaded >= PAPER_LIST_LIMIT && <> <b>The limit of {PAPER_LIST_LIMIT} was reached, so older {kind} exist that are not shown.</b></>}
    </p>
  );
}

function FillsPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useOrderFills(id), fills = q.data?.fills ?? [], st = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: fills.length === 0, privateRoute: true });
  return (
    <Section id="fl-h" title="Fills" aside={<Button onClick={onClose}>Close</Button>}>
      <DataRegion state={st} what="fills" emptyHint="No fill is recorded for this item. An empty list can also mean the id is not yours." onRetry={() => void q.refetch()}>
        <DataTable wide caption="Fills" rows={fills} rowKey={(f) => f.id} columns={[
          { key: "t", header: "Filled", render: (f) => formatIst(f.filledAt) }, { key: "q", header: "Quantity", align: "right", render: (f) => <span className="num">{formatDecimal(f.quantity)}</span> },
          { key: "p", header: "Price", align: "right", render: (f) => <span className="num">{formatDecimal(f.price)}</span> }, { key: "c", header: "Costs", align: "right", render: (f) => <span className="num">{formatDecimal(f.costs)}</span> },
          { key: "s", header: "Price source", render: (f) => <ProvenanceBadge kind={f.priceSource} /> },
        ]} />
      </DataRegion>
    </Section>
  );
}
function EventsPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const q = usePositionEvents(id), events = q.data?.events ?? [], st = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: events.length === 0, privateRoute: true });
  return (
    <Section id="ev-h" title="Position events" aside={<Button onClick={onClose}>Close</Button>}>
      <p className="small muted">Events are shown in the order the API returned them, with the kind and time only. Their detail is not displayed, and a closing event can be listed before its explanatory event, so order is not a lifecycle.</p>
      <DataRegion state={st} what="position events" emptyHint="No event is recorded for this position. An empty list can also mean the id is not yours." onRetry={() => void q.refetch()}>
        <DataTable wide caption="Position events" rows={events} rowKey={(e) => `${e.at}${e.kind}`} columns={[{ key: "t", header: "When", render: (e) => formatIst(e.at) }, { key: "k", header: "Event", render: (e) => label(e.kind) }]} />
      </DataRegion>
    </Section>
  );
}

/** Paper Trading (read-only, PAPER): the simulated positions and orders the platform holds, fills and events on request. No control here places, exits, moves or cancels anything. */
export function PaperTradingScreen() {
  const sel = useSelectedAccount(), [posStatus, setPosStatus] = useState<"" | "OPEN" | "CLOSED">(""), [ordStatus, setOrdStatus] = useState(""), [open, setOpen] = useState<{ kind: "fills" | "events"; id: string } | null>(null);
  const pq = usePaperPositions(posStatus ? { status: posStatus } : {}), oq = usePaperOrders(ordStatus ? { status: ordStatus } : {});
  const allPos = useMemo(() => pq.data?.positions ?? [], [pq.data]), allOrd = useMemo(() => oq.data?.orders ?? [], [oq.data]);
  const pos = useMemo(() => (sel.accountId ? allPos.filter((p) => p.accountId === sel.accountId) : allPos), [allPos, sel.accountId]), ord = useMemo(() => (sel.accountId ? allOrd.filter((o) => o.accountId === sel.accountId) : allOrd), [allOrd, sel.accountId]);
  const acct = sel.account ? `“${sel.account.name}”` : "the selected account";
  const ps = deriveState({ loading: pq.isLoading, error: pq.error, hasData: !!pq.data, empty: pos.length === 0, privateRoute: true }), os = deriveState({ loading: oq.isLoading, error: oq.error, hasData: !!oq.data, empty: ord.length === 0, privateRoute: true });
  return (
    <>
      <PageHead eyebrow="Control" title="Paper trading"><p>Simulated positions and orders. Paper trading only: no order here reaches a broker, and nothing on this screen places, exits, moves or cancels anything.</p></PageHead>
      <div className="grid">
        <Banner tone="info" label="PAPER">Live trading is disabled. Fills are modelled against stored prices; the price source is shown on each fill and FIXTURE means synthetic data.</Banner>
        <Section id="pos-h" title="Positions" aside={<LoadedAt updatedAt={pq.dataUpdatedAt} />}>
          <div className="field" style={{ marginBottom: 12 }}><label htmlFor="p-status">Status</label>
            <select id="p-status" className="input" value={posStatus} onChange={(e) => setPosStatus(e.target.value as "" | "OPEN" | "CLOSED")}><option value="">Open and closed</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option></select></div>
          <LimitNote loaded={allPos.length} account={acct} filtered={pos.length} kind="positions" />
          <DataRegion state={ps} what="positions" deniedNote="Paper positions are private to a trading account." emptyHint={allPos.length > 0 ? "None of the loaded positions belongs to this account." : "No paper position has been recorded."} onRetry={() => void pq.refetch()}>
            <DataTable<PaperPositionT> wide caption="Positions" rows={pos} rowKey={(p) => p.id} columns={[
              { key: "i", header: "Instrument", render: (p) => <><b>{p.instrument}</b><span className="xs muted only-phone">{p.side} · {label(p.status)}</span></> },
              { key: "sd", header: "Side", render: (p) => p.side }, { key: "st", header: "Status", render: (p) => <PositionStatusBadge status={p.status} /> },
              { key: "q", header: "Quantity", align: "right", render: (p) => <span className="num">{formatDecimal(p.quantity)}</span> }, { key: "iq", header: "Initial quantity", align: "right", render: (p) => <span className="num">{formatDecimal(p.initialQuantity)}</span> },
              { key: "e", header: "Avg entry", align: "right", render: (p) => <span className="num">{formatDecimal(p.avgEntryPrice)}</span> }, { key: "sl", header: "Stop-loss", align: "right", render: (p) => <span className="num">{formatDecimal(p.stopLoss)}</span> },
              { key: "is", header: "Initial stop", align: "right", render: (p) => <span className="num">{formatDecimal(p.initialStop)}</span> }, { key: "tg", header: "Targets", render: (p) => (p.targets.length ? <span className="num">{p.targets.map((t) => formatDecimal(t)).join(" · ")}</span> : dash) },
              { key: "r", header: "Realised", align: "right", render: (p) => <PnlValue value={p.realizedPnl} /> }, { key: "rc", header: "Realised costs", align: "right", render: (p) => <span className="num">{formatDecimal(p.realizedCosts)}</span> },
              { key: "x", header: "Exit reason", render: (p) => (p.exitReason ? label(p.exitReason) : dash) }, { key: "o", header: "Opened", render: (p) => <span className="xs">{formatIst(p.openedAt)}</span> },
              { key: "c", header: "Closed", render: (p) => (p.closedAt ? <span className="xs">{formatIst(p.closedAt)}</span> : <span className="muted">not closed</span>) },
              { key: "d", header: "Decision", render: (p) => <Link href={`/decisions/${p.decisionId}`}>Open decision</Link> },
              { key: "ev", header: "Events", render: (p) => <Button onClick={() => setOpen({ kind: "events", id: p.id })} aria-label={`Show events for ${p.instrument}`}>Show events</Button> },
            ]} />
            <p className="small muted">Unrealised result is NOT AVAILABLE: the platform holds no market prices, so an open position has no mark.</p>
          </DataRegion>
        </Section>
        <Section id="ord-h" title="Orders" aside={<LoadedAt updatedAt={oq.dataUpdatedAt} />}>
          <div className="field" style={{ marginBottom: 12 }}><label htmlFor="o-status">Status</label>
            <select id="o-status" className="input" value={ordStatus} onChange={(e) => setOrdStatus(e.target.value)}><option value="">Any status</option>{["PROPOSED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "EXPIRED"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div>
          <LimitNote loaded={allOrd.length} account={acct} filtered={ord.length} kind="simulated orders" />
          <DataRegion state={os} what="simulated orders" deniedNote="Paper orders are private to a trading account." emptyHint={allOrd.length > 0 ? "None of the loaded orders belongs to this account." : "No simulated order has been recorded."} onRetry={() => void oq.refetch()}>
            <DataTable<PaperOrderT> wide caption="Simulated orders" rows={ord} rowKey={(o) => o.id} columns={[
              { key: "i", header: "Instrument", render: (o) => <><b>{o.instrument}</b><span className="xs muted only-phone">{label(o.purpose)} · {o.side} · {label(o.status)}</span></> },
              { key: "pu", header: "Purpose", render: (o) => label(o.purpose) }, { key: "sd", header: "Side", render: (o) => o.side }, { key: "ty", header: "Type", render: (o) => label(o.orderType) },
              { key: "st", header: "Status", render: (o) => <OrderStatusBadge status={o.status} /> }, { key: "q", header: "Quantity", align: "right", render: (o) => <span className="num">{formatDecimal(o.quantity)}</span> },
              { key: "fq", header: "Filled", align: "right", render: (o) => <span className="num">{formatDecimal(o.filledQuantity)}</span> }, { key: "ap", header: "Avg fill price", align: "right", render: (o) => (o.avgFillPrice === null ? <span className="muted">no fill yet</span> : <span className="num">{formatDecimal(o.avgFillPrice)}</span>) },
              { key: "lp", header: "Limit price", align: "right", render: (o) => (o.limitPrice === null ? <span className="muted">none (market)</span> : <span className="num">{formatDecimal(o.limitPrice)}</span>) },
              { key: "x", header: "Exit reason", render: (o) => (o.exitReason ? label(o.exitReason) : dash) }, { key: "sr", header: "State note", wrap: true, render: (o) => o.stateReason ?? dash },
              { key: "c", header: "Created", render: (o) => <span className="xs">{formatIst(o.createdAt)}</span> }, { key: "d", header: "Decision", render: (o) => <Link href={`/decisions/${o.decisionId}`}>Open decision</Link> },
              { key: "f", header: "Fills", render: (o) => <Button onClick={() => setOpen({ kind: "fills", id: o.id })} aria-label={`Show fills for ${o.instrument} ${o.purpose.toLowerCase()}`}>Show fills</Button> },
            ]} />
          </DataRegion>
        </Section>
        {open?.kind === "fills" && <FillsPanel id={open.id} onClose={() => setOpen(null)} />}
        {open?.kind === "events" && <EventsPanel id={open.id} onClose={() => setOpen(null)} />}
        <Section id="na-h" title="Not available here">
          <PlannedPanel title="Execution, exits and stop changes" kind="UNAVAILABLE">There is no browser route to request a paper execution, exit a position or move a stop; the platform manages positions by its own rules. Nothing here can do it.</PlannedPanel>
          <p className="small muted" style={{ marginTop: 10 }}><AvailabilityBadge kind="UNAVAILABLE" /> Entry orders carry no position id, so orders and positions are listed separately and linked only through their decision.</p>
        </Section>
        <p className="small muted">Account totals are on <Link href="/portfolio">Portfolio</Link>. Recorded outcomes are on <Link href="/performance">Outcomes &amp; Performance</Link>.</p>
      </div>
    </>
  );
}
