import { and, eq, or } from "drizzle-orm";
import { schema } from "@twins/database";
import type { Db } from "./db";

/**
 * Revision currentness for Telegram messages, derived ONLY from stored,
 * deterministic data (Telegram's edit_date) - never from processing/arrival order.
 *
 * NOT an approval mechanism. Approval/execution are not implemented. The invariant
 * those future components MUST enforce: an approval binds to a specific
 * (signal id, validation id, raw message id) AND is valid only while that raw
 * message is `current` when checked at approval time and again at execution time;
 * any later-arriving newer revision (or an `ambiguous` group) makes it non-actionable.
 */
export type RevisionState = "current" | "superseded" | "ambiguous";

export interface RevisionRow {
  id: string;
  externalMessageId: string;
  originMessageId: string | null;
  editDate: Date | null;
}

export interface RevisionClassification {
  id: string;
  state: RevisionState;
  reason: string;
}

const LEGACY_EDIT_SUFFIX = /_edit$/;

/** Original message id for a row; legacy `<id>_edit` rows are derivable from their identifier. */
export function originOf(row: Pick<RevisionRow, "externalMessageId" | "originMessageId">): string {
  return row.originMessageId ?? row.externalMessageId.replace(LEGACY_EDIT_SUFFIX, "");
}

/**
 * Classifies all stored rows of ONE original message (same channel).
 * - original (no edit_date, not a legacy edit) is older than every edit, even if it arrives later;
 * - among edits the highest edit_date is current regardless of arrival order;
 * - several distinct revisions sharing the highest edit_date (same-second edits) cannot be
 *   ordered reliably -> all of them `ambiguous` (non-actionable);
 * - legacy `_edit` rows have no known edit time -> every edit in the group is `ambiguous`.
 */
export function classifyRevisions(rows: RevisionRow[]): RevisionClassification[] {
  const isLegacyEdit = (r: RevisionRow) => r.editDate === null && LEGACY_EDIT_SUFFIX.test(r.externalMessageId);
  const edits = rows.filter((r) => r.editDate !== null || isLegacyEdit(r));
  const out = new Map<string, RevisionClassification>();
  const ordered = (): RevisionClassification[] =>
    rows.flatMap((r) => {
      const c = out.get(r.id);
      return c ? [c] : [];
    });
  const time = (r: RevisionRow): number => r.editDate?.getTime() ?? Number.NEGATIVE_INFINITY;

  if (edits.length === 0) {
    for (const r of rows) out.set(r.id, { id: r.id, state: "current", reason: "only the original message is known" });
    return ordered();
  }

  for (const r of rows.filter((x) => !edits.includes(x))) {
    out.set(r.id, { id: r.id, state: "superseded", reason: "the message has at least one edit" });
  }

  if (edits.some(isLegacyEdit)) {
    for (const r of edits) {
      out.set(r.id, { id: r.id, state: "ambiguous", reason: "legacy edit row without edit_date: revision order cannot be established" });
    }
  } else {
    const max = Math.max(...edits.map(time));
    const top = edits.filter((r) => time(r) === max);
    for (const r of edits) {
      if (time(r) < max) {
        out.set(r.id, { id: r.id, state: "superseded", reason: "a revision with a later edit_date exists" });
      } else if (top.length === 1) {
        out.set(r.id, { id: r.id, state: "current", reason: "latest edit_date" });
      } else {
        out.set(r.id, { id: r.id, state: "ambiguous", reason: "multiple distinct revisions share the latest edit_date: order cannot be established" });
      }
    }
  }
  return ordered();
}

/** Loads and classifies every stored revision of one original message in a source. */
export async function getRevisionStates(
  db: Db,
  telegramSourceId: string,
  originMessageId: string,
): Promise<RevisionClassification[]> {
  const rows = await db
    .select({
      id: schema.telegramMessages.id,
      externalMessageId: schema.telegramMessages.externalMessageId,
      originMessageId: schema.telegramMessages.originMessageId,
      editDate: schema.telegramMessages.editDate,
    })
    .from(schema.telegramMessages)
    .where(
      and(
        eq(schema.telegramMessages.telegramSourceId, telegramSourceId),
        or(
          eq(schema.telegramMessages.originMessageId, originMessageId),
          eq(schema.telegramMessages.externalMessageId, originMessageId),
          eq(schema.telegramMessages.externalMessageId, `${originMessageId}_edit`),
        ),
      ),
    );
  return classifyRevisions(rows);
}
