"use client";
import Link from "next/link";
import { usePlaybook } from "@/api/strategyHooks";
import type { PlaybookDetail as PlaybookDetailT } from "@/api/strategyTypes";
import { ApiError, deriveState } from "@/state/dataState";
import { formatDecimal, formatIst } from "@/lib/format";
import { Banner, PageHead } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { LoadedAt, Section, label } from "@/components/desk/parts";

type Version = PlaybookDetailT["versions"][number];
function VersionCard({ v }: { v: Version }) {
  return (
    <article className="panel" aria-label={`Version ${v.version}`} style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>Version {v.version} <span className="badge b-neutral">{label(v.state)}</span></h3>
      <dl className="kv stack"><dt>Sample size</dt><dd className="num">{v.sampleSize}</dd><dt>Confidence</dt><dd className="num">{v.confidence === null ? <span className="muted">not provided</span> : formatDecimal(v.confidence)}</dd>
        <dt>Influences live (record flag)</dt><dd>{v.influencesLive === null ? <span className="muted">not recorded</span> : v.influencesLive ? "Yes (record flag only; live trading is disabled)" : "No"}</dd>
        <dt>Activated</dt><dd>{v.activatedAt ? formatIst(v.activatedAt) : <span className="muted">never</span>}</dd><dt>Created</dt><dd>{formatIst(v.createdAt)}</dd><dt>Limitations</dt><dd>{v.limitations || <span className="muted">none stated</span>}</dd></dl>
      <h4 className="small" style={{ margin: "16px 0 6px" }}>State history</h4>
      {v.events.length === 0 ? <p className="small muted">No state changes are recorded for this version.</p> : <DataTable wide caption={`Version ${v.version} state history`} rows={v.events} rowKey={(e) => `${e.at}${e.toState}`} columns={[{ key: "a", header: "When", render: (e) => formatIst(e.at) }, { key: "f", header: "From", render: (e) => (e.fromState ? label(e.fromState) : "—") }, { key: "t", header: "To", render: (e) => label(e.toState) }, { key: "w", header: "By", render: (e) => e.actor }, { key: "r", header: "Reason", wrap: true, render: (e) => e.reason ?? "—" }]} />}
    </article>
  );
}

/** One playbook, read-only: head, every version with its audited state history, and drift events. A version's content and performance are not shown (their structure is not contract-verified). */
export function PlaybookDetail({ id }: { id: string }) {
  const q = usePlaybook(id), d = q.data, notFound = q.error instanceof ApiError && q.error.status === 404;
  const st = deriveState({ loading: q.isLoading, error: q.error, hasData: !!d, empty: false });
  return (
    <>
      <PageHead eyebrow="Understand" title={d ? d.playbook.name : "Playbook detail"}><p><Link href="/strategies">← All playbooks</Link></p></PageHead>
      <div className="grid">
        <Banner tone="info" label="Read-only">Versions never change; only their state moves, by the owner, after an out-of-sample evaluation. This screen cannot activate, retire or edit anything, and live trading is disabled.</Banner>
        {notFound && <p className="muted" role="status">No playbook has this id.</p>}
        <DataRegion state={st} what="the playbook" onRetry={() => void q.refetch()}>
          {d && (<>
            <Section id="pd-h" title="Playbook" aside={<LoadedAt updatedAt={q.dataUpdatedAt} />}>
              <dl className="kv stack"><dt>Kind</dt><dd>{label(d.playbook.sourceKind)}</dd><dt>Created</dt><dd>{formatIst(d.playbook.createdAt)}</dd><dt>Versions</dt><dd className="num">{d.playbook.versions}</dd><dt>Active version</dt><dd>{d.playbook.activeVersion === null ? <span className="muted">none</span> : `v${d.playbook.activeVersion}`}</dd></dl>
              <p className="small muted">{d.note}</p>
            </Section>
            <Section id="pv-h" title="Versions">{d.versions.length === 0 ? <p className="muted" role="status">This playbook has no versions.</p> : d.versions.map((v) => <VersionCard key={v.version} v={v} />)}
              <p className="xs muted">Version content and performance are stored as free-form data whose structure is not verified, so they are not displayed.</p></Section>
            <Section id="dr-h" title="Drift events">{d.drift.length === 0 ? <PlannedPanel title="Drift events" kind="UNAVAILABLE">No drift event is recorded for this playbook.</PlannedPanel> : <DataTable wide caption="Drift events" rows={d.drift} rowKey={(x) => `${x.version}${x.metric}${x.detectedAt}`} columns={[{ key: "v", header: "Version", render: (x) => `v${x.version}` }, { key: "k", header: "Kind", render: (x) => label(x.kind) }, { key: "m", header: "Metric", render: (x) => label(x.metric) }, { key: "b", header: "Baseline", align: "right", render: (x) => <span className="num">{formatDecimal(x.baseline)}</span> }, { key: "o", header: "Observed", align: "right", render: (x) => <span className="num">{formatDecimal(x.observed)}</span> }, { key: "d", header: "Detected", render: (x) => formatIst(x.detectedAt) }]} />}</Section>
          </>)}
        </DataRegion>
      </div>
    </>
  );
}
