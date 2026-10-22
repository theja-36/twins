/**
 * The ONLY databases a rehearsal may target. An exact allowlist (not a pattern), so a new scratch database needs an
 * explicit, reviewed change here AND in docs/implementation/rehearsal/migrate-folder.mjs (kept in sync by a unit test).
 */
export const APPROVED_REHEARSAL_DATABASES = [
  "twins_rehearsal_fresh", // 0004 rehearsal (retained)
  "twins_rehearsal_upgrade", // 0004 rehearsal (retained)
  "twins_rehearsal_f2_upgrade", // F2 / migration 0005 upgrade rehearsal (not yet created)
  "twins_rehearsal_f2_fresh", // F2 / migration 0005 fresh-chain rehearsal (not yet created)
] as const;

export function isApprovedRehearsalDatabase(pathname: string): boolean {
  return (APPROVED_REHEARSAL_DATABASES as readonly string[]).includes(pathname.replace(/^\//, ""));
}
