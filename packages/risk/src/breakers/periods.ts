/**
 * Trading periods for the loss circuit breakers (pure). A DAY runs from local midnight to the next local midnight; a WEEK from Monday 00:00 to the next
 * Monday 00:00 (local time = UTC + offset). A breach lasts until the NEXT TRADING DAY (the next weekday; there is no holiday calendar) or the next week.
 */
const DAY = 86_400_000;

export interface Period { start: Date; end: Date; resetsAt: Date }
export type BreakerScope = "DAILY" | "WEEKLY";

const localDayIndex = (t: number, offsetMin: number): number => Math.floor((t + offsetMin * 60_000) / DAY);
const dayStartOf = (index: number, offsetMin: number): Date => new Date(index * DAY - offsetMin * 60_000);
/** 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday). */
const weekdayOf = (index: number): number => (((index + 4) % 7) + 7) % 7;

export function dailyPeriod(asOf: Date, offsetMin: number): Period {
  const i = localDayIndex(asOf.getTime(), offsetMin);
  let next = i + 1;
  while (weekdayOf(next) === 0 || weekdayOf(next) === 6) next += 1;
  return { start: dayStartOf(i, offsetMin), end: dayStartOf(i + 1, offsetMin), resetsAt: dayStartOf(next, offsetMin) };
}

export function weeklyPeriod(asOf: Date, offsetMin: number): Period {
  const i = localDayIndex(asOf.getTime(), offsetMin);
  const monday = i - ((weekdayOf(i) + 6) % 7);
  const end = dayStartOf(monday + 7, offsetMin);
  return { start: dayStartOf(monday, offsetMin), end, resetsAt: end };
}

export const periodFor = (scope: BreakerScope, asOf: Date, offsetMin: number): Period => (scope === "DAILY" ? dailyPeriod(asOf, offsetMin) : weeklyPeriod(asOf, offsetMin));
