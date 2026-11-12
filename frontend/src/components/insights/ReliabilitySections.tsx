"use client";
import { useCalibration, useDataQuality, useDrift } from "@/api/analyticsHooks";
import { formatDecimal } from "@/lib/format";
import { DataTable } from "@/ui/table";
import { CountsList, NOT_COMPUTED, Section, SectionFrame, Unavailable, upperWords, words } from "./shared";

const frac = (v: number | null): string => (v === null ? NOT_COMPUTED : formatDecimal(v));

export function DriftSection() {
  const q = useDrift(), env = q.data, d = env?.data, detected = d?.findings.filter((f) => f.warn) ?? [];
  return (
    <SectionFrame what="drift analysis" q={q} env={env}>
      {d && <>
        <Section id="dr-h" title="Drift findings">
          <p className="small muted">Drift compares a recent window of paper outcomes with an earlier baseline. A finding with too few outcomes says “insufficient data”: that is not the same as “no drift”.</p>
          <dl className="kv"><dt>Findings with a drift warning</dt><dd className="num">{detected.length}</dd><dt>Findings</dt><dd className="num">{d.findings.length}</dd><dt>Subjects with insufficient data</dt><dd className="num">{d.insufficient}</dd></dl>
          {d.findings.length === 0 ? <Unavailable title="No drift findings">No subject has outcomes to compare yet.</Unavailable> : <DataTable caption="Drift findings" rows={d.findings} rowKey={(f) => `${f.subjectKind}:${f.subject}`} columns={[
            { key: "s", header: "Subject", render: (f) => <b>{f.subject}</b> }, { key: "k", header: "Kind", hideOnMobile: true, render: (f) => upperWords(f.subjectKind) }, { key: "n", header: "Outcomes (n)", align: "right", render: (f) => <span className="num">{f.n}</span> },
            { key: "st", header: "Status", render: (f) => upperWords(f.report.status) }, { key: "w", header: "Warning", render: (f) => (f.warn ? <span className="badge b-neutral">DRIFT WARNING</span> : "none") },
            { key: "z", header: "z", hideOnMobile: true, align: "right", render: (f) => <span className="num">{frac(f.report.z)}</span> }, { key: "note", header: "Backend note", hideOnMobile: true, render: (f) => <span className="xs">{f.report.note}</span> }]} />}
          {d.warnings.length > 0 && <p className="small"><b>Warnings listed by the backend:</b> {d.warnings.map((w) => w.subject).join(", ")}</p>}
        </Section>
        <Section id="drs-h" title="Distribution shifts">
          <DataTable caption="Distribution shifts" rows={Object.entries(d.shifts)} rowKey={([k]) => k} columns={[
            { key: "k", header: "Measure", render: ([k]) => <b>{words(k)}</b> }, { key: "s", header: "Status", render: ([, s]) => upperWords(s.status) }, { key: "r", header: "Recent n", align: "right", render: ([, s]) => <span className="num">{s.recentN}</span> },
            { key: "b", header: "Baseline n", align: "right", render: ([, s]) => <span className="num">{s.baselineN}</span> }, { key: "t", header: "Total variation distance", align: "right", hideOnMobile: true, render: ([, s]) => <span className="num">{frac(s.totalVariationDistance)}</span> }]} />
        </Section>
      </>}
    </SectionFrame>
  );
}

export function DataQualitySection() {
  const q = useDataQuality(), env = q.data, d = env?.data;
  return (
    <SectionFrame what="data quality" q={q} env={env}>
      {d && <>
        <Section id="dq-h" title="How reliable the analytics inputs are">
          {d.warnings.length > 0 && <div className="banner" role="note"><b>Data-quality warnings</b><span>{d.warnings.join(" · ")}</span></div>}
          <dl className="kv"><dt>Outcome records</dt><dd className="num">{d.records}</dd><dt>Final</dt><dd className="num">{d.final}</dd><dt>Partial</dt><dd className="num">{d.partial}</dd><dt>Corrected versions</dt><dd className="num">{d.correctedVersions}</dd><dt>Fixture-backed</dt><dd className="num">{d.fixtureBacked}</dd><dt>Fixture share (fraction)</dt><dd className="num">{frac(d.fixtureShare)}</dd></dl>
          <p className="small"><b>Validated dataset:</b> {d.validatedDataset.eligible} eligible. <span className="muted">{d.validatedDataset.note}</span></p>
        </Section>
        <Section id="dqc-h" title="Data-quality codes"><CountsList caption="Data-quality codes" counts={d.codes} /></Section>
        <Section id="dqm-h" title="Fields the analytics could not use"><CountsList caption="Missing fields (records missing each)" counts={d.missingFields} /></Section>
      </>}
    </SectionFrame>
  );
}

export function CalibrationSection() {
  const q = useCalibration(), env = q.data, d = env?.data;
  return (
    <SectionFrame what="calibration" q={q} env={env}>
      {d && <Section id="ca-h" title="Confidence calibration">
        <p><span className="badge b-neutral">{upperWords(d.status)}</span></p><p className="small">{d.note}</p>
        {d.reasons.length > 0 && <><b className="small">Why</b><ul style={{ margin: "4px 0 10px", paddingLeft: 18 }}>{d.reasons.map((r) => <li key={r}>{r}</li>)}</ul></>}
        <dl className="kv"><dt>Fit sample</dt><dd className="num">{d.fitSize === null ? NOT_COMPUTED : d.fitSize}</dd><dt>Holdout sample</dt><dd className="num">{d.holdoutSize === null ? NOT_COMPUTED : d.holdoutSize}</dd></dl>
        <CountsList caption="Records excluded from calibration" counts={d.excluded} />
        <Unavailable title="Calibration curve and probability buckets">The backend provides no calibration curve, reliability diagram or probability estimate. Confidence is a strength score, not a probability.</Unavailable>
      </Section>}
    </SectionFrame>
  );
}
