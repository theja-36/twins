"use client";
/**
 * Shared presentation pieces for the Stage 09.3A trader screens. Everything here DISPLAYS what the backend returned: no score, ratio, size, eligibility or money is calculated,
 * and a value the backend did not supply is shown as "not provided", never defaulted.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import type { CandidateView } from "@twins/api-contracts";
import { formatDecimal, formatIst } from "@/lib/format";
import { ProvenanceBadge } from "@/ui/badges";

export const SOURCE_LABEL: Record<string, string> = { TELEGRAM: "Telegram-originated", INDEPENDENT: "Independently discovered" };
/** The two origins are distinguished by TEXT and by shape (outlined vs filled), never by colour alone. */
export function SourceBadge({ source }: { source: string }) {
  return <span className={`badge ${source === "TELEGRAM" ? "b-ord" : "b-dec"}`} title={source === "TELEGRAM" ? "Parsed from a Telegram channel message" : "Found by the independent opportunity engine"}>{SOURCE_LABEL[source] ?? `UNKNOWN (${source})`}</span>;
}
export const label = (v: string): string => v.replaceAll("_", " ");
/** A candidate's LIFECYCLE state (a different domain from decision states, so a neutral badge). */
export function CandidateStateBadge({ state }: { state: string }) { return <span className="badge b-neutral">{label(state)}</span>; }
/** Where the scan's inputs came from. FIXTURE is hatched; LIVE is never shown as live (see ProvenanceBadge). */
export function DataSourceBadge({ dataSource }: { dataSource: string }) { return dataSource === "HISTORICAL" ? <span className="badge b-neutral" title="Built on historical data">HISTORICAL</span> : <ProvenanceBadge kind={dataSource} />; }
export function LoadedAt({ updatedAt }: { updatedAt: number }) { return updatedAt > 0 ? <span className="xs muted">Loaded {formatIst(new Date(updatedAt).toISOString())}</span> : null; }
export const num = (v: number | null | undefined): string => (v === null || v === undefined ? "not provided" : formatDecimal(v));

export function instrumentLabel(c: Pick<CandidateView, "underlying" | "strike" | "optionType" | "expiry">): string {
  const opt = c.strike !== null || c.optionType ? ` ${c.strike !== null ? formatDecimal(c.strike) : ""}${c.optionType ? ` ${c.optionType}` : ""}`.trimEnd() : "";
  return `${c.underlying}${opt}${c.expiry ? ` · exp ${c.expiry}` : ""}`;
}
/** The entry as recorded: its kind plus the band, exactly as supplied. */
export function entryText(c: Pick<CandidateView, "entryKind" | "entryLow" | "entryHigh">): string {
  const { entryLow: lo, entryHigh: hi } = c;
  if (lo === null && hi === null) return c.entryKind;
  if (lo !== null && hi !== null && lo !== hi) return `${c.entryKind} ${formatDecimal(lo)}–${formatDecimal(hi)}`;
  return `${c.entryKind} ${formatDecimal(lo ?? hi)}`;
}
export const targetsText = (t: readonly number[]): string => (t.length ? t.map((x) => formatDecimal(x)).join(" · ") : "not provided");
export function CandidateLink({ c }: { c: Pick<CandidateView, "id" | "underlying" | "strike" | "optionType" | "expiry"> }) { return <Link href={`/opportunities/${c.id}`}><b>{instrumentLabel(c)}</b></Link>; }

/** One recorded evidence item: its kind and its fields as plain text. Inner shapes are not contract-guaranteed, so nothing is interpreted. */
function EvidenceItem({ item }: { item: unknown }) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return <li><code>{String(JSON.stringify(item)).slice(0, 300)}</code></li>;
  const o = item as Record<string, unknown>, kind = typeof o["kind"] === "string" ? o["kind"] : "evidence", rest = Object.entries(o).filter(([k]) => k !== "kind").slice(0, 30);
  return (
    <li style={{ marginBottom: 12 }}>
      <b>{label(kind)}</b>
      {rest.length === 0 ? <p className="small muted" style={{ margin: "4px 0 0" }}>No fields recorded.</p> : (
        <dl className="kv" style={{ marginTop: 6 }}>
          {rest.map(([k, v]) => (<div key={k} style={{ display: "contents" }}><dt>{label(k)}</dt><dd>{typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? <span className="num">{String(v)}</span> : v === null ? <span className="muted">not provided</span> : <code>{JSON.stringify(v).slice(0, 300)}</code>}</dd></div>))}
        </dl>
      )}
    </li>
  );
}
export const kindOf = (e: unknown): string => (typeof e === "object" && e !== null && typeof (e as { kind?: unknown }).kind === "string" ? (e as { kind: string }).kind : "");
export function EvidenceList({ items }: { items: readonly unknown[] }) { return <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{items.slice(0, 50).map((e, i) => <EvidenceItem key={i} item={e} />)}</ul>; }
export function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (<section className="panel" aria-labelledby={id}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline", marginBottom: 10 }}><h2 id={id} style={{ margin: 0 }}>{title}</h2>{aside}</div>{children}</section>);
}
