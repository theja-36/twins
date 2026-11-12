"use client";
import Link from "next/link";
import { useCandidate } from "@/api/hooks";
import { useResearchWorkspace } from "@/api/researchHooks";
import type { AgentReport, ResearchPresent } from "@/api/researchTypes";
import { ApiError, deriveState } from "@/state/dataState";
import { formatDecimal, formatIst } from "@/lib/format";
import { AvailabilityBadge } from "@/ui/badges";
import { Banner, PageHead } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { CandidateStateBadge, DataSourceBadge, LoadedAt, Section, SourceBadge, instrumentLabel } from "@/components/desk/parts";
import { upperWords, NOT_COMPUTED } from "@/components/insights/shared";

const INACTIVE = ["EXPIRED", "SUPERSEDED", "WITHDRAWN", "INVALIDATED"];
/** A verdict is a research verdict only. It is shown as plain text in a neutral badge: no colour implies approval, and INCOMPLETE is visibly "no verdict". */
function VerdictBadge({ v }: { v: string }) { return v === "INCOMPLETE" ? <span className="badge b-na" title="The agent did not produce a verdict">INCOMPLETE</span> : <span className="badge b-neutral" title="A research verdict. It is not an approval.">{v}</span>; }
function ExecBadge({ s }: { s: string }) { return <span className={`badge ${s === "COMPLETED" ? "b-neutral" : "b-na"}`}>{upperWords(s)}</span>; }
const list = (v: readonly string[]): string => (v.length ? v.join(", ") : "none");

/** Research Workspace for one candidate: the stored research package, shown exactly as recorded. Evidence only: it grants nothing and has no control that could. */
export function ResearchWorkspace({ id }: { id: string }) {
  const cand = useCandidate(id), pk = useResearchWorkspace(id), c = cand.data?.candidate, d = pk.data, present = d && d.package !== null ? (d as ResearchPresent) : null;
  const reports = present?.package.reports ?? [], incomplete = !!present && (present.assessment === "RESEARCH_INCOMPLETE" || present.status === "PARTIAL" || reports.some((r) => r.executionStatus !== "COMPLETED"));
  const state = deriveState({ loading: pk.isLoading, error: pk.error, hasData: !!d, empty: false, partial: incomplete });
  const notFound = pk.error instanceof ApiError && pk.error.status === 404;
  return (
    <>
      <PageHead eyebrow="Understand" title={c ? instrumentLabel(c) : "Research workspace"}>
        <p style={{ display: "flex", gap: 14, flexWrap: "wrap" }}><Link href="/research">← All research</Link><Link href={`/opportunities/${id}`}>Candidate detail</Link></p>
      </PageHead>
      <div className="grid">
        <Banner tone="info" label="Evidence, not approval">Research is evidence. An assessment such as “supportive” is not a decision outcome and not an approval, and no research result can approve, reject or execute anything. This page has no such control.</Banner>
        {c && INACTIVE.includes(c.state) && <Banner label={upperWords(c.state)}>This candidate is {upperWords(c.state).toLowerCase()}, so the research below describes a candidate that is no longer active. The research API does not say how fresh a package is; only the candidate’s own state is shown.</Banner>}
        {notFound && <p className="muted" role="status">No candidate with this id, or no research record for it.</p>}
        <DataRegion state={state} what="the research package" deniedNote="Research is not available to you." partialNote="This package is incomplete: some agents did not produce a result. What exists is shown below, and unavailable agents are listed rather than hidden." onRetry={() => void pk.refetch()}>
          {d ? (present ? <Package p={present} cand={c ? { source: c.source, state: c.state, dataSource: c.dataSource } : null} candFailed={cand.isError} updatedAt={pk.dataUpdatedAt} /> : (
            <Section id="rp-none" title="Research package" aside={<LoadedAt updatedAt={pk.dataUpdatedAt} />}>
              <PlannedPanel title="No research package yet" kind="UNAVAILABLE">{(d as { note: string }).note}</PlannedPanel>
              <dl className="kv" style={{ marginTop: 12 }}><dt>Research status</dt><dd>{d.status ? upperWords(d.status) : NOT_COMPUTED}</dd><dt>Research attempts</dt><dd className="num">{d.researchAttempts ?? NOT_COMPUTED}</dd></dl>
            </Section>
          )) : null}
        </DataRegion>
        <Section id="nd-h" title="Not shown here">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {[["Options-risk context", "Its structure is not verified, so it is not displayed."], ["Per-agent findings and inputs", "The research API exposes only each agent’s verdict, risk flags, a short summary and a hash of its input."], ["Package history", "Only the latest package for a candidate is served."], ["Freshness", "The API does not say how fresh a package or its data is."]].map(([t, why]) => <li key={t}><AvailabilityBadge kind="UNAVAILABLE" /> <b>{t}</b><div className="small muted">{why}</div></li>)}
          </ul>
        </Section>
      </div>
    </>
  );
}

function Package({ p, cand, candFailed, updatedAt }: { p: ResearchPresent; cand: { source: string; state: string; dataSource: string } | null; candFailed: boolean; updatedAt: number }) {
  const b = p.package, tally = Object.entries(b.reports.reduce<Record<string, number>>((m, r) => ({ ...m, [r.executionStatus]: (m[r.executionStatus] ?? 0) + 1 }), {}));
  return (
    <>
      <Section id="rp-h" title="Package overview" aside={<LoadedAt updatedAt={updatedAt} />}>
        <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 10px" }}>
          <SourceBadge source={b.candidateSource} /><DataSourceBadge dataSource={b.dataSource} />{cand && <CandidateStateBadge state={cand.state} />}<span className="badge b-neutral" title="grantsApproval is false in every package">GRANTS NO APPROVAL</span>
        </p>
        {candFailed && <p className="small muted">The candidate record could not be loaded, so its lifecycle state is not shown.</p>}
        <dl className="kv stack">
          <dt>Research status</dt><dd>{p.status ? upperWords(p.status) : NOT_COMPUTED}</dd>
          <dt>Research assessment</dt><dd><b>{upperWords(p.assessment)}</b> <span className="xs muted">(evidence, not a decision)</span></dd>
          <dt>Halted</dt><dd>{b.halt ? <>Yes{p.haltReason ? ` — ${upperWords(p.haltReason)}` : ""}</> : "No"}</dd>
          <dt>Synthesis score</dt><dd className="num">{b.score === null ? NOT_COMPUTED : formatDecimal(b.score)}</dd>
          <dt>Package version</dt><dd className="num">{p.version}</dd><dt>Stored</dt><dd>{formatIst(p.createdAt)}</dd>
          <dt>As of</dt><dd>{b.asOf ? formatIst(b.asOf) : <span className="muted">not recorded for this package</span>}</dd>
          <dt>Research attempts</dt><dd className="num">{p.researchAttempts ?? NOT_COMPUTED}</dd>
          <dt>Package format</dt><dd>{b.packageVersion} · synthesis {b.synthesisAlgorithmVersion}</dd>
        </dl>
        <p className="xs muted">The synthesis score is the research engine’s own number, shown as recorded. It is not a probability, not a confidence in any outcome and not an approval.</p>
        <details><summary className="small">Provenance (hashes and agent versions)</summary>
          <dl className="kv" style={{ fontSize: 12, marginTop: 8 }}><dt>Package hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{b.packageSha256}</dd><dt>Synthesis input hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{b.synthesisInputSha256}</dd><dt>Candidate</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{b.candidateId}</dd>{Object.entries(b.agentVersions).map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </details>
      </Section>
      <Section id="ar-h" title="Agent reports">
        <p className="small muted">{b.reports.length} reports, in the order stored. {tally.map(([k, n]) => `${upperWords(k)} ${n}`).join(" · ") || "none"}. An agent that could not run reports INCOMPLETE with an error code: that is “no evidence”, never a pass. Confidence is the agent’s own number, shown as reported; its scale is the agent’s.</p>
        <div className="agent-table">
          <DataTable<AgentReport> wide caption="Agent reports" rows={b.reports} rowKey={(r) => r.agentId} columns={[
            { key: "a", header: "Agent", render: (r) => <><b>{r.agentId}</b><span className="xs muted" style={{ display: "block" }}>v{r.agentVersion}</span></> }, { key: "ro", header: "Role", render: (r) => (r.role ? upperWords(r.role) : "—") },
            { key: "v", header: "Verdict", render: (r) => <VerdictBadge v={r.verdict} /> }, { key: "e", header: "Execution status and error code", render: (r) => <><ExecBadge s={r.executionStatus} />{r.errorCode && <span className="xs mono" style={{ display: "block", marginTop: 4 }}>{r.errorCode}</span>}</> },
            { key: "c", header: "Confidence", align: "right", render: (r) => <span className="num">{r.confidence === null ? NOT_COMPUTED : formatDecimal(r.confidence)}</span> },
            { key: "s", header: "Reasoning summary", wrap: true, render: (r) => r.reasoningSummary },
            { key: "f", header: "Risk flags", wrap: true, render: (r) => list(r.riskFlags) },
            { key: "ev", header: "Evidence references", wrap: true, render: (r) => (r.evidenceRefs.length === 0 ? "none" : <details><summary>{r.evidenceRefs.length} reference{r.evidenceRefs.length === 1 ? "" : "s"}</summary><ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>{r.evidenceRefs.map((e) => <li key={e} className="xs mono" style={{ overflowWrap: "anywhere" }}>{e}</li>)}</ul></details>) },
          ]} />
        </div>
        <AgentCards reports={b.reports} />
      </Section>
      <Section id="ct-h" title="Contradictions">
        {b.contradictions.length === 0 ? <p className="muted">No contradictions recorded between completed agents.</p> : <ul style={{ margin: 0, paddingLeft: 18 }}>{b.contradictions.map((x) => <li key={x.opposingVerdict} style={{ marginBottom: 6 }}>Supportive: {list(x.supportive)} — opposing ({x.opposingVerdict}): {list(x.opposing)}</li>)}</ul>}
      </Section>
      <Section id="rc-h2" title="Role coverage">
        <p className="small muted">Coverage says which research roles have a registered agent. It does not say that those agents produced evidence: see the reports above.</p>
        <dl className="kv stack"><dt>Roles with agents</dt><dd>{list(b.roleCoverage.coveredRoles.map(upperWords))}</dd><dt>Roles without agents</dt><dd>{list(b.roleCoverage.missingRoles.map(upperWords))}</dd><dt>Agents mapped to no role</dt><dd>{list(b.roleCoverage.unmappedAgents)}</dd></dl>
      </Section>
      <Section id="mr-h" title="Missing required agents">
        {b.missingRequired.length === 0 ? <p className="muted">No required agent is missing.</p> : <><p className="small muted">A required agent without a completed result halts the package. These required agents have none:</p><ul style={{ margin: 0, paddingLeft: 18 }}>{b.missingRequired.map((m) => <li key={m} className="mono">{m}</li>)}</ul></>}
      </Section>
      <Section id="ei-h" title="Evidence index">
        {b.evidenceIndex.length === 0 ? <p className="muted">No evidence reference was recorded.</p> : <details><summary className="small">{b.evidenceIndex.length} reference{b.evidenceIndex.length === 1 ? "" : "s"} across all agents</summary><div className="tblwrap" role="region" tabIndex={0} aria-label="Evidence index (scrollable)" style={{ maxHeight: 260, marginTop: 8, padding: 10 }}><ul style={{ margin: 0, paddingLeft: 16 }}>{b.evidenceIndex.map((e) => <li key={e} className="xs mono" style={{ overflowWrap: "anywhere" }}>{e}</li>)}</ul></div></details>}
      </Section>
    </>
  );
}

/** The same reports as stacked cards for phone widths (CSS shows one of the two). Every field is plain text: nothing here is HTML. */
function AgentCards({ reports }: { reports: AgentReport[] }) {
  return (
    <ul className="agent-cards" aria-label="Agent reports (cards)">
      {reports.map((r) => (
        <li key={r.agentId} className="panel flat" style={{ minWidth: 0 }}>
          <p style={{ margin: "0 0 6px" }}><b style={{ overflowWrap: "anywhere" }}>{r.agentId}</b> <span className="xs muted">v{r.agentVersion}{r.role ? ` · ${upperWords(r.role)}` : ""}</span></p>
          <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 8px" }}><VerdictBadge v={r.verdict} /><ExecBadge s={r.executionStatus} /></p>
          <dl className="kv stack" style={{ fontSize: 13 }}>
            <dt>Confidence</dt><dd className="num">{r.confidence === null ? NOT_COMPUTED : formatDecimal(r.confidence)}</dd>
            {r.errorCode && <><dt>Error code</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{r.errorCode}</dd></>}
            <dt>Risk flags</dt><dd>{list(r.riskFlags)}</dd>
            <dt>Reasoning summary</dt><dd>{r.reasoningSummary}</dd>
          </dl>
          {r.evidenceRefs.length > 0 ? <details><summary className="small">{r.evidenceRefs.length} evidence reference{r.evidenceRefs.length === 1 ? "" : "s"}</summary><ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>{r.evidenceRefs.map((e) => <li key={e} className="xs mono" style={{ overflowWrap: "anywhere" }}>{e}</li>)}</ul></details> : <p className="xs muted" style={{ margin: 0 }}>No evidence references.</p>}
        </li>
      ))}
    </ul>
  );
}
