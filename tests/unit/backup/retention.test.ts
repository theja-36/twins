import { describe, expect, it } from "vitest";
import { classesForNewBackup, DEFAULT_RETENTION, isoWeekKey, monthKey, planPrune, resolveRetention } from "../../../packages/backup/src/index";

const day = (n: number, h = 2) => new Date(Date.UTC(2031, 0, 1 + n, h, 30));
const objs = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `daily/staging/b${String(i).padStart(2, "0")}.tar.age`, createdAt: day(i) }));

describe("retention policy configuration", () => {
  it("defaults to 7 daily, 4 weekly, 6 monthly", () => {
    expect(resolveRetention({})).toMatchObject({ daily: 7, weekly: 4, monthly: 6 });
    expect(DEFAULT_RETENTION).toMatchObject({ daily: 7, weekly: 4, monthly: 6, floor: 3 });
  });
  it("is configurable and fails closed on garbage", () => {
    expect(resolveRetention({ TWINS_BACKUP_KEEP_DAILY: "14", TWINS_BACKUP_KEEP_WEEKLY: "8", TWINS_BACKUP_KEEP_MONTHLY: "12" })).toMatchObject({ daily: 14, weekly: 8, monthly: 12 });
    for (const bad of ["0", "-1", "abc", "1.5", "99999"]) expect(() => resolveRetention({ TWINS_BACKUP_KEEP_DAILY: bad }), bad).toThrow(/TWINS_BACKUP_KEEP_DAILY/);
  });
});

describe("which retention classes a new backup belongs to", () => {
  it("daily always; weekly for the first backup of an ISO week; monthly for the first of a UTC month", () => {
    expect(classesForNewBackup(day(0), { weekly: [], monthly: [] })).toEqual(["daily", "weekly", "monthly"]);
    expect(classesForNewBackup(day(1), { weekly: [{ key: "w", createdAt: day(0) }], monthly: [{ key: "m", createdAt: day(0) }] })).toEqual(["daily"]);
    expect(classesForNewBackup(day(7), { weekly: [{ key: "w", createdAt: day(0) }], monthly: [{ key: "m", createdAt: day(0) }] })).toEqual(["daily", "weekly"]);
    expect(classesForNewBackup(day(35), { weekly: [{ key: "w", createdAt: day(28) }], monthly: [{ key: "m", createdAt: day(0) }] })).toEqual(["daily", "weekly", "monthly"]);
  });
  it("ISO week and month keys handle year boundaries", () => {
    expect(isoWeekKey(new Date("2030-12-30T00:00:00Z"))).toBe("2031-W01");
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(monthKey(new Date("2031-01-31T23:59:59Z"))).toBe("2031-01");
  });
});

describe("prune plan (per class)", () => {
  const now = day(40);
  it("keeps the newest N, deletes the rest, with reasons", () => {
    const plan = planPrune("daily", objs(10), now, { ...DEFAULT_RETENTION, protectHours: 1 });
    expect(plan.keep).toHaveLength(7);
    expect(plan.delete).toEqual(["daily/staging/b02.tar.age", "daily/staging/b01.tar.age", "daily/staging/b00.tar.age"]);
    expect(plan.reasons["daily/staging/b00.tar.age"]).toMatch(/beyond newest 7 daily/);
  });
  it("never deletes below the floor, even if the policy asks for 0", () => {
    const plan = planPrune("monthly", objs(5), now, { ...DEFAULT_RETENTION, monthly: 0, protectHours: 1 });
    expect(plan.keep).toHaveLength(3);
    expect(plan.delete).toHaveLength(2);
  });
  it("never deletes an object younger than the protection window", () => {
    const fresh = [{ key: "daily/staging/new.tar.age", createdAt: new Date(now.getTime() - 3_600_000) }, ...objs(12)];
    const plan = planPrune("daily", fresh, now, { ...DEFAULT_RETENTION, daily: 1, floor: 1, protectHours: 48 });
    expect(plan.keep).toContain("daily/staging/new.tar.age");
    expect(plan.delete.length).toBeGreaterThan(0);
  });
  it("an empty class is an empty plan; one object is never deleted", () => {
    expect(planPrune("weekly", [], now, DEFAULT_RETENTION)).toEqual({ keep: [], delete: [], reasons: {} });
    expect(planPrune("weekly", objs(1), now, { ...DEFAULT_RETENTION, weekly: 0 }).delete).toEqual([]);
  });
});
