"use client";
import Link from "next/link";
import { useState } from "react";
import { useDecisionComparables, useDecisionDetail } from "@/api/strategyHooks";
import type { DecisionDetail as DecisionDetailT } from "@/api/strategyTypes";
import { ApiError, deriveState } from "@/state/dataState";
import { formatDecimal, formatIst, formatMoney } from "@/lib/format";
import { AvailabilityBadge, DecisionStatusBadge, ProvenanceBadge } from "@/ui/badges";
import { Banner, Button, PageHead } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { LoadedAt, Section, label } from "@/components/desk/parts";

type Decision = DecisionDetailT["decision"];
const dash = "not provided";
/** A research link is offered ONLY when the decision itself records both a research package and the same candidate in its verified provenance. Nothing is inferred or constructed. */
const linkedResearch = (d: Decision): boolean => d.explanation.provenance.researchPackageId !== null && d.explanation.provenance.candidateId === d.candidateId;
function TextList({ items, none }: { items: readonly string[]; none: string }) { return items.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{items.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>{none}</p>; }

function Comparables({ id }: { id: string }) {
  const [asked, setAsked] = useState(false), q = useDecisionComparables(id, asked), c = q.data?.comparables;
  const st = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: c?.state === "AVAILABLE" && c.patterns.length === 0, privateRoute: true });
  return (
    <Section id="cmp-h" title="Comparables" aside={asked ? <LoadedAt updatedAt={q.dataUpdatedAt} /> : undefined}>
      {!asked ? (<><p className="small muted">Comparable past patterns are optional and are only read when you ask. They are research context, not a prediction and not an approval.</p><Button onClick={() => setAsked(true)}>Load comparables</Button></>) : (
        <DataRegion state={st} what="comparables" emptyHint="The backend answered, but it lists no comparable patterns for this decision." onRetry={() => void q.refetch()}>
          {c?.state === "NOT_AVAILABLE" && <PlannedPanel title="Comparables" kind="UNAVAILABLE">{label(c.reason)}: {c.detail}</PlannedPanel>}
          {c?.state === "AVAILABLE" && (<><dl className="kv"><dt>Verdict</dt><dd>{label(c.verdict)}</dd><dt>Version</dt><dd>{c.version}</dd><dt>Summary</dt><dd>{c.summary}</dd><dt>Note</dt><dd>{c.note}</dd></dl><h3 className="small">Pattern references</h3><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.patterns.map((p, i) => <li key={i}><code>{p}</code></li>)}</ul></>)}
        </DataRegion>
      )}
    </Section>
  );
}

function Body({ d, ev, approval, updatedAt }: { d: Decision; ev: DecisionDetailT["events"]; approval: DecisionDetailT["approval"]; updatedAt: number }) {
  const x = d.explanation, p = x.provenance, s = d.stopLossValidation, z = d.permittedSize;
  return (
    <>
      {p.dataSource === "FIXTURE" && <Banner label="FIXTURE">This decision was produced from synthetic fixture data, not a market.</Banner>}
      {d.invalidated && <Banner label="INVALIDATED">This decision was invalidated ({label(d.invalidated.reasonCode)}) on {formatIst(d.invalidated.at)}.</Banner>}
      <Section id="ds-h" title="Summary" aside={<LoadedAt updatedAt={updatedAt} />}>
        <p style={{ margin: "0 0 10px" }}><b>{x.headline}</b></p>
        <dl className="kv stack"><dt>Workflow state</dt><dd><DecisionStatusBadge state={d.workflowState} /></dd><dt>Outcome (eligibility verdict)</dt><dd><span className="badge b-neutral">{label(d.outcome)}</span> <span className="xs muted">not an approval</span></dd>
          <dt>Valid from</dt><dd>{formatIst(d.validFrom)}</dd><dt>Valid until</dt><dd>{formatIst(d.validUntil)}</dd><dt>Created</dt><dd>{formatIst(d.createdAt)}</dd><dt>Supersedes</dt><dd>{d.supersedesId ? <Link href={`/decisions/${d.supersedesId}`}>An earlier decision</Link> : <span className="muted">none</span>}</dd>
          <dt>Approval record</dt><dd>{approval ? `${label(approval.action)} at ${formatIst(approval.at)}` : <span className="muted">none recorded</span>}</dd></dl>
      </Section>
      <Section id="ex-h" title="Why this outcome">
        <div className="grid g2">
          <div><h3 className="small">Supporting</h3><TextList items={x.supporting} none="None recorded." /></div>
          <div><h3 className="small">Contradictory</h3><TextList items={x.contradictory} none="None recorded." /></div>
          <div><h3 className="small">Missing evidence</h3><TextList items={x.missing} none="None recorded." /></div>
          <div><h3 className="small">Risk restrictions</h3><TextList items={x.riskRestrictions} none="None recorded." /></div>
        </div>
        <dl className="kv stack" style={{ marginTop: 12 }}><dt>Size restriction</dt><dd>{x.sizeRestriction ?? <span className="muted">none stated</span>}</dd><dt>Expiry</dt><dd>{x.expiry}</dd></dl>
        <h3 className="small" style={{ margin: "16px 0 4px" }}>What would change it</h3><TextList items={x.whatWouldChange} none="None recorded." />
        <h3 className="small" style={{ margin: "16px 0 4px" }}>Reassess when</h3><TextList items={x.reassess} none="None recorded." />
        <h3 className="small" style={{ margin: "16px 0 4px" }}>Invalidated by</h3><TextList items={x.invalidatedBy} none="None recorded." />
        {x.reasons.length > 0 && <h3 className="small" style={{ margin: "16px 0 6px" }}>Reasons</h3>}
        {x.reasons.length > 0 && <DataTable wide caption="Reasons" rows={x.reasons} rowKey={(r) => `${r.code}${r.detail}`} columns={[{ key: "c", header: "Code", render: (r) => <code>{r.code}</code> }, { key: "k", header: "Category", render: (r) => label(r.category) }, { key: "d", header: "Detail", wrap: true, render: (r) => r.detail }]} />}
        {x.restrictions.length > 0 && <h3 className="small" style={{ margin: "16px 0 6px" }}>Restrictions</h3>}
        {x.restrictions.length > 0 && <DataTable wide caption="Restrictions" rows={x.restrictions} rowKey={(r) => `${r.code}${r.detail}`} columns={[{ key: "c", header: "Code", render: (r) => <code>{r.code}</code> }, { key: "k", header: "Category", render: (r) => label(r.category) }, { key: "d", header: "Detail", wrap: true, render: (r) => r.detail }]} />}
      </Section>
      <div className="grid g2">
        <Section id="sl-h" title="Stop-loss validation">
          {s ? <dl className="kv stack"><dt>Result</dt><dd>{label(s.result)}</dd><dt>Reason code</dt><dd>{s.reasonCode ? <code>{s.reasonCode}</code> : <span className="muted">none</span>}</dd><dt>Detail</dt><dd>{s.detail ?? <span className="muted">none</span>}</dd><dt>Rule version</dt><dd>{s.ruleVersion}</dd></dl> : <PlannedPanel title="Stop-loss validation" kind="UNAVAILABLE">No stop-loss validation is recorded for this decision.</PlannedPanel>}
        </Section>
        <Section id="ps-h" title="Permitted size (as recorded)">
          {z ? <><dl className="kv stack"><dt>Lots</dt><dd className="num">{formatDecimal(z.lots)}</dd><dt>Quantity</dt><dd className="num">{formatDecimal(z.quantity)}</dd><dt>Maximum loss at stop</dt><dd className="num">{formatMoney(z.maxLossAtStop)}</dd><dt>Risk per lot</dt><dd className="num">{formatMoney(z.riskPerLot)}</dd><dt>Gross exposure</dt><dd className="num">{formatMoney(z.grossExposure)}</dd><dt>Size multiplier</dt><dd className="num">{formatDecimal(z.sizeMultiplier)}</dd><dt>Binding constraint</dt><dd>{label(z.binding)}</dd></dl><p className="xs muted">Values are shown exactly as the backend recorded them. This screen calculates and changes no size.</p></> : <PlannedPanel title="Permitted size" kind="UNAVAILABLE">No permitted size is recorded for this decision. None is inferred.</PlannedPanel>}
        </Section>
      </div>
      <Section id="tl-h" title="Timeline">
        {ev.length === 0 ? <p className="muted" role="status">No state changes are recorded.</p> : <DataTable wide caption="Decision timeline" rows={ev} rowKey={(e) => `${e.at}${e.toState}`} columns={[{ key: "a", header: "When", render: (e) => formatIst(e.at) }, { key: "f", header: "From", render: (e) => (e.fromState ? label(e.fromState) : "—") }, { key: "t", header: "To", render: (e) => label(e.toState) }, { key: "w", header: "By", render: (e) => e.actor }, { key: "r", header: "Reason", wrap: true, render: (e) => e.reason ?? "—" }]} />}
      </Section>
      <Comparables id={d.id} />
      <Section id="pv-h" title="Provenance">
        <dl className="kv stack"><dt>Candidate source</dt><dd>{label(p.candidateSource)}</dd><dt>Data source</dt><dd><ProvenanceBadge kind={p.dataSource} /></dd><dt>Research package used</dt><dd>{p.researchPackageId ? <code>{p.researchPackageId}</code> : <span className="muted">none linked</span>}</dd>
          <dt>Risk assessment</dt><dd>{d.riskAssessmentId ? <code>{d.riskAssessmentId}</code> : <span className="muted">none</span>}</dd><dt>Simulation</dt><dd>{d.simulationId ? <code>{d.simulationId}</code> : <span className="muted">none</span>}</dd>
          <dt>Component versions</dt><dd>{Object.keys(d.versions).length ? Object.entries(d.versions).map(([k, v]) => `${k} ${v}`).join(" · ") : dash}</dd><dt>Evidence references</dt><dd>{d.evidenceRefs.length ? d.evidenceRefs.join(", ") : <span className="muted">none</span>}</dd></dl>
      </Section>
      <Section id="pt-h" title="Post-trade outcome"><PlannedPanel title="No outcome shown" kind="UNAVAILABLE">The link between a decision and its recorded outcome is not verified, so no outcome is shown for this decision.</PlannedPanel></Section>
    </>
  );
}

/** One decision, read-only: the engine's explanation as stored, with outcome and workflow state kept apart. Nothing here approves, rejects, cancels, watches or places anything. */
export function DecisionDetail({ id }: { id: string }) {
  const q = useDecisionDetail(id), d = q.data?.decision, notFound = q.error instanceof ApiError && q.error.status === 404;
  const st = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: false, privateRoute: true });
  return (
    <>
      <PageHead eyebrow="Review" title="Decision detail">
        <p style={{ display: "flex", gap: 14, flexWrap: "wrap" }}><Link href="/decisions">← Decision history</Link>{d && <Link href={`/opportunities/${d.candidateId}`}>Candidate detail</Link>}{d && linkedResearch(d) && <Link href={`/research/${d.candidateId}`} title="Opens the research for this candidate. It shows the candidate's latest package, which may be newer than the one this decision used.">Research workspace</Link>}</p>
      </PageHead>
      <div className="grid">
        <Banner tone="info" label="PAPER · read-only">Live trading is disabled. This is a record of a paper decision. A QUALIFIED outcome is an eligibility verdict, not an approval, and nothing on this screen can approve, reject, cancel or place anything.</Banner>
        {notFound && <p className="muted" role="status">This decision does not exist, or it is not yours.</p>}
        <DataRegion state={st} what="the decision" deniedNote="This decision is not available to you." onRetry={() => void q.refetch()}>
          {d && q.data ? <Body d={d} ev={q.data.events} approval={q.data.approval} updatedAt={q.dataUpdatedAt} /> : null}
        </DataRegion>
        <p className="small muted"><AvailabilityBadge kind="UNAVAILABLE" /> Approve, reject and cancel are not part of this module.</p>
      </div>
    </>
  );
}
