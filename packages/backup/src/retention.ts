/**
 * Retention policy for off-host backups (pure; no I/O). Objects live under one prefix per retention class (`daily/`, `weekly/`, `monthly/`) so that
 * the storage provider's own lock and lifecycle rules can be set per class. A backup is uploaded to `daily/` always, to `weekly/` when it is the first
 * of its ISO week and to `monthly/` when it is the first of its UTC month.
 */
export type RetentionClass = "daily" | "weekly" | "monthly";
export const RETENTION_CLASSES: readonly RetentionClass[] = ["daily", "weekly", "monthly"];

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
  /** Never delete the newest N objects of a class, whatever the policy says. */
  floor: number;
  /** Never delete an object younger than this many hours. */
  protectHours: number;
}
export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, monthly: 6, floor: 3, protectHours: 48 };

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(raw);
}

/** Policy from the environment (TWINS_BACKUP_KEEP_DAILY / _WEEKLY / _MONTHLY / _FLOOR / _PROTECT_HOURS); invalid values fail closed. */
export function resolveRetention(env: Record<string, string | undefined>): RetentionPolicy {
  return {
    daily: intEnv(env, "TWINS_BACKUP_KEEP_DAILY", DEFAULT_RETENTION.daily, 1, 3650),
    weekly: intEnv(env, "TWINS_BACKUP_KEEP_WEEKLY", DEFAULT_RETENTION.weekly, 0, 520),
    monthly: intEnv(env, "TWINS_BACKUP_KEEP_MONTHLY", DEFAULT_RETENTION.monthly, 0, 120),
    floor: intEnv(env, "TWINS_BACKUP_KEEP_FLOOR", DEFAULT_RETENTION.floor, 1, 100),
    protectHours: intEnv(env, "TWINS_BACKUP_PROTECT_HOURS", DEFAULT_RETENTION.protectHours, 1, 8760),
  };
}

/** ISO-8601 week key `YYYY-Www` (UTC). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
export const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export interface ExistingObject {
  key: string;
  createdAt: Date;
}

/** Which classes a NEW backup made at `at` must be stored under, given what already exists in the weekly/ and monthly/ classes. */
export function classesForNewBackup(at: Date, existing: { weekly: ExistingObject[]; monthly: ExistingObject[] }): RetentionClass[] {
  const classes: RetentionClass[] = ["daily"];
  if (!existing.weekly.some((o) => isoWeekKey(o.createdAt) === isoWeekKey(at))) classes.push("weekly");
  if (!existing.monthly.some((o) => monthKey(o.createdAt) === monthKey(at))) classes.push("monthly");
  return classes;
}

export interface PrunePlan {
  keep: string[];
  delete: string[];
  reasons: Record<string, string>;
}

/**
 * Within ONE class: keep the newest `policy[class]` objects (a class set to 0 keeps nothing beyond the floor), always keep the newest `floor`
 * and anything younger than `protectHours`; everything else is a deletion candidate. Never returns a plan that deletes everything.
 */
export function planPrune(cls: RetentionClass, objects: ExistingObject[], now: Date, policy: RetentionPolicy): PrunePlan {
  const sorted = [...objects].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.key < b.key ? 1 : -1));
  const plan: PrunePlan = { keep: [], delete: [], reasons: {} };
  const limit = Math.max(policy[cls], policy.floor);
  sorted.forEach((o, i) => {
    const ageHours = (now.getTime() - o.createdAt.getTime()) / 3_600_000;
    let reason: string | undefined;
    if (i < policy[cls]) reason = `within newest ${policy[cls]} ${cls}`;
    else if (i < policy.floor) reason = `floor: newest ${policy.floor} are never deleted`;
    else if (ageHours < policy.protectHours) reason = `younger than ${policy.protectHours} h`;
    if (reason !== undefined || i < limit) {
      plan.keep.push(o.key);
      plan.reasons[o.key] = reason ?? "within limit";
    } else {
      plan.delete.push(o.key);
      plan.reasons[o.key] = `beyond newest ${policy[cls]} ${cls}`;
    }
  });
  return plan;
}
