"use client";
import { useState } from "react";
import { DATA_STATES, type DataState } from "@twins/api-contracts";
import { AvailabilityBadge, DecisionStatusBadge, FreshnessChip, MoneyValue, OrderStatusBadge, PnlValue, PositionStatusBadge, ProvenanceBadge } from "@/ui/badges";
import { Dialog } from "@/ui/dialog";
import { Banner, Button, Field, PageHead, Panel } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { useToast } from "@/ui/toast";

/** Development and CI only (TWINS_ENABLE_DESIGN_GALLERY=true). Synthetic values; every figure is labelled. Used for visual review and the accessibility tests. */
export function DesignGallery() {
  const [open, setOpen] = useState(false), { push } = useToast();
  const rows = [{ id: "1", name: "SAMPLESTEEL", qty: "700", entry: "612.45", res: "3810.00" }, { id: "2", name: "DEMOBANK", qty: "400", entry: "1481.20", res: "-2260.00" }, { id: "3", name: "ACME POWER", qty: "250", entry: "318.90", res: "0.00" }];
  return (
    <>
      <PageHead eyebrow="Design system" title="Components and states"><p>Synthetic, labelled values. Nothing here is data.</p></PageHead>
      <div style={{ display: "grid", gap: 22 }}>
        <Panel aria-labelledby="g-btn"><h2 id="g-btn" style={{ marginBottom: 10 }}>Buttons and fields</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}><Button variant="primary">Primary</Button><Button>Default</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Danger</Button><Button disabled>Disabled</Button></div>
          <div className="grid g2"><Field id="g-f1" label="Email" hint="Helper text is linked to the field." defaultValue="trader@example.test" /><Field id="g-f2" label="Reason" error="Please give at least 5 characters." defaultValue="no" /></div></Panel>
        <Panel aria-labelledby="g-bd"><h2 id="g-bd" style={{ marginBottom: 10 }}>Status vocabulary</h2>
          <dl className="kv">
            <dt>Decision</dt><dd><DecisionStatusBadge state="PENDING" /> <DecisionStatusBadge state="APPROVED" /> <DecisionStatusBadge state="EXPIRED" /> <DecisionStatusBadge state="SOMETHING_NEW" /></dd>
            <dt>Order</dt><dd><OrderStatusBadge status="ACCEPTED" /> <OrderStatusBadge status="PARTIALLY_FILLED" /> <OrderStatusBadge status="FILLED" /></dd>
            <dt>Position</dt><dd><PositionStatusBadge status="OPEN" /> <PositionStatusBadge status="CLOSED" /></dd>
            <dt>Provenance</dt><dd><ProvenanceBadge kind="FIXTURE" /> <ProvenanceBadge kind="PAPER" /> <ProvenanceBadge kind="LIVE" /> <ProvenanceBadge kind="UNAVAILABLE" /></dd>
            <dt>Availability</dt><dd><AvailabilityBadge kind="PLANNED" /> <AvailabilityBadge kind="UNAVAILABLE" /> <AvailabilityBadge kind="PARTIAL" /></dd>
            <dt>Freshness</dt><dd><FreshnessChip freshness="CURRENT" asOf="2031-01-06T05:00:00Z" /> <FreshnessChip freshness="STALE" /></dd>
            <dt>Result</dt><dd><PnlValue value="3810.00" /> &nbsp; <PnlValue value="-2260.00" /> &nbsp; <PnlValue value="0.00" /></dd>
            <dt>Money</dt><dd><MoneyValue value="1100920.00" /></dd>
          </dl>
          <p className="xs muted" style={{ margin: "10px 0 0" }}>LIVE is never rendered as LIVE: no live source is verified. Profit/loss colours are used only for results, never for status.</p></Panel>
        <Panel aria-labelledby="g-tb"><h2 id="g-tb" style={{ marginBottom: 10 }}>Table</h2>
          <DataTable caption="Synthetic positions" rows={rows} rowKey={(r) => r.id} selectedKey="1" columns={[{ key: "n", header: "Instrument", render: (r) => <b>{r.name}</b> }, { key: "q", header: "Qty", align: "right", render: (r) => <span className="num">{r.qty}</span> }, { key: "e", header: "Avg entry", align: "right", hideOnMobile: true, render: (r) => <span className="num">{r.entry}</span> }, { key: "r", header: "Realised", align: "right", render: (r) => <PnlValue value={r.res} /> }]} /></Panel>
        <section aria-labelledby="g-st"><h2 id="g-st" style={{ marginBottom: 10 }}>The eight data states</h2>
          <div className="grid g2">{DATA_STATES.map((s: DataState) => <Panel key={s} aria-label={`State ${s}`}><div className="up" style={{ marginBottom: 8 }}>{s}</div><DataRegion state={s} what="items" onRetry={() => undefined} unavailableReason="The backend does not provide this yet.">{<div className="small">Content shown when data is present.</div>}</DataRegion></Panel>)}</div></section>
        <Panel aria-labelledby="g-ot"><h2 id="g-ot" style={{ marginBottom: 10 }}>Dialog, toast, banner, planned</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}><Button onClick={() => setOpen(true)}>Open dialog</Button><Button onClick={() => push({ tone: "info", text: "Saved (synthetic message)." })}>Show toast</Button><Button onClick={() => push({ tone: "error", text: "Something failed (synthetic)." })}>Show error toast</Button></div>
          <div style={{ display: "grid", gap: 10 }}><Banner label="PAPER">Simulated fills at fixture prices. Not validated performance.</Banner><PlannedPanel title="A planned capability">States what is missing and who does it today.</PlannedPanel></div></Panel>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Example dialog" actions={<Button variant="primary" onClick={() => setOpen(false)}>Confirm</Button>}>Focus is trapped in the dialog, Escape closes it, and focus returns to the button that opened it.</Dialog>
    </>
  );
}
