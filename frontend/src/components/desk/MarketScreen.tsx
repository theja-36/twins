"use client";
import Link from "next/link";
import { useCandidates, useChannels, useScans } from "@/api/hooks";
import { deriveState } from "@/state/dataState";
import { formatIst } from "@/lib/format";
import { AvailabilityBadge } from "@/ui/badges";
import { Banner, PageHead } from "@/ui/primitives";
import { DataRegion } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { DataSourceBadge, LoadedAt, Section, SOURCE_LABEL, label } from "./parts";

/** What the platform genuinely cannot show today, each with its reason. Nothing here is a placeholder for data that exists elsewhere. */
const NOT_AVAILABLE: ReadonlyArray<[string, string]> = [
  ["Market regime", "No trader-authorised route provides a regime classification (G-16)."],
  ["Live quotes and prices", "No live market feed is connected (G-20). No price on this screen is a market price."],
  ["News feed", "The platform stores no news items a trader can read; Telegram claims are parsed signals, not news."],
  ["Technical indicators", "Not served as a standalone feed. Any technical reading appears only inside a candidate’s recorded evidence."],
  ["Options chain, Greeks, implied volatility", "No options-data route exists."],
  ["Economic events calendar", "No events source is connected."],
  ["Instrument reference data", "No instrument master route exists; instruments appear only as named on a candidate."],
];
const FRESH_BAD = new Set(["STALE", "SILENT", "NO_DATA"]);

/** Market Intelligence: only what verified, session-authorised shared routes provide (Telegram channel health, scans, candidate counts). */
export function MarketScreen() {
  const ch = useChannels(), scans = useScans(5), cands = useCandidates({ limit: 50, offset: 0 });
  const channels = ch.data?.channels ?? [], bad = channels.filter((c) => FRESH_BAD.has(c.health.status)).length;
  const chState = deriveState({ loading: ch.isLoading, error: ch.error, hasData: !!ch.data, empty: channels.length === 0, stale: channels.length > 0 && bad === channels.length, partial: bad > 0 && bad < channels.length });
  const scanRows = scans.data?.scans ?? [], scState = deriveState({ loading: scans.isLoading, error: scans.error, hasData: !!scans.data, empty: scanRows.length === 0, stale: scanRows[0]?.status !== undefined && scanRows[0].status !== "COMPLETED" ? true : undefined });
  const list = cands.data?.candidates ?? [], by = (s: string): number => list.filter((c) => c.source === s).length;
  const cState = deriveState({ loading: cands.isLoading, error: cands.error, hasData: !!cands.data, empty: list.length === 0 });
  return (
    <>
      <PageHead eyebrow="Understand" title="Market intelligence"><p>The evidence the platform has captured: Telegram channel activity, opportunity scans and the candidates they produced. There is no live market feed.</p></PageHead>
      <div className="grid">
        <Banner label="No live market data">Nothing here is a live price, a news item or a regime reading. Channel reliability is NOT AVAILABLE: it needs resolved real outcomes.</Banner>
        <Section id="ch-h" title="Telegram channels" aside={<LoadedAt updatedAt={ch.dataUpdatedAt} />}>
          <DataRegion state={chState} what="channels" emptyHint="No Telegram channel is connected yet, so no channel evidence exists." staleNote="Every channel is stale or silent; the latest messages may be old." partialNote={`${bad} of ${channels.length} channels are stale, silent or have no data; the others are active.`} onRetry={() => void ch.refetch()}>
            <DataTable caption="Telegram channels" rows={channels} rowKey={(c) => c.id} columns={[
              { key: "n", header: "Channel", render: (c) => <><b>{c.name ?? "Unnamed"}</b> <span className="xs muted mono">{c.channel}</span></> },
              { key: "st", header: "Activity", render: (c) => <span className="badge b-neutral">{label(c.health.status)}</span> },
              { key: "last", header: "Last message", render: (c) => (c.lastMessageAt ? <>{formatIst(c.lastMessageAt)}</> : <span className="muted">none</span>) },
              { key: "m24", header: "Messages 24 h", align: "right", render: (c) => <span className="num">{c.messages24h}</span> },
              { key: "cap", header: "Capture", hideOnMobile: true, render: (c) => label(c.health.capture) },
              { key: "cl", header: "Claims (parsed / ambiguous / unsupported)", hideOnMobile: true, render: (c) => <span className="num">{c.claims.claim} / {c.claims.ambiguous} / {c.claims.unsupported}</span> },
              { key: "rel", header: "Reliability", hideOnMobile: true, render: () => <AvailabilityBadge kind="UNAVAILABLE" /> },
            ]} />
            {ch.data && <p className="small muted">{ch.data.reliabilityNote}</p>}
          </DataRegion>
        </Section>
        <Section id="sc-h" title="Opportunity scans" aside={<LoadedAt updatedAt={scans.dataUpdatedAt} />}>
          <DataRegion state={scState} what="scans" emptyHint="No scan has run yet." staleNote="The most recent scan did not complete." onRetry={() => void scans.refetch()}>
            <DataTable caption="Latest opportunity scans" rows={scanRows} rowKey={(s) => s.id} columns={[
              { key: "k", header: "Scan", render: (s) => label(s.kind) }, { key: "st", header: "Status", render: (s) => <span className="badge b-neutral">{label(s.status)}</span> },
              { key: "d", header: "Data", render: (s) => <DataSourceBadge dataSource={s.dataSource} /> },
              { key: "u", header: "Universe", align: "right", hideOnMobile: true, render: (s) => <span className="num">{s.universeSize}</span> },
              { key: "c", header: "Candidates", align: "right", render: (s) => <span className="num">{s.candidates}</span> },
              { key: "sk", header: "Skipped", align: "right", hideOnMobile: true, render: (s) => <span className="num">{Array.isArray(s.skipped) ? s.skipped.length : "—"}</span> },
              { key: "t", header: "Started", render: (s) => formatIst(s.startedAt) },
              { key: "e", header: "Error", hideOnMobile: true, render: (s) => s.errorKind ?? "—" },
            ]} />
          </DataRegion>
        </Section>
        <Section id="ev-h" title="Candidates found" aside={<LoadedAt updatedAt={cands.dataUpdatedAt} />}>
          <DataRegion state={cState} what="candidates" emptyHint="No candidates yet." onRetry={() => void cands.refetch()}>
            <dl className="kv"><dt>{SOURCE_LABEL["TELEGRAM"]}</dt><dd className="num">{by("TELEGRAM")}</dd><dt>{SOURCE_LABEL["INDEPENDENT"]}</dt><dd className="num">{by("INDEPENDENT")}</dd></dl>
            <p className="small muted">Counts are of the {list.length} most recent candidates loaded, not an all-time total. <Link href="/opportunities">Browse the opportunities</Link> to see each one with its evidence.</p>
          </DataRegion>
        </Section>
        <Section id="na-h" title="Not available">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {NOT_AVAILABLE.map(([t, why]) => <li key={t}><AvailabilityBadge kind="UNAVAILABLE" /> <b>{t}</b><div className="small muted">{why}</div></li>)}
          </ul>
        </Section>
      </div>
    </>
  );
}
