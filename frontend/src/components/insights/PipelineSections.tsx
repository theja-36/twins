"use client";
import { useAgents, useChannelsAnalytics, useDecisionQuality, useIndependent } from "@/api/analyticsHooks";
import { formatDecimal } from "@/lib/format";
import { Banner } from "@/ui/primitives";
import { DataTable } from "@/ui/table";
import { CountsList, FixtureLabel, GenericRows, NOT_COMPUTED, PerformanceGrid, Section, SectionFrame, Unavailable, upperWords, words } from "./shared";

const frac = (v: number | null): string => (v === null ? NOT_COMPUTED : formatDecimal(v));
function Tally({ t, id, title }: { t: { total: number; approved: number; qualified: number; invalidated: number; withPosition: number; expiredOrCancelled: number; byOutcome: Record<string, number> }; id: string; title: string }) {
  return (
    <Section id={id} title={title}>
      <dl className="kv"><dt>Decisions recorded</dt><dd className="num">{t.total}</dd><dt>Eligible for approval (engine verdict)</dt><dd className="num">{t.qualified}</dd><dt>Approved by a person</dt><dd className="num">{t.approved}</dd><dt>Reached a paper position</dt><dd className="num">{t.withPosition}</dd><dt>Invalidated</dt><dd className="num">{t.invalidated}</dd><dt>Expired or cancelled</dt><dd className="num">{t.expiredOrCancelled}</dd></dl>
      <p className="xs muted">“Eligible for approval” is the decision engine’s verdict. It is not an approval and not an execution; those are separate rows.</p>
      <CountsList caption="Decisions by engine outcome" counts={t.byOutcome} />
    </Section>
  );
}

export function ChannelsSection() {
  const q = useChannelsAnalytics(), env = q.data, d = env?.data;
  return (
    <SectionFrame what="channel analytics" q={q} env={env}>
      {d && <>
        <Section id="ch-h" title="Telegram channels in the analytics">
          <p className="small muted">{d.note}</p><p className="num">Candidates from Telegram: {d.candidates}</p>
          {d.channels.length === 0 ? <Unavailable title="No channel rows">The analytics hold no per-channel records yet. Nothing is invented for an empty list.</Unavailable> : <><Banner label="Unverified rows">The per-channel row structure has not been verified, so each channel is shown as plain recorded fields.</Banner><GenericRows rows={d.channels} caption="Channel rows" /></>}
        </Section>
        <Tally t={d.decisions} id="chd-h" title="Decisions that came from Telegram" />
        <Section id="chu-h" title="Not available">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{d.unavailable.map((u) => <li key={u} style={{ marginBottom: 6 }}>{u}</li>)}</ul>
          <Unavailable title="Channel reliability">The backend provides no channel reliability. Paper outcomes of TWINS decisions measure TWINS, not the channel.</Unavailable>
        </Section>
      </>}
    </SectionFrame>
  );
}

export function IndependentSection() {
  const q = useIndependent(), env = q.data, d = env?.data;
  return (
    <SectionFrame what="independent opportunity analytics" q={q} env={env}>
      {d && <>
        <Section id="in-h" title="Independent opportunity pipeline">
          <p className="small muted">{d.note}</p>
          <dl className="kv"><dt>Scans</dt><dd className="num">{d.scans}</dd><dt>Candidates generated</dt><dd className="num">{d.generated}</dd><dt>Researched</dt><dd className="num">{d.researched}</dd></dl>
          <DataTable caption="Stage-to-stage rates as supplied" rows={Object.entries(d.rates)} rowKey={([k]) => k} columns={[
            { key: "n", header: "Stage", render: ([k]) => <b>{words(k)}</b> }, { key: "r", header: "Rate (fraction)", align: "right", render: ([, r]) => <span className="num">{frac(r.value)}</span> },
            { key: "c", header: "Count", align: "right", render: ([, r]) => <span className="num">{r.numerator} of {r.denominator}</span> }]} />
          <p className="xs muted">Rates are exactly what the backend reports (a count over a count). A rate is “{NOT_COMPUTED}” when its denominator is zero.</p>
          {Object.keys(d.reasons).length > 0 && <CountsList caption="Candidate state reasons" counts={d.reasons} />}
        </Section>
        <Tally t={d.decisions} id="ind-h" title="Decisions from independent candidates" />
        <Section id="ino-h" title="Final outcomes">
          {d.outcomes === null ? <Unavailable title="No final outcomes yet">No eligible outcome comes from independent candidates yet.</Unavailable> : <>
            <PerformanceGrid m={d.outcomes.total} title="All independent outcomes" />
            <DataTable caption="Independent outcomes by opportunity type" rows={d.outcomes.byOpportunityType} rowKey={(s) => s.key} columns={[
              { key: "k", header: "Opportunity type", render: (s) => <b>{upperWords(s.key)}</b> }, { key: "n", header: "Eligible (n)", align: "right", render: (s) => <span className="num">{s.metrics.eligible}</span> }, { key: "fx", header: "Data", render: (s) => <FixtureLabel dataSources={s.metrics.dataSources} /> }]} /></>}
        </Section>
      </>}
    </SectionFrame>
  );
}

export function AgentsSection() {
  const q = useAgents(), env = q.data, d = env?.data;
  return (
    <SectionFrame what="agent analytics" q={q} env={env}>
      {d && <>
        <Section id="ag-h" title="Research agents">
          <p className="small muted">Read-only. This page cannot change any agent, weight, dependency or permission. Agreement is not correctness.</p>
          <dl className="kv"><dt>Research packages analysed</dt><dd className="num">{d.packages}</dd><dt>With two or more verdicts</dt><dd className="num">{d.agreement.packagesWithTwoOrMoreVerdicts}</dd><dt>Unanimous</dt><dd className="num">{d.agreement.unanimous}</dd><dt>Disagreement</dt><dd className="num">{d.agreement.disagreement}</dd><dt>With contradictions</dt><dd className="num">{d.agreement.withContradictions}</dd><dt>Packages missing a required agent</dt><dd className="num">{d.evidenceGaps.packagesMissingRequiredAgents}</dd></dl>
          <CountsList caption="Research assessments (counts)" counts={d.assessments} />
        </Section>
        <Section id="aga-h" title="By agent">
          {d.agents.length === 0 ? <Unavailable title="No agent records">No research package has been analysed yet.</Unavailable> : <DataTable caption="Agent participation" rows={d.agents} rowKey={(a) => a.agentId} columns={[
            { key: "a", header: "Agent", render: (a) => <b>{a.agentId}</b> }, { key: "p", header: "Packages", align: "right", render: (a) => <span className="num">{a.packages}</span> }, { key: "c", header: "Completed", align: "right", render: (a) => <span className="num">{a.completed}</span> },
            { key: "u", header: "Unavailable", align: "right", render: (a) => <span className="num">{a.unavailable}</span> }, { key: "av", header: "Availability (fraction)", hideOnMobile: true, align: "right", render: (a) => <span className="num">{frac(a.availabilityRate)}</span> },
            { key: "rf", header: "Risk-flag rate (fraction)", hideOnMobile: true, align: "right", render: (a) => <span className="num">{frac(a.riskFlagRate)}</span> },
            { key: "v", header: "Verdicts", hideOnMobile: true, render: (a) => Object.entries(a.verdicts).map(([k, n]) => `${upperWords(k)} ${n}`).join(" · ") || "none" }]} />}
          {d.agents.some((a) => a.outcomeAssociation.length > 0) && <Banner label="Association only">{d.agents.find((a) => a.associationNote)?.associationNote} Rows are shown as recorded fields because their structure is unverified.</Banner>}
          {d.agents.flatMap((a) => (a.outcomeAssociation.length ? [<div key={a.agentId}><b>{a.agentId}</b><GenericRows rows={a.outcomeAssociation} caption={`${a.agentId} outcome association`} /></div>] : []))}
        </Section>
      </>}
    </SectionFrame>
  );
}

export function DecisionsSection() {
  const q = useDecisionQuality(), env = q.data, d = env?.data;
  return (
    <SectionFrame what="decision quality" q={q} env={env}>
      {d && <>
        <Tally t={d.decisions} id="dq-h" title="Decision tallies" />
        <Section id="dqe-h" title="Executed decisions (realised paper outcomes)">
          <p className="small">Qualified decisions that were executed: <b className="num">{d.executed.qualifiedExecuted}</b>. Only executed decisions have a realised result.</p>
          {d.executed.metrics === null ? <Unavailable title="No realised results">No decision has been executed and closed yet.</Unavailable> : <PerformanceGrid m={d.executed.metrics} title="Executed decisions" />}
        </Section>
        <Section id="dqn-h" title="Not executed: price-level estimates">
          {d.notExecuted.length === 0 ? <p className="muted">No unexecuted decisions have estimates.</p> : <DataTable caption="Which level price reached first (estimates, not P&L)" rows={d.notExecuted} rowKey={(r) => r.outcome} columns={[
            { key: "o", header: "Decision outcome", render: (r) => <b>{upperWords(r.outcome)}</b> }, { key: "c", header: "Decisions", align: "right", render: (r) => <span className="num">{r.count}</span> },
            { key: "e", header: "Estimate counts", render: (r) => Object.entries(r.estimate).map(([k, v]) => `${words(k)}: ${String(v)}`).join(" · ") }]} />}
        </Section>
        <Section id="dql-h" title="Limitations stated by the backend"><ul style={{ margin: 0, paddingLeft: 18 }}>{d.limitations.map((l) => <li key={l} style={{ marginBottom: 6 }}>{l}</li>)}</ul></Section>
      </>}
    </SectionFrame>
  );
}
