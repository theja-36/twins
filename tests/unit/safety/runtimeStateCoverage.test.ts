import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static proof that the runtime safety state is wired into every critical boundary and cannot be bypassed by omission:
 * each process configures it, each boundary calls its gate, production code never imports the test-only source, and the only
 * `.placeOrder(` call site in the repository is the gated execution wrapper.
 */
const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*|#)/.test(l)).join("\n");

describe("every process that runs a critical loop configures the database-backed state", () => {
  const configures: Array<[string, RegExp]> = [
    ["apps/api/src/index.ts", /configureRuntimeState\(\{ source: pgStateSource\(getPool\(\)\)/],
    ["services/worker/src/index.ts", /configureRuntimeState\(\{ source: pgStateSource\(workerDb\.pool\)/],
    ["services/scheduler/src/index.ts", /configureRuntimeState\(\{ source: runtimeStatePool\.source/],
    ["services/approval-bot/src/index.ts", /configureRuntimeState\(\{ source: pgStateSource\(db\.queryable\(\)\)/],
  ];
  it.each(configures)("%s", (file, rx) => {
    expect(strip(read(file))).toMatch(rx);
  });
  it("the documented exceptions are exactly: migrate (creates the tables), safety-control (is the admin), capture (no database access; gated at the API ingest endpoint)", () => {
    for (const f of ["packages/database/src/migrate.ts", "scripts/ops/safety-control.ts"]) expect(strip(read(f)), f).not.toMatch(/configureRuntimeState/);
    expect(read("services/telegram-capture/twins_capture/config.py")).not.toMatch(/DATABASE_URL|psycopg|pg8000/);
    expect(strip(read("apps/api/src/internalIngest.ts"))).toMatch(/evaluateSafety\("intake", "api\.internal_ingest\.telegram_user"\)/);
  });
  it("production entry points never import the test-only in-memory source", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (["node_modules", "dist", "tests", "__pycache__"].includes(name)) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.ts$/.test(name) && /inMemoryStateSource/.test(read(rel)) && !rel.startsWith("packages/runtime-state/src/")) offenders.push(rel);
      }
    };
    for (const dir of ["apps", "services", "packages", "adapters", "scripts"]) walk(dir);
    expect(offenders).toEqual([]);
  });
});

describe("every boundary calls its gate", () => {
  const boundaries: Array<[string, string, RegExp]> = [
    ["Telegram intake worker (messages)", "services/worker/src/index.ts", /await assertIntakeEnabled\("worker\.telegram_job"\)/],
    ["Telegram intake worker (observed deletions)", "services/worker/src/index.ts", /await assertIntakeEnabled\("worker\.telegram_events_job"\)/],
    ["worker queue handler converts refusals to a pause", "services/worker/src/index.ts", /withIntakeGate\(/],
    ["API webhook", "apps/api/src/index.ts", /evaluateSafety\("intake", "api\.webhook\.telegram"\)/],
    ["API internal capture ingest", "apps/api/src/internalIngest.ts", /evaluateSafety\("intake", "api\.internal_ingest\.telegram_user"\)/],
    ["claim creation (signal)", "packages/signals/src/ingestSignal.ts", /assertIntakeEnabled\("signals\.createSignalFromTelegramMessage"\)/],
    ["claim creation (reparse)", "packages/signals/src/ingestSignal.ts", /assertIntakeEnabled\("signals\.reparseTelegramMessage"\)/],
    ["claim creation (options claim)", "packages/signals/src/options/persist.ts", /assertIntakeEnabled\("signals\.recordOptionsIntake"\)/],
    ["decision creation", "packages/decision-intelligence/src/engine.ts", /assertKillSwitchInactive\("decision\.validateSignal"\)/],
    ["approval-card creation", "services/approval-bot/src/bot.ts", /evaluateSafety\("kill_switch_inactive", "approval_bot\.card_creation"\)/],
    ["approval decision persistence", "services/approval-bot/src/bot.ts", /evaluateSafety\("kill_switch_inactive", "approval_bot\.approval_decision"\)/],
    ["order-intent / broker-call boundary", "adapters/broker/src/index.ts", /await assertOrderIntentAllowed\(`broker\.\$\{provider\.providerName\}\.placeOrder`\)/],
    ["order-intent boundary: live guard then trading state", "packages/runtime-state/src/guards.ts", /assertLiveTradingDisabled\(operationName\);\s+await assertTradingEnabled\(operationName\)/],
    ["scheduler jobs", "services/scheduler/src/scheduledJob.ts", /evaluateSafety\("trading", `scheduler\.\$\{spec\.name\}`\)/],
  ];
  it.each(boundaries)("%s", (_name, file, rx) => {
    expect(strip(read(file))).toMatch(rx);
  });

  it("the gate precedes the first database access in each gated function", () => {
    const order: Array<[string, string, string]> = [
      ["packages/signals/src/ingestSignal.ts", 'assertIntakeEnabled("signals.createSignalFromTelegramMessage")', "loadMessage(db, telegramMessageId);\n\n  const existing"],
      ["packages/signals/src/options/persist.ts", 'assertIntakeEnabled("signals.recordOptionsIntake")', "const { intake } = input;"],
      ["packages/decision-intelligence/src/engine.ts", 'assertKillSwitchInactive("decision.validateSignal")', "findValidationByKey(db"],
      ["services/worker/src/index.ts", 'assertIntakeEnabled("worker.telegram_job")', 'log.info("worker.job.started")'],
    ];
    for (const [file, gate, firstUse] of order) {
      const t = read(file);
      expect(t.indexOf(gate), `${file}: ${gate}`).toBeGreaterThan(-1);
      expect(t.indexOf(gate), file).toBeLessThan(t.indexOf(firstUse));
    }
  });

  it("every scheduler cron callback goes through runScheduledJob", () => {
    const text = strip(read("services/scheduler/src/index.ts"));
    const callbacks = [...text.matchAll(/cron\.schedule\(/g)];
    const guarded = [...text.matchAll(/cron\.schedule\([^)]*\)\s*=>\s*\{\s*void runScheduledJob\(/g)];
    expect(callbacks.length).toBeGreaterThan(0);
    expect(guarded).toHaveLength(callbacks.length);
  });

  it("read-only routes are not gated: existing records stay readable under the kill switch (only the two intake POST routes call the gate)", () => {
    const api = strip(read("apps/api/src/index.ts")) + strip(read("apps/api/src/internalIngest.ts"));
    expect([...api.matchAll(/evaluateSafety\(/g)]).toHaveLength(2);
  });

  it("the only .placeOrder( call site is the gated execution wrapper; nothing else obtains a provider from the registry", () => {
    const calls: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (["node_modules", "dist", "tests", "__pycache__"].includes(name)) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.ts$/.test(name) && /\.placeOrder\(|executionProviders\.get\(/.test(strip(read(rel)))) calls.push(rel);
      }
    };
    for (const dir of ["apps", "services", "packages", "adapters", "scripts"]) walk(dir);
    expect(calls).toEqual(["adapters/broker/src/index.ts"]);
  });
});

describe("the migration and schema agree", () => {
  const sql = read("packages/database/drizzle/0009_system_controls_kill_switch.sql");
  it("seeds exactly the documented defaults", () => {
    expect(sql).toMatch(/'TRADING_ENABLED', false, 1/);
    expect(sql).toMatch(/'INTAKE_ENABLED', true, 1/);
    expect(sql).toMatch(/'KILL_SWITCH_ACTIVE', false, 1/);
  });
  it("audits through triggers, forbids removal and keeps the event table append-only", () => {
    for (const t of ["system_controls_before_update", "system_controls_audit_insert", "system_controls_audit_update", "system_controls_no_delete", "system_controls_no_truncate", "system_control_events_no_update_delete", "system_control_events_no_truncate"]) {
      expect(sql, t).toContain(`CREATE TRIGGER "${t}"`);
    }
  });
});
