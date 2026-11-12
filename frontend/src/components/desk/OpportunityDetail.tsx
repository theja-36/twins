"use client";
import Link from "next/link";
import type { Role } from "@twins/api-contracts";
import { useCandidate, useDecisions, useResearchPackage } from "@/api/hooks";
import { deriveState } from "@/state/dataState";
import { formatIst } from "@/lib/format";
import { DecisionStatusBadge } from "@/ui/badges";
import { Banner, PageHead } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { CandidateStateBadge, DataSourceBadge, EvidenceList, LoadedAt, Section, SourceBadge, entryText, instrumentLabel, kindOf, label, num, targetsText } from "./parts";

const LIQUIDITY = /liquid|chain|option|open_interest|spread|volume/i;

/** Opportunity Detail: one candidate, evidence-first. Read-only: no order, approval or size control exists here. */
export function OpportunityDetail({ id, role }: { id: string; role: Role }) {
  const q = useCandidate(id), d = q.data;
  const state = deriveState({ loading: q.isLoading, error: q.error, hasData: !!d, empty: false });
  return (
    <>
      <PageHead eyebrow="Decide" title={d ? instrumentLabel(d.candidate) : "Opportunity"}>
        <p><Link href="/opportunities">← All opportunities</Link></p>
      </PageHead>
      <DataRegion state={state} what="this opportunity" deniedNote="This opportunity is not available to you." onRetry={() => void q.refetch()}>
        {d && <Body d={d} role={role} updatedAt={q.dataUpdatedAt} />}
      </DataRegion>
      {state === "ERROR" && q.error && (q.error as { status?: number }).status === 404 ? <p className="small muted">No opportunity with this id exists, or you cannot see it.</p> : null}
    </>
  );
}

function Body({ d, role, updatedAt }: { d: NonNullable<ReturnType<typeof useCandidate>["data"]>; role: Role; updatedAt: number }) {
  const c = d.candidate, pkg = useResearchPackage(c.id), liquidity = d.evidence.filter((e) => LIQUIDITY.test(kindOf(e))), other = d.evidence.filter((e) => !LIQUIDITY.test(kindOf(e)));
  return (
    <div className="grid">
      <Banner tone="info" label="Proposal only">A candidate is a proposal for research. This screen creates no order, approval or size, and shows no figure the backend did not record.</Banner>
      {c.dataSource === "FIXTURE" && <Banner label="FIXTURE">This candidate was built on synthetic fixture data, not a market. Treat every price here as illustrative.</Banner>}
      <Section id="ov-h" title="Candidate overview" aside={<LoadedAt updatedAt={updatedAt} />}>
        <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 12px" }}><SourceBadge source={c.source} /><CandidateStateBadge state={c.state} /><DataSourceBadge dataSource={c.dataSource} /></p>
        <dl className="kv">
          <dt>Candidate id</dt><dd className="mono">{c.id}</dd>
          <dt>Lifecycle state</dt><dd>{label(c.state)}{c.stateReason ? ` — ${c.stateReason}` : ""}</dd>
          {c.supersededBy && <><dt>Superseded by</dt><dd><Link href={`/opportunities/${c.supersededBy}`}>open the newer candidate</Link></dd></>}
          <dt>Found</dt><dd>{formatIst(c.createdAt)}</dd>
          <dt>Last validated</dt><dd>{c.lastValidatedAt ? formatIst(c.lastValidatedAt) : <span className="muted">not provided</span>}</dd>
          <dt>Expires</dt><dd>{formatIst(c.expiresAt)}</dd>
          <dt>Research attempts</dt><dd className="num">{c.researchAttempts}</dd>
        </dl>
      </Section>
      <Section id="ins-h" title="Instrument and strategy">
        <dl className="kv">
          <dt>Instrument</dt><dd>{instrumentLabel(c)}</dd><dt>Exchange</dt><dd>{c.exchange}</dd>
          <dt>Setup</dt><dd>{c.setup ? label(c.setup) : <span className="muted">not provided</span>}</dd><dt>Side</dt><dd>{c.side}</dd>
          <dt>Entry (as recorded)</dt><dd className="num">{entryText(c)}</dd><dt>Stop-loss</dt><dd className="num">{num(c.stopLoss)}</dd>
          <dt>Targets</dt><dd className="num">{targetsText(c.targets)}</dd><dt>Rank score (backend)</dt><dd className="num">{num(c.rankScore)}</dd>
        </dl>
        <p className="small muted" style={{ marginBottom: 0 }}>Prices are the scan’s numbers, shown as supplied. No reward-to-risk, size or loss is calculated here.</p>
      </Section>
      <Section id="res-h" title="Research" aside={<span className="xs muted">shared research evidence</span>}>
        <dl className="kv">
          <dt>Research status</dt><dd>{d.research.status ? label(d.research.status) : <span className="muted">not provided</span>}</dd>
          <dt>Package assessment</dt><dd>{d.research.assessment ? label(d.research.assessment) : <span className="muted">no package yet</span>}</dd>
          <dt>Package version</dt><dd className="num">{d.research.packageVersion ?? "—"}</dd>
          {pkg.data && "version" in pkg.data && pkg.data.haltReason && <><dt>Halt reason</dt><dd>{pkg.data.haltReason}</dd></>}
          {pkg.data && "createdAt" in pkg.data && <><dt>Package stored</dt><dd>{formatIst(pkg.data.createdAt)}</dd></>}
        </dl>
        {pkg.data && "note" in pkg.data && <p className="small muted">{pkg.data.note}</p>}
        <p className="small" style={{ margin: "10px 0 0" }}><Link href={`/research/${c.id}`}>Open the research workspace</Link> for the agent reports, contradictions, missing evidence and provenance. Research is evidence and never an approval.</p>
      </Section>
      <Section id="prov-h" title="Source provenance">
        <dl className="kv">
          <dt>Origin</dt><dd><SourceBadge source={c.source} /></dd>
          <dt>Scan data</dt><dd><DataSourceBadge dataSource={c.dataSource} /></dd>
          <dt>{c.source === "TELEGRAM" ? "Telegram channel" : "Detector run"}</dt><dd><span className="muted">not provided by this view</span></dd>
        </dl>
        <p className="small muted" style={{ marginBottom: 0 }}>{c.source === "TELEGRAM" ? "Parsed from a channel claim. Channel reliability is NOT AVAILABLE: it needs resolved real outcomes." : "Found by the independent opportunity engine; no channel is involved."} Provenance details recorded with the scan appear under “Recorded evidence”.</p>
      </Section>
      <Section id="ev-h" title="Recorded evidence" aside={<span className="xs muted">as recorded by the scan, not interpreted</span>}>
        {other.length ? <EvidenceList items={other} /> : <PlannedPanel title="Recorded evidence" kind="UNAVAILABLE">No evidence was recorded on this candidate.</PlannedPanel>}
      </Section>
      <Section id="liq-h" title="Options and liquidity evidence">
        {liquidity.length ? <EvidenceList items={liquidity} /> : <PlannedPanel title="Options chain and liquidity" kind="UNAVAILABLE">No options-chain, liquidity or spread evidence was recorded for this candidate, and the backend has no live options feed. Greeks and implied volatility are not provided.</PlannedPanel>}
      </Section>
      <Section id="ctx-h" title="Market context">
        <PlannedPanel title="Market regime and live market data" kind="UNAVAILABLE">No trader-authorised route provides a market regime, live quotes or technical indicators (G-16, G-20). Any technical reading appears only inside the recorded evidence above.</PlannedPanel>
      </Section>
      <Section id="life-h" title="Lifecycle">
        {d.lifecycle.length === 0 ? <p className="muted">No lifecycle events recorded.</p> : (
          <DataTable caption="Candidate lifecycle" rows={d.lifecycle} rowKey={(e) => `${e.at}-${e.to}`} columns={[
            { key: "at", header: "When", render: (e) => formatIst(e.at) }, { key: "from", header: "From", render: (e) => (e.from ? label(e.from) : "—") }, { key: "to", header: "To", render: (e) => label(e.to) },
            { key: "why", header: "Reason", hideOnMobile: true, render: (e) => e.reason ?? <span className="muted">not provided</span> },
          ]} />
        )}
      </Section>
      {role === "TRADER" ? <Decisions candidateId={c.id} /> : (
        <Section id="dec-h" title="Decisions and risk"><PlannedPanel title="Decisions are private to traders" kind="UNAVAILABLE">Decisions, risk checks and approvals belong to individual traders and are not available to administrators.</PlannedPanel></Section>
      )}
    </div>
  );
}

/** The trader's own decisions for this candidate. The API has no candidate filter, so the trader’s most recent decisions are loaded and matched here on candidateId; older ones may not appear. */
function Decisions({ candidateId }: { candidateId: string }) {
  const q = useDecisions(200), rows = (q.data?.decisions ?? []).filter((x) => x.candidateId === candidateId);
  const state = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: rows.length === 0, privateRoute: true });
  return (
    <Section id="dec-h" title="Decisions and risk" aside={<LoadedAt updatedAt={q.dataUpdatedAt} />}>
      <DataRegion state={state} what="decisions for this candidate" emptyHint="No decision has been made on this candidate yet. A decision appears here after the platform assesses it." onRetry={() => void q.refetch()}>
        <DataTable caption="Decisions for this candidate" rows={rows} rowKey={(x) => x.id} columns={[
          { key: "state", header: "Status", render: (x) => <DecisionStatusBadge state={x.workflowState} /> },
          { key: "out", header: "Assessment outcome", render: (x) => label(x.outcome) },
          { key: "until", header: "Valid until", render: (x) => formatIst(x.validUntil) },
          { key: "inv", header: "Invalidated", hideOnMobile: true, render: (x) => (x.invalidated ? `${x.invalidated.reasonCode} · ${formatIst(x.invalidated.at)}` : "—") },
          { key: "go", header: "", render: () => <Link href="/approvals">Approval Center</Link> },
        ]} />
        <p className="small muted">Matched from your {q.data?.decisions.length ?? 0} most recent decisions. Which risk checks failed is shown by the server only when an approval is attempted, so it is not displayed here.</p>
      </DataRegion>
    </Section>
  );
}
