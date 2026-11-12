"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ProvenanceBadge } from "@/ui/badges";
import { Banner, PageHead } from "@/ui/primitives";
import { SectionMount } from "@/components/insights/guard";
import { OutcomesSection } from "@/components/insights/OutcomesSection";
import { OverviewSection, StrategiesSection } from "@/components/insights/PerformanceSections";
import { DecisionsSection } from "@/components/insights/PipelineSections";

/** The four recorded-result sections of Learning Insights, reused as they are (same components, same strict schemas, same FIXTURE labels): nothing is recalculated or duplicated here. */
export const PERFORMANCE_SECTIONS = [
  { id: "overview", label: "Overview", Body: OverviewSection }, { id: "outcomes", label: "Outcomes", Body: OutcomesSection },
  { id: "strategies", label: "Strategies", Body: StrategiesSection }, { id: "decisions", label: "Decisions", Body: DecisionsSection },
] as const;

/**
 * Outcomes & Performance (read-only, PAPER): the recorded results, one section at a time so opening the page makes ONE analytics request. The analytics routes are per user, not per account (the backend ignores `accountId`), and outcomes carry no decision id,
 * so no result is linked to a decision here.
 */
export function PerformanceScreen() {
  const path = usePathname(), params = useSearchParams(), current = PERFORMANCE_SECTIONS.find((s) => s.id === params.get("section")) ?? PERFORMANCE_SECTIONS[0], Body = current.Body;
  return (
    <>
      <PageHead eyebrow="Review" title="Outcomes & performance"><p>Recorded results of your PAPER trading. Read-only: nothing here changes a setting, a strategy or a trade.</p></PageHead>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "0 0 12px" }}><ProvenanceBadge kind="PAPER" /><span className="badge b-na">LIVE PERFORMANCE UNAVAILABLE</span></p>
      <Banner label="PAPER only">Every figure comes from simulated paper trading, much of it on synthetic fixture data, and is labelled where it is. None of it is real-money or live-market performance. Results are for your whole user, not for one account, and an outcome is not linked to a decision here.</Banner>
      <nav aria-label="Performance sections" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "14px 0" }}>
        {PERFORMANCE_SECTIONS.map((s) => <Link key={s.id} href={s.id === "overview" ? path : `${path}?section=${s.id}`} className={`btn ${s.id === current.id ? "primary" : ""}`} aria-current={s.id === current.id ? "page" : undefined} scroll={false}>{s.label}</Link>)}
      </nav>
      <SectionMount><Body /></SectionMount>
      <p className="small muted">More analysis (channels, agents, drift, data quality, calibration, insights) is in <Link href="/insights">Learning Insights</Link>. Positions and orders are on <Link href="/paper">Paper Trading</Link>.</p>
    </>
  );
}
