"use client";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { CANDIDATE_LIFECYCLE_STATES, CANDIDATE_PAGE_SIZE, CANDIDATE_SOURCES, type CandidateView } from "@twins/api-contracts";
import { useCandidates, useScans } from "@/api/hooks";
import { deriveState } from "@/state/dataState";
import { formatIst } from "@/lib/format";
import { Banner, Button, PageHead } from "@/ui/primitives";
import { DataRegion } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { CandidateLink, CandidateStateBadge, DataSourceBadge, LoadedAt, Section, SOURCE_LABEL, SourceBadge, entryText, label, num, targetsText } from "./parts";

const pageOf = (v: string | null): number => { const n = /^\d{1,4}$/.test(v ?? "") ? Number(v) : 1; return n >= 1 ? n : 1; };

/** Opportunity Discovery: candidates from BOTH origins, always labelled. Source and state filters and paging are SERVER-side (the API's own parameters); the text filter only narrows the rows already loaded and says so. */
export function OpportunitiesScreen() {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  const source = CANDIDATE_SOURCES.find((s) => s === params.get("source")), state = CANDIDATE_LIFECYCLE_STATES.find((s) => s === params.get("state")), page = pageOf(params.get("page"));
  const [text, setText] = useState("");
  const set = (k: string, v: string | null): void => { const n = new URLSearchParams(params.toString()); if (v) n.set(k, v); else n.delete(k); if (k !== "page") n.delete("page"); const s = n.toString(); router.replace(s ? `${path}?${s}` : path); };
  const q = useCandidates({ ...(source ? { source } : {}), ...(state ? { state } : {}), limit: CANDIDATE_PAGE_SIZE, offset: (page - 1) * CANDIDATE_PAGE_SIZE });
  const scans = useScans(1);
  const all = useMemo(() => q.data?.candidates ?? [], [q.data]), needle = text.trim().toLowerCase();
  const rows = useMemo(() => (needle ? all.filter((c) => `${c.underlying} ${c.setup ?? ""}`.toLowerCase().includes(needle)) : all), [all, needle]);
  const dataState = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: all.length === 0 });
  const lastScan = scans.data?.scans[0];
  return (
    <>
      <PageHead eyebrow="Decide" title="Opportunity discovery"><p>Candidates are proposals for research, found by the independent opportunity engine or parsed from Telegram. None carries an order, an approval or a size.</p></PageHead>
      <div className="grid">
        <Banner tone="info" label="How to read this">Rank, entry, stop and targets are shown exactly as recorded. This screen calculates no score, reward-to-risk, size or eligibility, and a candidate is not a recommendation.</Banner>
        {lastScan && lastScan.dataSource === "FIXTURE" && <Banner label="FIXTURE">The latest scan ran on synthetic fixture data, not a market. Candidates from it are not live opportunities.</Banner>}
        <Section id="cand-h" title="Candidates" aside={<LoadedAt updatedAt={q.dataUpdatedAt} />}>
          <form className="drow" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "end", marginBottom: 14 }} onSubmit={(e) => e.preventDefault()} aria-label="Candidate filters">
            <div className="field"><label htmlFor="f-source">Origin</label>
              <select id="f-source" className="input" value={source ?? ""} onChange={(e) => set("source", e.target.value || null)}><option value="">Both origins</option>{CANDIDATE_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></div>
            <div className="field"><label htmlFor="f-state">Lifecycle state</label>
              <select id="f-state" className="input" value={state ?? ""} onChange={(e) => set("state", e.target.value || null)}><option value="">Any state</option>{CANDIDATE_LIFECYCLE_STATES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div>
            <div className="field"><label htmlFor="f-text">Find in this page</label>
              <input id="f-text" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Instrument or setup" autoComplete="off" maxLength={40} /><div className="xs muted">Narrows the {all.length} loaded rows only; it does not search the backend.</div></div>
            {(source || state || text) && <Button onClick={() => { setText(""); const p = path; router.replace(p); }}>Clear filters</Button>}
          </form>
          <DataRegion state={dataState} what="candidates" emptyHint={source || state ? "No candidates match these filters. Clear a filter to see more." : "No candidates have been found yet. The scanner records candidates when a scan finds a setup, and Telegram candidates appear when a channel claim qualifies."} onRetry={() => void q.refetch()}>
            {rows.length === 0 ? <p className="muted" role="status">No loaded row matches “{text}”. Clear the text filter, or move to another page.</p> : (
              <DataTable<CandidateView> caption="Candidates" rows={rows} rowKey={(c) => c.id} columns={[
                { key: "inst", header: "Instrument", render: (c) => <CandidateLink c={c} /> },
                { key: "side", header: "Side", render: (c) => c.side },
                { key: "src", header: "Origin", render: (c) => <SourceBadge source={c.source} /> },
                { key: "setup", header: "Setup", hideOnMobile: true, render: (c) => c.setup ? label(c.setup) : <span className="muted">not provided</span> },
                { key: "entry", header: "Entry", hideOnMobile: true, align: "right", render: (c) => <span className="num">{entryText(c)}</span> },
                { key: "stop", header: "Stop-loss", hideOnMobile: true, align: "right", render: (c) => <span className="num">{num(c.stopLoss)}</span> },
                { key: "tg", header: "Targets", hideOnMobile: true, align: "right", render: (c) => <span className="num">{targetsText(c.targets)}</span> },
                { key: "rank", header: "Rank (backend)", hideOnMobile: true, align: "right", render: (c) => <span className="num">{num(c.rankScore)}</span> },
                { key: "state", header: "State", render: (c) => <CandidateStateBadge state={c.state} /> },
                { key: "data", header: "Data", render: (c) => <DataSourceBadge dataSource={c.dataSource} /> },
                { key: "seen", header: "Found", hideOnMobile: true, render: (c) => <span className="xs">{formatIst(c.createdAt)}</span> },
              ]} />
            )}
            <nav aria-label="Candidate pages" style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
              <Button disabled={page <= 1} onClick={() => set("page", page <= 2 ? null : String(page - 1))}>Previous</Button>
              <span className="small" aria-live="polite">Page {page}</span>
              <Button disabled={all.length < CANDIDATE_PAGE_SIZE} onClick={() => set("page", String(page + 1))}>Next</Button>
            </nav>
          </DataRegion>
        </Section>
        <p className="small muted">Decision status and risk checks belong to a decision, not a candidate: open a candidate to see the decisions linked to it. Rows are ordered by the backend.</p>
      </div>
    </>
  );
}
