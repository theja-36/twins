import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPROVED_REHEARSAL_DATABASES, isApprovedRehearsalDatabase } from "../../integration/runtime/rehearsalTargets";

describe("rehearsal target allowlist", () => {
  it("is exactly the four approved databases", () => {
    expect([...APPROVED_REHEARSAL_DATABASES]).toEqual([
      "twins_rehearsal_fresh", "twins_rehearsal_upgrade", "twins_rehearsal_f2_upgrade", "twins_rehearsal_f2_fresh",
    ]);
  });
  it.each(["/twins_dev", "/twins_ci", "/twins_restore_drill", "/twins_rehearsal_other", "/twins_rehearsal_f2", "/twins_rehearsal_f2_upgrade2", "/postgres", "", "/"])(
    "rejects %j", (name) => expect(isApprovedRehearsalDatabase(name)).toBe(false));
  it.each(APPROVED_REHEARSAL_DATABASES)("accepts %s (with or without the URL slash)", (name) => {
    expect(isApprovedRehearsalDatabase(`/${name}`)).toBe(true);
    expect(isApprovedRehearsalDatabase(name)).toBe(true);
  });
  // The rehearsal tooling ships with the docs/tooling checkpoint, not the code checkpoint: when it is absent there is nothing to keep in sync.
  const migrateFolder = new URL("../../../docs/implementation/rehearsal/migrate-folder.mjs", import.meta.url);
  it.skipIf(!existsSync(migrateFolder))("migrate-folder.mjs carries the identical exact list, the loopback check, and no longer accepts 'any rehearsal' name", () => {
    const src = readFileSync(migrateFolder, "utf8");
    const m = /const APPROVED = \[([^\]]+)\]/.exec(src);
    expect(m).not.toBeNull();
    const listed = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(listed).toEqual([...APPROVED_REHEARSAL_DATABASES]);
    expect(src).toContain("127.0.0.1:15432");
    expect(src).not.toContain('.includes("rehearsal")');
  });
});
