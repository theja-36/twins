"use client";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { Role } from "@twins/api-contracts";
import { PLAYBOOK_PAGE_SIZE, usePlaybooks } from "@/api/strategyHooks";
import type { PlaybookSummaryT } from "@/api/strategyTypes";
import { deriveState } from "@/state/dataState";
import { formatIst } from "@/lib/format";
import { Banner, Button, PageHead } from "@/ui/primitives";
import { DataRegion } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { LoadedAt, Section, label } from "@/components/desk/parts";

const pageOf = (v: string | null): number => { const n = /^\d{1,4}$/.test(v ?? "") ? Number(v) : 1; return n >= 1 ? n : 1; };
const ver = (v: number | null): string => (v === null ? "none" : `v${v}`);

/** Playbooks Explorer: versioned strategy playbooks as the backend holds them. Read-only; nothing is created, sample-filled or activated here, and an empty list is shown as empty. Paging uses the API's own limit and offset. */
export function PlaybooksScreen({ role }: { role: Role }) {
  const router = useRouter(), path = usePathname(), params = useSearchParams(), page = pageOf(params.get("page"));
  const q = usePlaybooks({ limit: PLAYBOOK_PAGE_SIZE, offset: (page - 1) * PLAYBOOK_PAGE_SIZE }), rows = q.data?.playbooks ?? [];
  const st = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: rows.length === 0 });
  const go = (p: number): void => router.replace(p <= 1 ? path : `${path}?page=${p}`);
  return (
    <>
      <PageHead eyebrow="Understand" title="Playbooks"><p>Versioned strategy playbooks and where each one stands. Read-only: activation, retirement and editing are never done here.</p></PageHead>
      <div className="grid">
        <Banner tone="info" label="Read-only">A playbook state describes a record. It does not enable, disable or size anything, and live trading is disabled. Nothing is generated or filled in when no playbook exists.</Banner>
        <Section id="pb-h" title="Playbooks" aside={<LoadedAt updatedAt={q.dataUpdatedAt} />}>
          <DataRegion state={st} what="playbooks" emptyHint={page > 1 ? "No playbooks on this page. Go back to the first page." : "No playbook has been recorded. Playbooks are created by an owner-run process outside this application; none is created or sample-filled here."} onRetry={() => void q.refetch()}>
            <DataTable<PlaybookSummaryT> wide caption="Playbooks" rows={rows} rowKey={(p) => p.id} columns={[
              { key: "n", header: "Playbook", wrap: true, render: (p) => <><Link href={`/strategies/${p.id}`}><b>{p.name}</b></Link><span className="xs muted only-phone">{label(p.sourceKind)} · {p.versions} {p.versions === 1 ? "version" : "versions"}</span></> },
              { key: "k", header: "Kind", hideOnMobile: true, render: (p) => <span className="badge b-neutral">{label(p.sourceKind)}</span> },
              { key: "v", header: "Versions", align: "right", hideOnMobile: true, render: (p) => <span className="num">{p.versions}</span> },
              { key: "a", header: "Active version", hideOnMobile: true, render: (p) => ver(p.activeVersion) },
              { key: "l", header: "Latest version", hideOnMobile: true, render: (p) => ver(p.latestVersion) },
              { key: "c", header: "Created", render: (p) => <span className="xs">{formatIst(p.createdAt)}</span> },
            ]} />
            <nav aria-label="Playbook pages" style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
              <Button disabled={page <= 1} onClick={() => go(page - 1)}>Previous</Button>
              <span className="small" aria-live="polite">Page {page}</span>
              <Button disabled={rows.length < PLAYBOOK_PAGE_SIZE} onClick={() => go(page + 1)}>Next</Button>
            </nav>
          </DataRegion>
        </Section>
        <p className="small muted">{role === "TRADER" ? <>Strategy performance (fixture-backed, with sample sizes) is in <Link href="/insights">Learning Insights</Link>.</> : "Strategy performance is private to a trading account and is not shown here."}</p>
      </div>
    </>
  );
}
