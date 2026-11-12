"use client";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DECISION_HISTORY_LIMIT, useDecisionHistory } from "@/api/strategyHooks";
import type { DecisionRowT } from "@/api/strategyTypes";
import { WORKFLOW_STATES } from "@/lib/workflowStates";
import { deriveState } from "@/state/dataState";
import { formatIst } from "@/lib/format";
import { DecisionStatusBadge } from "@/ui/badges";
import { Banner, Button, PageHead } from "@/ui/primitives";
import { DataRegion } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { LoadedAt, Section, label } from "@/components/desk/parts";

/**
 * Decision History: the latest decisions (the API returns at most 200, newest first, and has NO offset, so there is no paging here and older decisions cannot be reached).
 * The state filter is the API's own parameter; the text filter only narrows the loaded rows. OUTCOME (the engine's eligibility verdict) and WORKFLOW STATE are separate columns and neither is an approval by itself.
 */
export function DecisionsScreen() {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  const state = WORKFLOW_STATES.find((s) => s === params.get("state")), [text, setText] = useState("");
  const q = useDecisionHistory(state ? { state } : {});
  const all = useMemo(() => q.data?.decisions ?? [], [q.data]), needle = text.trim().toLowerCase();
  const rows = useMemo(() => (needle ? all.filter((d) => `${d.outcome} ${d.explanation.headline}`.toLowerCase().includes(needle)) : all), [all, needle]);
  const dataState = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: all.length === 0, privateRoute: true });
  const setState = (v: string): void => { const n = new URLSearchParams(params.toString()); if (v) n.set("state", v); else n.delete("state"); const s = n.toString(); router.replace(s ? `${path}?${s}` : path); };
  return (
    <>
      <PageHead eyebrow="Review" title="Decision history"><p>Your decisions and how each one stands. Read-only: nothing on this screen approves, rejects, cancels or places anything.</p></PageHead>
      <div className="grid">
        <Banner tone="info" label="PAPER">Live trading is disabled. Decisions here belong to paper trading; a QUALIFIED outcome is an eligibility verdict, not an approval.</Banner>
        <Section id="dh-h" title="Decisions" aside={<LoadedAt updatedAt={q.dataUpdatedAt} />}>
          <p className="small" style={{ margin: "0 0 12px" }}>Showing the latest decisions, up to {DECISION_HISTORY_LIMIT}, newest first. The API has no paging, so older decisions are not reachable from this screen.{all.length >= DECISION_HISTORY_LIMIT && <> <b>The limit of {DECISION_HISTORY_LIMIT} was reached, so older decisions exist that are not shown.</b></>}</p>
          <form style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "end", marginBottom: 14 }} onSubmit={(e) => e.preventDefault()} aria-label="Decision filters">
            <div className="field"><label htmlFor="d-state">Workflow state</label>
              <select id="d-state" className="input" value={state ?? ""} onChange={(e) => setState(e.target.value)}><option value="">Any state</option>{WORKFLOW_STATES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div>
            <div className="field"><label htmlFor="d-text">Find in loaded rows</label>
              <input id="d-text" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Outcome or headline" autoComplete="off" maxLength={40} /><div className="xs muted">Narrows the {all.length} loaded rows only; it does not search the backend.</div></div>
            {(state || text) && <Button onClick={() => { setText(""); router.replace(path); }}>Clear filters</Button>}
          </form>
          <DataRegion state={dataState} what="decisions" deniedNote="Decision history is private to a trading account and is not available to this sign-in." emptyHint={state ? "No decisions in this state. Clear the filter to see more." : "No decisions have been recorded for you yet."} onRetry={() => void q.refetch()}>
            {rows.length === 0 ? <p className="muted" role="status">No loaded row matches “{text}”. Clear the text filter.</p> : (
              <DataTable<DecisionRowT> wide caption="Decisions" rows={rows} rowKey={(d) => d.id} columns={[
                { key: "c", header: "Created", render: (d) => <><Link href={`/decisions/${d.id}`}><b>{formatIst(d.createdAt)}</b></Link><span className="only-phone" style={{ marginTop: 4 }}><DecisionStatusBadge state={d.workflowState} /> <span className="xs muted">{label(d.outcome)}</span></span></> },
                { key: "s", header: "Workflow state", render: (d) => <DecisionStatusBadge state={d.workflowState} /> },
                { key: "o", header: "Outcome", hideOnMobile: true, render: (d) => <span className="badge b-neutral" title="The engine's eligibility verdict. It is not an approval.">{label(d.outcome)}</span> },
                { key: "h", header: "Headline", wrap: true, hideOnMobile: true, render: (d) => d.explanation.headline },
                { key: "u", header: "Valid until", hideOnMobile: true, render: (d) => <span className="xs">{formatIst(d.validUntil)}</span> },
                { key: "i", header: "Invalidated", hideOnMobile: true, render: (d) => d.invalidated ? <span className="badge b-na" title={`Invalidated ${formatIst(d.invalidated.at)}`}>{label(d.invalidated.reasonCode)}</span> : <span className="muted">no</span> },
                { key: "k", header: "Candidate", hideOnMobile: true, render: (d) => <Link href={`/opportunities/${d.candidateId}`}>Open candidate</Link> },
              ]} />
            )}
          </DataRegion>
        </Section>
        <p className="small muted">Post-trade outcomes are not shown here: the link between a decision and its recorded outcome is not verified yet. Strategy performance lives in <Link href="/insights">Learning Insights</Link>.</p>
      </div>
    </>
  );
}
