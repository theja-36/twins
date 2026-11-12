"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Banner, PageHead } from "@/ui/primitives";
import { ProvenanceBadge } from "@/ui/badges";
import { SectionMount } from "./guard";
import { OverviewSection, StrategiesSection } from "./PerformanceSections";
import { AgentsSection, ChannelsSection, DecisionsSection, IndependentSection } from "./PipelineSections";
import { CalibrationSection, DataQualitySection, DriftSection } from "./ReliabilitySections";
import { OutcomesSection } from "./OutcomesSection";
import { InsightsSection } from "./InsightsSection";

export const SECTIONS = [
  { id: "overview", label: "Overview", Body: OverviewSection }, { id: "strategies", label: "Strategies", Body: StrategiesSection }, { id: "channels", label: "Channels", Body: ChannelsSection },
  { id: "independent", label: "Independent", Body: IndependentSection }, { id: "agents", label: "Agents", Body: AgentsSection }, { id: "decisions", label: "Decisions", Body: DecisionsSection },
  { id: "drift", label: "Drift", Body: DriftSection }, { id: "data-quality", label: "Data quality", Body: DataQualitySection }, { id: "calibration", label: "Calibration", Body: CalibrationSection },
  { id: "outcomes", label: "Outcomes", Body: OutcomesSection }, { id: "insights", label: "Insights", Body: InsightsSection },
] as const;

/** Learning & Insights: one section at a time, so opening the page makes ONE analytics request (each section is its own read; switching back reuses the cache). Private to the trader; the server page never mounts this for an administrator. */
export function InsightsScreen() {
  const path = usePathname(), params = useSearchParams(), current = SECTIONS.find((s) => s.id === params.get("section")) ?? SECTIONS[0];
  const Body = current.Body;
  return (
    <>
      <PageHead eyebrow="Understand" title="Learning & Insights"><p>Understand performance, research quality, outcomes and analytical reliability across your PAPER trading activity.</p></PageHead>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "0 0 12px" }}><ProvenanceBadge kind="PAPER" /><span className="badge b-na">LIVE ANALYTICS UNAVAILABLE</span></p>
      <Banner label="PAPER only">Every figure here comes from simulated paper trading, much of it on synthetic fixture data. None of it is live-market performance, and nothing on this page changes any setting.</Banner>
      <nav aria-label="Analytics sections" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "14px 0" }}>
        {SECTIONS.map((s) => <Link key={s.id} href={s.id === "overview" ? path : `${path}?section=${s.id}`} className={`btn ${s.id === current.id ? "primary" : ""}`} aria-current={s.id === current.id ? "page" : undefined} scroll={false}>{s.label}</Link>)}
      </nav>
      <SectionMount><Body /></SectionMount>
    </>
  );
}
