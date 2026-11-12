"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { CANDIDATE_LIFECYCLE_STATES, CANDIDATE_PAGE_SIZE, CANDIDATE_SOURCES, type CandidateView } from "@twins/api-contracts";
import { useCandidates } from "@/api/hooks";
import { deriveState } from "@/state/dataState";
import { formatIst } from "@/lib/format";
import { Banner, Button, PageHead } from "@/ui/primitives";
import { DataRegion } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { CandidateStateBadge, DataSourceBadge, LoadedAt, Section, SOURCE_LABEL, SourceBadge, instrumentLabel, label } from "@/components/desk/parts";
import { AgentRegistry } from "./AgentRegistry";

const pageOf = (v: string | null): number => { const n = /^\d{1,4}$/.test(v ?? "") ? Number(v) : 1; return n >= 1 ? n : 1; };

/**
 * Research candidate explorer. Source, state and paging are SERVER-side (the candidate API's own parameters). The list carries no research result, so no assessment is shown here and no package is requested per row:
 * a package is requested only when a candidate is opened.
 */
export function ResearchExplorer() {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  const source = CANDIDATE_SOURCES.find((s) => s === params.get("source")), state = CANDIDATE_LIFECYCLE_STATES.find((s) => s === params.get("state")), page = pageOf(params.get("page"));
  const [text, setText] = useState("");
  const set = (k: string, v: string | null): void => { const n = new URLSearchParams(params.toString()); if (v) n.set(k, v); else n.delete(k); if (k !== "page") n.delete("page"); const s = n.toString(); router.replace(s ? `${path}?${s}` : path); };
  const q = useCandidates({ ...(source ? { source } : {}), ...(state ? { state } : {}), limit: CANDIDATE_PAGE_SIZE, offset: (page - 1) * CANDIDATE_PAGE_SIZE });
  const all = useMemo(() => q.data?.candidates ?? [], [q.data]), needle = text.trim().toLowerCase();
  const rows = useMemo(() => (needle ? all.filter((c) => `${c.underlying} ${c.setup ?? ""}`.toLowerCase().includes(needle)) : all), [all, needle]);
  const dataState = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: all.length === 0 });
  return (
    <>
      <PageHead eyebrow="Understand" title="Research"><p>Open a candidate to read its research package: what each research agent concluded, what is missing, and where the evidence came from. Research is evidence, never an approval.</p></PageHead>
      <div className="grid">
        <Banner tone="info" label="Evidence only">A research assessment is not a decision and cannot approve, reject or execute anything. Assessments are not shown in this list: the candidate API does not return them, so each package is read when you open the candidate.</Banner>
        <Section id="rc-h" title="Candidates" aside={<LoadedAt updatedAt={q.dataUpdatedAt} />}>
          <form style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "end", marginBottom: 14 }} onSubmit={(e) => e.preventDefault()} aria-label="Candidate filters">
            <div className="field"><label htmlFor="rf-source">Origin</label><select id="rf-source" className="input" value={source ?? ""} onChange={(e) => set("source", e.target.value || null)}><option value="">Both origins</option>{CANDIDATE_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></div>
            <div className="field"><label htmlFor="rf-state">Lifecycle state</label><select id="rf-state" className="input" value={state ?? ""} onChange={(e) => set("state", e.target.value || null)}><option value="">Any state</option>{CANDIDATE_LIFECYCLE_STATES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div>
            <div className="field"><label htmlFor="rf-text">Find in this page</label><input id="rf-text" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Instrument or setup" autoComplete="off" maxLength={40} /><div className="xs muted">Narrows the {all.length} loaded rows only; it does not search the backend.</div></div>
            {(source || state || text) && <Button onClick={() => { setText(""); router.replace(path); }}>Clear filters</Button>}
          </form>
          <DataRegion state={dataState} what="candidates" emptyHint={source || state ? "No candidates match these filters. Clear a filter to see more." : "No candidates have been found yet, so there is nothing to research."} onRetry={() => void q.refetch()}>
            {rows.length === 0 ? <p className="muted" role="status">No loaded row matches “{text}”. Clear the text filter, or move to another page.</p> : (
              <DataTable<CandidateView> wide caption="Research candidates" rows={rows} rowKey={(c) => c.id} columns={[
                { key: "c", header: "Candidate", render: (c) => <><Link href={`/research/${c.id}`}><b>{instrumentLabel(c)}</b></Link><span className="xs muted only-phone">{SOURCE_LABEL[c.source]} · {label(c.state)}</span></> }, { key: "s", header: "Origin", render: (c) => <SourceBadge source={c.source} /> },
                { key: "st", header: "Lifecycle state", render: (c) => <CandidateStateBadge state={c.state} /> }, { key: "a", header: "Research attempts", align: "right", render: (c) => <span className="num">{c.researchAttempts}</span> },
                { key: "d", header: "Data", render: (c) => <DataSourceBadge dataSource={c.dataSource} /> }, { key: "t", header: "Found", render: (c) => formatIst(c.createdAt) },
                { key: "o", header: "Open", render: (c) => <Link href={`/research/${c.id}`} aria-label={`Open research workspace for ${instrumentLabel(c)}`}>Open</Link> },
              ]} />
            )}
            <nav aria-label="Candidate pages" style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
              <Button disabled={page <= 1} onClick={() => set("page", page <= 2 ? null : String(page - 1))}>Previous</Button><span className="small" aria-live="polite">Page {page}</span><Button disabled={all.length < CANDIDATE_PAGE_SIZE} onClick={() => set("page", String(page + 1))}>Next</Button>
            </nav>
          </DataRegion>
        </Section>
        <AgentRegistry />
      </div>
    </>
  );
}
