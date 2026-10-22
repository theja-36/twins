import { describe, expect, it } from "vitest";
import { classifyRevisions, originOf, type RevisionRow } from "../../../packages/ingestion/src/telegramRevisions";

const d = (s: number) => new Date(s * 1000);
const orig: RevisionRow = { id: "orig", externalMessageId: "42", originMessageId: "42", editDate: null };
const e1: RevisionRow = { id: "e1", externalMessageId: "42_edit_100_aaa", originMessageId: "42", editDate: d(100) };
const e2: RevisionRow = { id: "e2", externalMessageId: "42_edit_200_bbb", originMessageId: "42", editDate: d(200) };
const e2b: RevisionRow = { id: "e2b", externalMessageId: "42_edit_200_ccc", originMessageId: "42", editDate: d(200) };
const legacy: RevisionRow = { id: "leg", externalMessageId: "42_edit", originMessageId: null, editDate: null };

const state = (rows: RevisionRow[]) => Object.fromEntries(classifyRevisions(rows).map((c) => [c.id, c.state]));

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("classifyRevisions (currentness from edit_date, never arrival order)", () => {
  it("an unedited original is current", () => {
    expect(state([orig])).toEqual({ orig: "current" });
  });

  it("the latest edit is current; original and older edits are superseded - for every arrival order", () => {
    for (const rows of permutations([orig, e1, e2])) {
      expect(state(rows)).toEqual({ orig: "superseded", e1: "superseded", e2: "current" });
    }
  });

  it("an edit that arrives BEFORE its original is current; the late original is superseded", () => {
    expect(state([e1])).toEqual({ e1: "current" });
    expect(state([e1, orig])).toEqual({ e1: "current", orig: "superseded" });
  });

  it("an older edit arriving after a newer edit does not become current", () => {
    expect(state([e2, e1])).toEqual({ e2: "current", e1: "superseded" });
  });

  it("same-second distinct revisions cannot be ordered: all tied revisions are ambiguous (non-actionable)", () => {
    for (const rows of permutations([e1, e2, e2b])) {
      expect(state(rows)).toEqual({ e1: "superseded", e2: "ambiguous", e2b: "ambiguous" });
    }
  });

  it("legacy `_edit` rows have unknown edit time: every edit in the group is ambiguous", () => {
    expect(state([orig, legacy, e1])).toEqual({ orig: "superseded", leg: "ambiguous", e1: "ambiguous" });
  });

  it("derives the origin id of legacy rows from their identifier", () => {
    expect(originOf(legacy)).toBe("42");
    expect(originOf(e1)).toBe("42");
  });
});
