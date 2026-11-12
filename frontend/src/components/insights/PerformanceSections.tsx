"use client";
import { useState } from "react";
import { useOverview, useStrategies } from "@/api/analyticsHooks";
import type { Metrics } from "@/api/analyticsTypes";
import { formatDecimal } from "@/lib/format";
import { PnlValue } from "@/ui/badges";
import { DataTable } from "@/ui/table";
import { FixtureLabel, NOT_COMPUTED, PerformanceGrid, Section, SectionFrame, Unavailable, upperWords } from "./shared";

/** The three outcome groups the backend reports. "Validated" means NOT fixture-backed; it is still PAPER and never live. */
const DATASETS = [["all", "All paper outcomes", "Every eligible paper outcome, fixture-backed or not."], ["validatedOnly", "Validated only (not fixture-backed)", "Eligible outcomes that are not fixture-backed. This is still PAPER: it is never live-market performance."], ["fixtureOnly", "Fixture-backed only", "Outcomes built on synthetic fixture data. Illustrative, not market evidence."]] as const;

export function OverviewSection() {
  const q = useOverview(), env = q.data, [pick, setPick] = useState<(typeof DATASETS)[number][0]>("all");
  const m = env?.data[pick];
  return (
    <SectionFrame what="performance overview" q={q} env={env}>
      <Section id="ov-h" title="Performance overview">
        <div role="group" aria-label="Outcome group" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {DATASETS.map(([k, label]) => <button key={k} type="button" className={`btn ${pick === k ? "primary" : ""}`} aria-pressed={pick === k} onClick={() => setPick(k)}>{label}</button>)}
        </div>
        <p className="small muted">{DATASETS.find((d) => d[0] === pick)?.[2]}</p>
        {m ? (m.eligible === 0 ? <Unavailable title="No eligible outcomes in this group">The backend counts no eligible outcome here, so no figure is computed. Metrics stay “{NOT_COMPUTED}” rather than showing zero.</Unavailable> : <PerformanceGrid m={m} title={DATASETS.find((d) => d[0] === pick)?.[1] ?? ""} />) : <Unavailable title="Group not in the response">This outcome group was not returned.</Unavailable>}
      </Section>
    </SectionFrame>
  );
}

/** Strategy dimensions as the backend names them (api-contracts STRATEGY_DATA_KEYS). Order is the backend's: by sample size, never ranked by result. */
const DIMENSIONS: ReadonlyArray<[string, string]> = [["byStrategy", "Strategy (setup)"], ["byVersion", "Strategy version"], ["byInstrument", "Instrument"], ["byTimeframe", "Timeframe"], ["byRegime", "Market regime"], ["bySignalType", "Signal type"], ["byExitReason", "Exit reason"], ["byStopBehaviour", "Stop behaviour"], ["byTargetBehaviour", "Target behaviour"], ["byStopMoved", "Stop moved"], ["byConfidenceBand", "Confidence band"], ["byRiskVerdict", "Risk verdict"], ["byPlannedRewardToRisk", "Planned reward-to-risk band"], ["byDecisionOutcome", "Decision outcome"], ["bySignalPattern", "Signal pattern"]];
const expectancy = (m: Metrics): string => (m.expectancyR.value === null ? NOT_COMPUTED : formatDecimal(m.expectancyR.value));

export function StrategiesSection() {
  const q = useStrategies(), env = q.data, [dim, setDim] = useState("byStrategy"), v = env?.data[dim as keyof NonNullable<typeof env>["data"]];
  return (
    <SectionFrame what="strategy performance" q={q} env={env}>
      <Section id="st-h" title="Performance by dimension">
        <div className="field" style={{ maxWidth: 320 }}><label htmlFor="dim">Dimension</label><select id="dim" className="input" value={dim} onChange={(e) => setDim(e.target.value)}>{DIMENSIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <p className="small muted">Groups are ordered by sample size as the backend returns them. They are not ranked by result: a group with few outcomes says little. This is performance of past paper outcomes by group, not an evaluation of any candidate or decision.</p>
        {v === undefined ? <Unavailable title="Dimension not in the response">The backend did not return this dimension.</Unavailable>
          : !Array.isArray(v) ? <Unavailable title={`${DIMENSIONS.find((d) => d[0] === dim)?.[1] ?? dim}: not available`}>{v.reason} (depends on: {v.dependsOn})</Unavailable>
          : v.length === 0 ? <Unavailable title="No groups">No eligible outcome falls in this dimension yet.</Unavailable>
          : <DataTable caption={`Performance by ${DIMENSIONS.find((d) => d[0] === dim)?.[1] ?? dim}`} rows={v} rowKey={(s) => s.key} wide columns={[
            { key: "k", header: "Group", render: (s) => <b>{upperWords(s.key)}</b> }, { key: "n", header: "Eligible (n)", align: "right", render: (s) => <span className="num">{s.metrics.eligible}</span> },
            { key: "rel", header: "Reliability", render: (s) => upperWords(s.metrics.reliability) }, { key: "fx", header: "Data", render: (s) => <FixtureLabel dataSources={s.metrics.dataSources} /> },
            { key: "w", header: "Wins / losses", hideOnMobile: true, align: "right", render: (s) => <span className="num">{s.metrics.wins} / {s.metrics.losses}</span> },
            { key: "wr", header: "Win rate (fraction)", hideOnMobile: true, align: "right", render: (s) => <><span className="num">{s.metrics.winRate.value === null ? NOT_COMPUTED : formatDecimal(s.metrics.winRate.value)}</span>{s.metrics.winRate.interval ? <span className="xs muted"> [{formatDecimal(s.metrics.winRate.interval.lower)}, {formatDecimal(s.metrics.winRate.interval.upper)}]</span> : null}</> },
            { key: "ex", header: "Expectancy (R)", hideOnMobile: true, align: "right", render: (s) => <span className="num">{expectancy(s.metrics)}</span> }, { key: "net", header: "Net P&L", align: "right", render: (s) => <PnlValue value={s.metrics.netPnl} /> },
            { key: "note", header: "Backend note", hideOnMobile: true, wrap: true, render: (s) => <span className="xs">{s.metrics.expectancyR.note ?? ""}</span> },
          ]} />}
      </Section>
    </SectionFrame>
  );
}
