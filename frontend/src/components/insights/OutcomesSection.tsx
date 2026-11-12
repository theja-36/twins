"use client";
import { useState } from "react";
import { useOutcomes } from "@/api/analyticsHooks";
import type { OutcomeRowData } from "@/api/analyticsTypes";
import { formatIst, formatDecimal, formatMoney } from "@/lib/format";
import { PnlValue, ProvenanceBadge } from "@/ui/badges";
import { DataTable } from "@/ui/table";
import { NOT_COMPUTED, Section, SectionFrame, upperWords } from "./shared";

const LIMITS = [25, 50, 100, 200] as const;
const codes = (v: unknown): string => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v.length ? v.slice(0, 8).join(", ") : "none") : "not provided");

/** Outcome history. The backend accepts `finality` and `limit`; it accepts a `cursor` but never uses it and returns no next cursor, so this screen shows the most recent `limit` rows and cannot page further. */
export function OutcomesSection() {
  const [finality, setFinality] = useState<"" | "FINAL" | "PARTIAL">(""), [limit, setLimit] = useState<(typeof LIMITS)[number]>(50);
  const q = useOutcomes({ ...(finality ? { finality } : {}), limit }), env = q.data, rows = env?.data ?? [];
  return (
    <>
      <form style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "0 0 12px" }} onSubmit={(e) => e.preventDefault()} aria-label="Outcome filters">
          <div className="field"><label htmlFor="of">Finality</label><select id="of" className="input" value={finality} onChange={(e) => setFinality(e.target.value as "" | "FINAL" | "PARTIAL")}><option value="">Final and partial</option><option value="FINAL">Final only</option><option value="PARTIAL">Partial only</option></select></div>
          <div className="field"><label htmlFor="ol">Rows to load</label><select id="ol" className="input" value={limit} onChange={(e) => setLimit(Number(e.target.value) as (typeof LIMITS)[number])}>{LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
        </form>
    <SectionFrame what="outcomes" q={q} env={env} emptyHint="No paper position has closed (or partly exited) yet, so there are no outcomes.">
      <Section id="oc-h" title="Outcome history">
        <p className="small muted">Showing up to {limit} outcome rows as the backend returns them. There is no next-page cursor: the backend ignores one, so older rows beyond this limit cannot be reached here. Values are the recorded paper results; nothing is recalculated.</p>
        <DataTable<OutcomeRowData> caption="Outcome history" rows={rows} rowKey={(r) => `${r.id}:${r.version}`} wide columns={[
          { key: "i", header: "Instrument", render: (r) => <><b>{r.instrument}</b> <span className="xs muted">{r.side}</span></> }, { key: "f", header: "Finality", render: (r) => <span className="badge b-neutral">{r.finality}</span> },
          { key: "d", header: "Data", render: (r) => <ProvenanceBadge kind={r.dataSource} /> }, { key: "o", header: "Origin", hideOnMobile: true, render: (r) => upperWords(r.candidateSource) }, { key: "s", header: "Setup", hideOnMobile: true, render: (r) => (r.setup ? upperWords(r.setup) : NOT_COMPUTED) },
          { key: "g", header: "Gross P&L", hideOnMobile: true, align: "right", render: (r) => (r.grossPnl === null ? NOT_COMPUTED : <PnlValue value={r.grossPnl} />) }, { key: "c", header: "Costs", hideOnMobile: true, align: "right", render: (r) => <span className="num">{r.costs === null ? NOT_COMPUTED : formatMoney(r.costs)}</span> },
          { key: "n", header: "Net P&L", align: "right", render: (r) => (r.netPnl === null ? NOT_COMPUTED : <PnlValue value={r.netPnl} />) }, { key: "r", header: "R multiple", hideOnMobile: true, align: "right", render: (r) => <span className="num">{r.rMultiple === null ? NOT_COMPUTED : formatDecimal(r.rMultiple)}</span> },
          { key: "h", header: "Held (s)", hideOnMobile: true, align: "right", render: (r) => <span className="num">{r.holdingSeconds === null ? NOT_COMPUTED : formatDecimal(r.holdingSeconds)}</span> }, { key: "e", header: "Exit", hideOnMobile: true, render: (r) => (r.exitReason ? upperWords(r.exitReason) : "—") },
          { key: "t", header: "Closed", hideOnMobile: true, render: (r) => formatIst(r.closedAt) }, { key: "q", wrap: true, header: "Data-quality codes", hideOnMobile: true, render: (r) => <span className="xs">{codes(r.dataQuality)}</span> },
          { key: "m", wrap: true, header: "Missing", hideOnMobile: true, render: (r) => <span className="xs">{codes(r.missing)}</span> }, { key: "v", wrap: true, header: "Version", hideOnMobile: true, render: (r) => <span className="xs">v{r.version}{r.correctionReason ? ` · ${r.correctionReason}` : ""}</span> },
        ]} />
      </Section>
    </SectionFrame>
    </>
  );
}
