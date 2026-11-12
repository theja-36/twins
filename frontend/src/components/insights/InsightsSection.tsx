"use client";
import { useState } from "react";
import { INSIGHT_KINDS, INSIGHT_RECOMMENDATION_REVIEW } from "@twins/api-contracts";
import { useInsights } from "@/api/analyticsHooks";
import type { InsightRowData } from "@/api/analyticsTypes";
import { formatIst } from "@/lib/format";
import { Banner } from "@/ui/primitives";
import { GenericRows, Section, SectionFrame, upperWords } from "./shared";

const fixtureBacked = (p: unknown): boolean => typeof p === "object" && p !== null && (p as { fixtureBacked?: unknown }).fixtureBacked === true;

/** One insight, as plain text. The recommendation is REVIEW or none: there is no action to take, so no button exists. */
function InsightCard({ i }: { i: InsightRowData }) {
  const review = i.recommendation === INSIGHT_RECOMMENDATION_REVIEW;
  return (
    <article className="panel flat" aria-label={`${upperWords(i.kind)} insight: ${i.subject}`} style={{ minWidth: 0 }}>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "0 0 6px" }}>
        <span className="badge b-neutral">{upperWords(i.kind)}</span><span className="badge b-neutral">{i.severity}</span><span className="badge b-neutral">RELIABILITY {upperWords(i.reliability)}</span>
        {fixtureBacked(i.provenance) && <span className="badge b-fix">FIXTURE-BACKED DATA</span>}
        {review ? <span className="badge b-dec" title="A human should look at this. Nothing is changed automatically.">FOR HUMAN REVIEW</span> : <span className="badge b-na">NO RECOMMENDATION</span>}
      </p>
      <h3 style={{ margin: "0 0 4px" }}>{i.subject}</h3>
      <p style={{ margin: "0 0 8px" }}>{i.statement}</p>
      <p className="xs muted" style={{ margin: 0 }}>Scope {upperWords(i.scope)} · based on {i.outcomeCount} outcomes{i.periodStart ? ` · ${formatIst(i.periodStart)} to ${formatIst(i.periodEnd)}` : ""} · generated {formatIst(i.createdAt)}</p>
      <p className="xs muted" style={{ margin: "2px 0 0" }}>Method: {i.method} · {i.algorithmVersion}</p>
      {i.limitations.length > 0 && <details style={{ marginTop: 6 }}><summary className="small">Limitations ({i.limitations.length})</summary><ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{i.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>}
      <details style={{ marginTop: 6 }}><summary className="small">Recorded provenance, evidence and metrics (unverified structure, shown as text)</summary>
        <GenericRows rows={[i.provenance, i.evidenceRefs, i.metrics]} caption="Insight details" />
      </details>
    </article>
  );
}

export function InsightsSection() {
  const [kind, setKind] = useState(""), q = useInsights({ ...(kind ? { kind } : {}), limit: 100 }), env = q.data, rows = env?.data ?? [];
  return (
    <>
      <Banner tone="info" label="Review only">An insight can ask a person to look at something. It changes no strategy, weight, threshold, risk limit, size, capital, stop, approval, order, trading mode, kill switch or permission, and this page has no control that could.</Banner>
      <div className="field" style={{ maxWidth: 320, margin: "12px 0" }}><label htmlFor="ik">Insight kind</label><select id="ik" className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option>{INSIGHT_KINDS.map((k) => <option key={k} value={k}>{upperWords(k)}</option>)}</select></div>
      <SectionFrame what="insights" q={q} env={env} emptyHint={kind ? "No insight of this kind exists. Choose another kind." : "No insight has been generated yet. Insights are written by the learning cycle after outcomes exist; a read of this page never creates them."}>
        <Section id="is-h" title="Generated insights">
          <p className="small muted">{rows.length} insights (up to 100 shown, in the order returned). Statements are plain text from the backend; they are not instructions.</p>
          {rows.length === 0 ? <p className="muted" role="status">No insight of this kind.</p> : <div className="grid" style={{ gap: 12 }}>{rows.map((i) => <InsightCard key={i.id} i={i} />)}</div>}
        </Section>
      </SectionFrame>
    </>
  );
}
