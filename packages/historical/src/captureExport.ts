import { MAX_EDITS, MAX_TEXT_LENGTH } from "./contract";

/**
 * Capture exporter (Option A): turns the messages TWINS already captured (telegram_messages) into records in the historical importer's input contract (`historical-contract-v1`), so they can go through
 * the normal profile -> dry-run -> import -> evaluate -> scorecard path. PURE conversion only (`captureRowsToRecords`): this package must not read the live tables (an architecture test enforces that), so the READ-ONLY loader lives in
 * `scripts/ops/capture-export.ts`; it only SELECTs and never writes to the database. Output files contain message text (the owner's own captured data); the importer redacts secrets on import, the file itself is written 0600 by the CLI and must not be committed.
 *
 * Rules that protect the research from hindsight: an edited revision is exported as an EDIT of its original (never as the message); a message whose first-seen version was already an edit
 * (`first_seen_edited`) is EXCLUDED by default because its stored text is a later revision; revisions without an original are skipped and counted, never promoted to messages.
 */
export const CAPTURE_EXPORT_VERSION = "capture-export-v1";
const CHANNEL_OK = /^[A-Za-z0-9_.:@ -]{1,80}$/;
const ID_OK = /^[A-Za-z0-9_.:-]{1,80}$/;

export interface CaptureRow {
  sourceId: string; channelIdentifier: string; displayName: string | null; externalId: string; originId: string | null;
  messageTimestamp: Date; editDate: Date | null; rawText: string; firstSeenEdited: boolean; captureMethod: string;
}
export interface ExportRecord { channel: string; message_id: string; timestamp: string; text: string; edits?: Array<{ edited_at: string; text: string }> }
export interface ExportStats {
  version: typeof CAPTURE_EXPORT_VERSION; rowsRead: number; messagesExported: number; revisionsAttached: number; revisionsOrphaned: number; firstSeenEditedExcluded: number; firstSeenEditedIncluded: number;
  emptyTextSkipped: number; badIdSkipped: number; editsTruncated: number; textTruncated: number; channels: number; byCaptureMethod: Record<string, number>; first: string | null; last: string | null;
}
export interface ExportOptions { includeFirstSeenEdited?: boolean }

/** Contract-safe channel label: the display name when present, else the identifier; characters outside the contract's set become "_". */
export function channelLabelOf(r: Pick<CaptureRow, "channelIdentifier" | "displayName">): string {
  const raw = (r.displayName && r.displayName.trim()) || r.channelIdentifier;
  const clean = raw.replace(/[^A-Za-z0-9_.:@ -]/g, "_").trim().slice(0, 80);
  return CHANNEL_OK.test(clean) ? clean : "channel";
}

export function captureRowsToRecords(rows: readonly CaptureRow[], opts: ExportOptions = {}): { records: ExportRecord[]; stats: ExportStats } {
  const stats: ExportStats = { version: CAPTURE_EXPORT_VERSION, rowsRead: rows.length, messagesExported: 0, revisionsAttached: 0, revisionsOrphaned: 0, firstSeenEditedExcluded: 0, firstSeenEditedIncluded: 0, emptyTextSkipped: 0, badIdSkipped: 0, editsTruncated: 0, textTruncated: 0, channels: 0, byCaptureMethod: {}, first: null, last: null };
  const groups = new Map<string, { original: CaptureRow | null; revisions: CaptureRow[] }>();
  for (const r of rows) {
    stats.byCaptureMethod[r.captureMethod] = (stats.byCaptureMethod[r.captureMethod] ?? 0) + 1;
    const origin = r.originId ?? r.externalId;
    const isRevision = r.editDate !== null || (r.originId !== null && r.originId !== r.externalId);
    const key = `${r.sourceId}\u0000${origin}`;
    const g = groups.get(key) ?? groups.set(key, { original: null, revisions: [] }).get(key)!;
    if (isRevision) g.revisions.push(r); else g.original = r;
  }
  const records: ExportRecord[] = [];
  const channels = new Set<string>();
  const cap = (t: string): string => { if (t.length > MAX_TEXT_LENGTH) { stats.textTruncated += 1; return t.slice(0, MAX_TEXT_LENGTH); } return t; };
  for (const [key, g] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const origin = key.split("\u0000")[1] as string;
    if (!g.original) { stats.revisionsOrphaned += g.revisions.length; continue; }
    const o = g.original;
    if (o.firstSeenEdited) { if (!opts.includeFirstSeenEdited) { stats.firstSeenEditedExcluded += 1; continue; } stats.firstSeenEditedIncluded += 1; }
    if (!ID_OK.test(origin)) { stats.badIdSkipped += 1; continue; }
    if (o.rawText.trim() === "") { stats.emptyTextSkipped += 1; continue; }
    const channel = channelLabelOf(o);
    const edits = [...g.revisions].filter((r) => r.rawText.trim() !== "").sort((a, b) => (a.editDate?.getTime() ?? a.messageTimestamp.getTime()) - (b.editDate?.getTime() ?? b.messageTimestamp.getTime()));
    const keep = edits.slice(0, MAX_EDITS);
    stats.editsTruncated += edits.length - keep.length;
    stats.revisionsAttached += keep.length;
    const rec: ExportRecord = { channel, message_id: origin, timestamp: o.messageTimestamp.toISOString(), text: cap(o.rawText) };
    if (keep.length) rec.edits = keep.map((r) => ({ edited_at: (r.editDate ?? r.messageTimestamp).toISOString(), text: cap(r.rawText) }));
    records.push(rec);
    channels.add(channel);
    const iso = rec.timestamp;
    if (stats.first === null || iso < stats.first) stats.first = iso;
    if (stats.last === null || iso > stats.last) stats.last = iso;
  }
  records.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.message_id < b.message_id ? -1 : 1));
  stats.messagesExported = records.length;
  stats.channels = channels.size;
  return { records, stats };
}
