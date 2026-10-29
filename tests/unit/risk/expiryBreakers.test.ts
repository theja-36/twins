import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAlert, createAlerter, type AlertPayload, type AlertSender } from "../../../packages/alerting/src/index";
import {
  breakerAlert, breakerGate, dailyPeriod, DEFAULT_BREAKER_CONFIG, DEFAULT_EXPIRY_CONFIG, evaluateCircuitBreakers, isStale, loadBreakerConfig, loadExpiryConfig, recordLossEvent, validityMs, weeklyPeriod, type BreakerEventRecord,
} from "../../../packages/risk/src/index";
import { runScheduledJob } from "../../../services/scheduler/src/scheduledJob";

const ROOT = join(__dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const throwingDb = new Proxy({}, { get: () => () => { throw new Error("connection refused: password=SECRET-CANARY"); } }) as never;
const IST = 330;
const iso = (d: Date) => d.toISOString();

describe("expiry configuration", () => {
  it("defaults: PENDING 30 minutes, APPROVED_FOR_REVIEW 15 minutes; other statuses never expire", () => {
    expect(DEFAULT_EXPIRY_CONFIG).toMatchObject({ pendingMinutes: 30, approvedForReviewMinutes: 15 });
    expect(validityMs("PENDING", DEFAULT_EXPIRY_CONFIG)).toBe(30 * 60_000);
    expect(validityMs("APPROVED_FOR_REVIEW", DEFAULT_EXPIRY_CONFIG)).toBe(15 * 60_000);
    for (const s of ["REJECTED", "EXPIRED", "SUPERSEDED"]) expect(validityMs(s, DEFAULT_EXPIRY_CONFIG)).toBeNull();
  });
  it("environment overrides apply; a malformed value throws (no silent fallback)", () => {
    const c = loadExpiryConfig({ TWINS_RISK_EXPIRY_PENDING_MINUTES: "45", TWINS_RISK_EXPIRY_APPROVED_MINUTES: "5" });
    expect(c).toMatchObject({ pendingMinutes: 45, approvedForReviewMinutes: 5, source: { pendingMinutes: "env" } });
    for (const v of ["0", "-1", "1.5", "abc", "99999"]) expect(() => loadExpiryConfig({ TWINS_RISK_EXPIRY_PENDING_MINUTES: v }), v).toThrow();
  });
  it("a decision is stale exactly at the end of its window (inclusive) and only while PENDING / APPROVED_FOR_REVIEW", () => {
    const t0 = new Date("2031-12-17T05:00:00Z");
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(isStale({ status: "PENDING", createdAt: t0 }, at(29.99), DEFAULT_EXPIRY_CONFIG)).toBe(false);
    expect(isStale({ status: "PENDING", createdAt: t0 }, at(30), DEFAULT_EXPIRY_CONFIG)).toBe(true);
    expect(isStale({ status: "APPROVED_FOR_REVIEW", createdAt: t0 }, at(14.99), DEFAULT_EXPIRY_CONFIG)).toBe(false);
    expect(isStale({ status: "APPROVED_FOR_REVIEW", createdAt: t0 }, at(15), DEFAULT_EXPIRY_CONFIG)).toBe(true);
    expect(isStale({ status: "REJECTED", createdAt: t0 }, at(100000), DEFAULT_EXPIRY_CONFIG)).toBe(false);
  });
});

describe("trading periods (IST, Monday-Friday)", () => {
  it("a Wednesday's loss limit lifts at Thursday 00:00 IST; a Friday's lifts at MONDAY 00:00 IST (the next trading day); a Saturday's also Monday", () => {
    const wed = new Date("2031-12-17T05:00:00Z"); // 10:30 IST
    expect(wed.getUTCDay()).toBe(3);
    expect(dailyPeriod(wed, IST)).toMatchObject({ start: new Date("2031-12-16T18:30:00Z"), end: new Date("2031-12-17T18:30:00Z"), resetsAt: new Date("2031-12-17T18:30:00Z") });
    const fri = new Date("2031-12-19T05:00:00Z");
    expect(fri.getUTCDay()).toBe(5);
    expect(iso(dailyPeriod(fri, IST).resetsAt)).toBe("2031-12-21T18:30:00.000Z"); // Mon 2031-12-22 00:00 IST
    expect(iso(dailyPeriod(new Date("2031-12-20T05:00:00Z"), IST).resetsAt)).toBe("2031-12-21T18:30:00.000Z");
    expect(iso(dailyPeriod(new Date("2031-12-21T05:00:00Z"), IST).resetsAt)).toBe("2031-12-21T18:30:00.000Z"); // Sunday -> Monday
  });
  it("the day boundary is IST midnight, not UTC midnight", () => {
    expect(iso(dailyPeriod(new Date("2031-12-17T18:29:59Z"), IST).start)).toBe("2031-12-16T18:30:00.000Z");
    expect(iso(dailyPeriod(new Date("2031-12-17T18:30:00Z"), IST).start)).toBe("2031-12-17T18:30:00.000Z");
  });
  it("a week runs Monday 00:00 IST to the next Monday 00:00 IST; Sunday belongs to the week that started the previous Monday", () => {
    const mon = weeklyPeriod(new Date("2031-12-22T05:00:00Z"), IST);
    expect(iso(mon.start)).toBe("2031-12-21T18:30:00.000Z");
    expect(iso(mon.end)).toBe("2031-12-28T18:30:00.000Z");
    expect(iso(weeklyPeriod(new Date("2031-12-28T05:00:00Z"), IST).start)).toBe("2031-12-21T18:30:00.000Z"); // Sunday
    expect(weeklyPeriod(new Date("2031-12-17T05:00:00Z"), IST).resetsAt.getTime()).toBe(weeklyPeriod(new Date("2031-12-17T05:00:00Z"), IST).end.getTime());
  });
});

describe("breaker configuration", () => {
  it("defaults: daily 2%, weekly 5%, warning at 75% of a limit, IST", () => {
    expect(DEFAULT_BREAKER_CONFIG).toMatchObject({ dailyLossPct: 2, weeklyLossPct: 5, warnPct: 75, utcOffsetMinutes: 330 });
  });
  it("overrides apply; malformed or inconsistent values throw", () => {
    expect(loadBreakerConfig({ TWINS_BREAKER_DAILY_LOSS_PCT: "1.5", TWINS_BREAKER_WEEKLY_LOSS_PCT: "4", TWINS_BREAKER_WARN_PCT: "50" })).toMatchObject({ dailyLossPct: 1.5, weeklyLossPct: 4, warnPct: 50 });
    for (const env of [{ TWINS_BREAKER_DAILY_LOSS_PCT: "0" }, { TWINS_BREAKER_DAILY_LOSS_PCT: "x" }, { TWINS_BREAKER_WARN_PCT: "100" }, { TWINS_BREAKER_UTC_OFFSET_MINUTES: "9999" }, { TWINS_BREAKER_DAILY_LOSS_PCT: "6" }]) {
      expect(() => loadBreakerConfig(env), JSON.stringify(env)).toThrow(); // the last one: weekly (5) below daily (6)
    }
  });
});

describe("fail closed", () => {
  it("an unreadable breaker state refuses with circuit_breaker_unavailable and leaks no driver message", async () => {
    const e = await breakerGate(throwingDb, 1_000_000, { asOf: new Date("2031-12-17T05:00:00Z") }).then(() => null, (x: unknown) => x as { code: string; message: string });
    expect(e).toMatchObject({ code: "circuit_breaker_unavailable" });
    expect(JSON.stringify([e?.message, String(e)])).not.toMatch(/SECRET-CANARY|password/);
  });
  it("evaluation needs a positive capital (invalid_input), and a loss event needs a positive amount", async () => {
    await expect(evaluateCircuitBreakers(throwingDb, { capital: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(recordLossEvent(throwingDb, { amount: 0, occurredAt: new Date(), source: "synthetic", sourceRef: "x", createdBy: "service:t" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(recordLossEvent(throwingDb, { amount: -5, occurredAt: new Date(), source: "synthetic", sourceRef: "x", createdBy: "service:t" })).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("loss events validate their source, reference and actor, and synthetic events are refused in production", async () => {
    const ok = { amount: 5, occurredAt: new Date(), source: "synthetic", sourceRef: "ref-1", createdBy: "service:t" } as const;
    await expect(recordLossEvent(throwingDb, { ...ok, source: "invented" as never })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(recordLossEvent(throwingDb, { ...ok, sourceRef: "bad ref!" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(recordLossEvent(throwingDb, { ...ok, createdBy: "anyone" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(recordLossEvent(throwingDb, { ...ok, occurredAt: new Date("nope") })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(recordLossEvent(throwingDb, ok, { APP_ENV: "production" })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/production/) });
  });
});

describe("alerts: severities, fixed templates and redaction", () => {
  const ev = (eventType: BreakerEventRecord["eventType"], scope: "DAILY" | "WEEKLY" = "DAILY"): BreakerEventRecord => ({ id: "11111111-1111-4111-8111-111111111111", scope, eventType, lossPct: 1.5, limitPct: 2, created: true });
  it("WARNING at the warning threshold, CRITICAL on a breach, INFO on a reset - for both scopes", () => {
    expect(breakerAlert(ev("WARNED"))).toMatchObject({ severity: "WARNING", event: "risk.circuit_breaker.warning", code: "daily_loss_warning" });
    expect(breakerAlert(ev("BREACHED"))).toMatchObject({ severity: "CRITICAL", event: "risk.circuit_breaker.breached", code: "daily_loss_limit_breached" });
    expect(breakerAlert(ev("RESET"))).toMatchObject({ severity: "INFO", event: "risk.circuit_breaker.reset", code: "daily_breaker_reset" });
    expect(breakerAlert(ev("BREACHED", "WEEKLY"))).toMatchObject({ severity: "CRITICAL", code: "weekly_loss_limit_breached" });
    expect(breakerAlert(ev("BREACHED", "WEEKLY")).summary).toMatch(/next trading week/);
    expect(breakerAlert(ev("BREACHED")).summary).toMatch(/next trading day/);
  });
  it("the built alert carries only scope and percentages; unlisted keys and secret-shaped values never survive", () => {
    const a = breakerAlert(ev("BREACHED"));
    const built = buildAlert({ ...a, details: { ...a.details, password: "hunter2", rawText: "BUY RELIANCE 2800 SL 2750", telegramToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", amount: 25000, createdBy: "operator:someone", name: "Bearer abcdefgh12345678" } }, { environment: "test", service: "scheduler" });
    expect(built.details).toEqual({ scope: "daily", lossPct: 1.5, limitPct: 2, name: "[redacted]" });
    expect(JSON.stringify(built)).not.toMatch(/hunter2|RELIANCE|ABCDEFGHIJ|25000|operator:|Bearer/);
    expect(buildAlert({ ...a, details: { scope: "password=abcd1234" } }, { environment: "test", service: "scheduler" }).details["scope"]).toBe("[redacted]");
  });
  it("an alerter configured at INFO delivers all three severities exactly once per event id", async () => {
    const sent: AlertPayload[] = [];
    const sender: AlertSender = { label: "capture", send: async (p) => { sent.push(p); return true; } };
    const alerter = createAlerter({ context: { environment: "test", service: "scheduler" }, sender, minSeverity: "INFO" });
    for (const t of ["WARNED", "BREACHED", "RESET"] as const) { alerter.alert({ ...breakerAlert(ev(t)), dedupeKey: `${t}-1` }); alerter.alert({ ...breakerAlert(ev(t)), dedupeKey: `${t}-1` }); }
    await alerter.flush();
    expect(sent.map((p) => p.severity)).toEqual(["WARNING", "CRITICAL", "INFO"]);
  });
});

describe("architecture: housekeeping and breakers place no orders, call no broker, and write only their own records", () => {
  const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((x) => (statSync(join(ROOT, dir, x)).isDirectory() ? files(`${dir}/${x}`) : x.endsWith(".ts") ? [`${dir}/${x}`] : []));
  it("no code under expiry/ or breakers/ references orders, fills, positions, brokers, Telegram or approval cards", () => {
    for (const f of [...files("packages/risk/src/expiry"), ...files("packages/risk/src/breakers")]) expect(strip(read(f)), f).not.toMatch(/schema\.(orders|fills|positions|decisions|claimReviewCards)\b|zerodha|kite|broker(?!_reconciliation)|telegram|sendMessage|approval card/i); // `broker_reconciliation` is only the NAME of the future loss source; no broker is called
  });
  it("loss_events and circuit_breaker_events are written ONLY by breakers/record.ts; the pure modules do no I/O", () => {
    const writers = files("packages/risk/src").concat(files("services"), files("apps"), files("scripts")).filter((f) => /\.insert\(\s*schema\.(lossEvents|circuitBreakerEvents)\b|insert into (loss_events|circuit_breaker_events)\b/i.test(strip(read(f))));
    expect(writers).toEqual(["packages/risk/src/breakers/record.ts"]);
    for (const f of ["packages/risk/src/breakers/periods.ts", "packages/risk/src/breakers/config.ts", "packages/risk/src/expiry/config.ts"]) {
      expect(strip(read(f)), f).not.toMatch(/from\s+"(?!\.)|Date\.now|new Date\(\)|fetch\(|process\.env\.[A-Z]/);
    }
  });
  it("the scheduler jobs go through runScheduledJob as risk_housekeeping, which is NOT gated by the trading state (removing exposure must work under the kill switch)", async () => {
    const text = strip(read("services/scheduler/src/index.ts"));
    expect(text).toMatch(/name: "risk_decision_expiry", effect: "risk_housekeeping"/);
    expect(text).toMatch(/name: "circuit_breaker_evaluation", effect: "risk_housekeeping"/);
    expect(await runScheduledJob({ name: "risk_decision_expiry", effect: "risk_housekeeping" }, async () => undefined)).toBe("ran"); // no runtime state is configured here: a gated job would be skipped
  });
  it("only an EXPIRED version can bypass the intake controls, and only the expiry module asks to", () => {
    const rd = strip(read("packages/risk/src/riskDecisions.ts"));
    expect(rd).toMatch(/options\.riskReducing === true && revision\.status === "EXPIRED"/);
    const callers = files("packages/risk/src").filter((f) => /riskReducing:\s*true/.test(strip(read(f))));
    expect(callers).toEqual(["packages/risk/src/expiry/record.ts"]);
  });
  it("the database gate on approvals and orders is installed ENABLE ALWAYS by migration 0017", () => {
    const sql = read("packages/database/drizzle/0017_circuit_breakers.sql");
    for (const t of ["risk_decisions_b_breaker_before_insert", "circuit_breaker_events_a_integrity_before_insert", "loss_events_no_update_delete", "circuit_breaker_events_no_truncate"]) expect(sql, t).toContain(`ENABLE ALWAYS TRIGGER "${t}"`);
    expect(sql).toMatch(/twins_circuit_breaker_open\(\)[\s\S]*orders: a loss circuit breaker is open/);
  });
});
