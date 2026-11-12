"use client";
/**
 * Shared presentation for Learning & Insights. Everything DISPLAYS what the backend returned: no metric is calculated, a value the backend did not compute is shown as "Not computed" (never 0),
 * every metric keeps its own definition, sample size and note, and fixture-backed data is labelled wherever it appears.
 */
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError, deriveState } from "@/state/dataState";
import { formatDecimal, formatIst, formatMoney } from "@/lib/format";
import { FreshnessChip, PnlValue, ProvenanceBadge } from "@/ui/badges";
import { Banner } from "@/ui/primitives";
import { DataRegion, PlannedPanel } from "@/ui/state";
import type { DataState } from "@twins/api-contracts";
import type { AnyEnv, Metrics } from "@/api/analyticsTypes";

export const words = (v: string): string => v.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
export const upperWords = (v: string): string => v.replaceAll("_", " ");
export const NOT_COMPUTED = "Not computed";

/** FIXTURE-BACKED labelling from the data-source counts the backend supplies. No counts are added up. */
export function FixtureLabel({ dataSources }: { dataSources: Record<string, number> | undefined }) {
  const keys = Object.keys(dataSources ?? {});
  if (keys.length === 0) return null;
  const onlyFixture = keys.every((k) => k === "FIXTURE"), some = keys.includes("FIXTURE");
  if (onlyFixture) return <span className="badge b-fix" title="Every outcome behind this figure was built on synthetic fixture data, not a market">FIXTURE-BACKED DATA</span>;
  if (some) return <span className="badge b-fix" title="Some of the outcomes behind this figure are fixture-backed">INCLUDES FIXTURE-BACKED DATA</span>;
  return null;
}
export const sourceLine = (ds: Record<string, number> | undefined): string => { const e = Object.entries(ds ?? {}); return e.length ? e.map(([k, n]) => `${k} ${n}`).join(" · ") : "no outcomes"; };

/** The envelope facts every analytics response carries: mode, dataset, live status, freshness, snapshot identity, and what a read may do. */
export function SnapshotBar({ env, updatedAt }: { env: AnyEnv; updatedAt: number }) {
  const s = env.snapshot, stale = env.freshness === "STALE";
  return (
    <section className="panel flat" aria-label="Snapshot and provenance" style={{ marginBottom: 14 }}>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "0 0 8px" }}>
        <ProvenanceBadge kind="PAPER" /><span className="badge b-neutral">DATASET {env.dataset}</span><span className="badge b-na" title={`liveStatus: ${env.liveStatus}`}>LIVE ANALYTICS UNAVAILABLE</span>
        <FreshnessChip freshness={env.freshness} asOf={s.asOf} />{env.state === "PARTIAL" && <span className="badge b-neutral">PARTIAL EVIDENCE</span>}
      </p>
      {stale && <div className="banner" role="status"><b>STALE</b><span>{s.staleReason ?? "This is an older stored snapshot."} The figures below are the newest stored snapshot, not the current evidence.</span></div>}
      <p className="small muted" style={{ margin: "6px 0" }}>{env.notice}</p>
      <dl className="kv" style={{ fontSize: 13 }}>
        <dt>Generated</dt><dd>{formatIst(env.generatedAt)}</dd><dt>Snapshot as of</dt><dd>{formatIst(s.asOf)}</dd><dt>Snapshot</dt><dd className="mono">{s.id.slice(0, 8)}</dd><dt>Contract</dt><dd>{env.contractVersion}</dd>
        <dt>Loaded in this page</dt><dd>{updatedAt > 0 ? formatIst(new Date(updatedAt).toISOString()) : "—"}</dd>
      </dl>
      <details style={{ marginTop: 8 }}><summary className="small">Provenance details (hashes and algorithm versions)</summary>
        <dl className="kv" style={{ fontSize: 12, marginTop: 8 }}>
          <dt>Evidence hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{s.evidenceHash}</dd><dt>Input hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{s.inputHash}</dd><dt>Config hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{s.configHash}</dd>
          <dt>Created by</dt><dd>{s.createdBy}</dd><dt>Complete</dt><dd>{s.complete ? "yes" : "no: some inputs were capped"}</dd><dt>Maximum age</dt><dd className="num">{s.maxAgeSeconds} s</dd>
          {Object.entries(s.algorithmVersions).map(([k, v]) => (<div key={k} style={{ display: "contents" }}><dt>{words(k)}</dt><dd>{v}</dd></div>))}
        </dl>
      </details>
      <p className="xs muted" style={{ margin: "8px 0 0" }}>Analytics may be generated or refreshed by a read request: when no current snapshot exists the backend stores one immutable PAPER snapshot while answering. Nothing here changes any setting.</p>
    </section>
  );
}

/** The one place a section decides its state from the query and the envelope. */
export function sectionState(q: Pick<UseQueryResult<unknown>, "isLoading" | "error" | "data">, env: AnyEnv | undefined, extra: { unavailable?: boolean } = {}): DataState {
  return deriveState({ loading: q.isLoading, error: q.error, hasData: !!env, empty: env?.state === "EMPTY", partial: env?.state === "PARTIAL", stale: env?.freshness === "STALE", unavailable: extra.unavailable, privateRoute: true });
}
export function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (<section className="panel" aria-labelledby={id} style={{ marginBottom: 18 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline", marginBottom: 10 }}><h2 id={id} style={{ margin: 0 }}>{title}</h2>{aside}</div>{children}</section>);
}
/** Wraps a section's body in the eight data states, with the snapshot bar when data exists. */
export function SectionFrame({ what, q, env, children, emptyHint, unavailable, unavailableReason }: { what: string; q: UseQueryResult<unknown>; env: AnyEnv | undefined; children: ReactNode; emptyHint?: string; unavailable?: boolean; unavailableReason?: string }) {
  const state = sectionState(q, env, { unavailable });
  const errId = q.error instanceof ApiError ? q.error.code : null;
  return (
    <>
      {env && <SnapshotBar env={env} updatedAt={q.dataUpdatedAt} />}
      <DataRegion state={state} what={what} errorId={errId} emptyHint={emptyHint ?? "The backend has no recorded outcomes for you yet, so there is nothing to analyse. Figures appear after paper positions close."}
        unavailableReason={unavailableReason} staleNote={env?.snapshot.staleReason ?? undefined} partialNote="Some evidence behind these figures is incomplete (for example partial outcomes); the sections that exist are shown." onRetry={() => void q.refetch()}>
        {children}
      </DataRegion>
    </>
  );
}
export function Unavailable({ title, children }: { title: string; children: ReactNode }) { return <PlannedPanel title={title} kind="UNAVAILABLE">{children}</PlannedPanel>; }
export function Note({ children }: { children: ReactNode }) { return <Banner tone="info" label="Note">{children}</Banner>; }

/** Counts the backend returned, as a labelled table. Keys are shown as text; nothing is summed. */
export function CountsList({ caption, counts }: { caption: string; counts: Record<string, number> }) {
  const e = Object.entries(counts);
  if (e.length === 0) return <p className="muted small">{caption}: none recorded.</p>;
  return (<div className="tblwrap" role="region" tabIndex={0} aria-label={`${caption} (scrollable)`}><table><caption className="sr">{caption}</caption><thead><tr><th scope="col">Item</th><th scope="col" className="r">Count</th></tr></thead><tbody>{e.map(([k, n]) => <tr key={k}><td>{upperWords(k)}</td><td className="r num">{n}</td></tr>)}</tbody></table></div>);
}
/** Unverified rows: one level of plain fields as text (strings, numbers, booleans); anything nested is shown as truncated JSON text. Never interpreted, never HTML. */
export function GenericRows({ rows, caption }: { rows: readonly unknown[]; caption: string }) {
  const objs = rows.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r)).slice(0, 50);
  if (objs.length === 0) return null;
  return (<div style={{ display: "grid", gap: 10 }} aria-label={caption}>{objs.map((o, i) => (<dl key={i} className="kv panel flat" style={{ fontSize: 13 }}>{Object.entries(o).slice(0, 30).map(([k, v]) => (<div key={k} style={{ display: "contents" }}><dt>{words(k)}</dt><dd>{typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? <span className="num">{String(v)}</span> : v === null ? <span className="muted">not provided</span> : <code>{JSON.stringify(v).slice(0, 240)}</code>}</dd></div>))}</dl>))}</div>);
}

// ── metrics ────────────────────────────────────────────────────────────────
export type MetricLike = { value: number | string | null; n: number; definition: string; note?: string | undefined; interval?: { lower: number; upper: number } | null; interval95?: { lower: number; upper: number } | null };
const valueText = (m: MetricLike, kind: "money" | "number"): string => (m.value === null ? NOT_COMPUTED : kind === "money" ? formatMoney(typeof m.value === "string" ? m.value : null) : formatDecimal(m.value));
/** One metric: its value (or "Not computed"), its sample size, its interval and note exactly as supplied, and its definition in plain view (never only a tooltip). */
export function MetricCard({ label, metric, kind = "number", unit }: { label: string; metric: MetricLike; kind?: "money" | "number"; unit?: string }) {
  const iv = metric.interval ?? metric.interval95 ?? null, missing = metric.value === null;
  return (
    <div className="panel flat" role="group" aria-label={label} style={{ minWidth: 0 }}>
      <div className="small muted">{label}</div>
      <div className="num" style={{ fontSize: 22, margin: "2px 0" }}>{missing ? <span className="muted" style={{ fontSize: 16 }}>{NOT_COMPUTED}</span> : <>{valueText(metric, kind)}{unit ? <span className="small muted"> {unit}</span> : null}</>}</div>
      <div className="xs">n = <span className="num">{metric.n}</span>{iv ? <> · 95% interval <span className="num">{formatDecimal(iv.lower)}</span> to <span className="num">{formatDecimal(iv.upper)}</span></> : null}</div>
      {metric.note && <div className="xs" style={{ marginTop: 4 }}><b>Note:</b> {metric.note}</div>}
      <div className="xs muted" style={{ marginTop: 4 }}>{metric.definition}</div>
    </div>
  );
}
/** The full verified metric set of one outcome group. Every card states its own sample and definition; unavailable metrics are labelled, never zero. */
export function PerformanceGrid({ m, title }: { m: Metrics; title: string }) {
  return (
    <div>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}><b>{title}</b><FixtureLabel dataSources={m.dataSources} /><span className="badge b-neutral">{upperWords(m.status)}</span><span className="badge b-neutral">RELIABILITY {upperWords(m.reliability)}</span></p>
      <p className="small muted">Eligible outcomes: {m.eligible} · sources: {sourceLine(m.dataSources)} · wins {m.wins}, losses {m.losses}, breakeven {m.breakeven}{m.periodStart ? <> · {formatIst(m.periodStart)} to {formatIst(m.periodEnd)}</> : null}. Rates are fractions of outcomes (1 means all), not percentages. A small sample is not reliable evidence.</p>
      <div className="grid g3" style={{ gap: 12 }}>
        <MetricCard label="Win rate" metric={m.winRate} /><MetricCard label="Loss rate" metric={m.lossRate} /><MetricCard label="Expectancy (R)" metric={m.expectancyR} unit="R" />
        <MetricCard label="Profit factor" metric={m.profitFactor} /><MetricCard label="Average win" metric={m.avgWin} kind="money" /><MetricCard label="Average loss" metric={m.avgLoss} kind="money" />
        <MetricCard label="Payoff ratio" metric={m.payoffRatio} /><MetricCard label="Expectancy (money)" metric={m.expectancyMoney} kind="money" /><MetricCard label="Max drawdown (cumulative net P&L)" metric={m.maxDrawdown} kind="money" />
        <MetricCard label="Cost impact" metric={m.costImpact} unit="% of gross" /><MetricCard label="Slippage" metric={m.slippage} kind="money" />
        <div className="panel flat" role="group" aria-label="Mean R multiple"><div className="small muted">Mean R multiple</div><div className="num" style={{ fontSize: 22 }}>{m.rMultiple.mean === null ? <span className="muted" style={{ fontSize: 16 }}>{NOT_COMPUTED}</span> : formatDecimal(m.rMultiple.mean)}</div><div className="xs">n = <span className="num">{m.rMultiple.n}</span></div><div className="xs muted">{m.rMultiple.definition}</div></div>
      </div>
      <dl className="kv" style={{ margin: "14px 0 6px" }}>
        <dt>Gross P&L</dt><dd><PnlValue value={m.grossPnl} /></dd><dt>Costs</dt><dd className="num">{formatMoney(m.costs)}</dd><dt>Net P&L</dt><dd><PnlValue value={m.netPnl} /></dd>
        <dt>Holding time (seconds)</dt><dd className="num">{m.holdingSeconds.n === 0 ? NOT_COMPUTED : `median ${formatDecimal(m.holdingSeconds.median)} · min ${formatDecimal(m.holdingSeconds.min)} · max ${formatDecimal(m.holdingSeconds.max)} (n ${m.holdingSeconds.n})`}</dd>
      </dl>
      <Unavailable title="Max drawdown as a percentage">{m.maxDrawdownPct.reason}</Unavailable>
    </div>
  );
}
