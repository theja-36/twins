import { describe, expect, it } from "vitest";
import { resolveTestTarget } from "../../integration/targetConfig";
import { describeMigrationMismatch, loadExpectedMigrations } from "../../integration/migrationState";

const base = { LIVE_TRADING: "false" };
const rehearsal = (over: Record<string, string | undefined> = {}) =>
  ({ ...base, TWINS_REHEARSAL: "1", DATABASE_URL: "postgresql://twins:pw@127.0.0.1:15432/twins_rehearsal_f2_fresh", REDIS_URL: "redis://127.0.0.1:16379", ...over }) as NodeJS.ProcessEnv;
const ci = (over: Record<string, string | undefined> = {}) =>
  ({ ...base, TWINS_CI: "1", DATABASE_URL: "postgresql://twins_ci:pw@127.0.0.1:5432/twins_ci", REDIS_URL: "redis://127.0.0.1:6379", ...over }) as NodeJS.ProcessEnv;

describe("integration test target resolution (no defaults, exact contexts)", () => {
  it("accepts the approved rehearsal and CI targets", () => {
    expect(resolveTestTarget(rehearsal())).toEqual({ context: "rehearsal", database: "twins_rehearsal_f2_fresh" });
    expect(resolveTestTarget(ci())).toEqual({ context: "ci", database: "twins_ci" });
  });
  it("fails when DATABASE_URL or REDIS_URL is missing (no silent substitute)", () => {
    expect(() => resolveTestTarget(rehearsal({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL is not set/);
    expect(() => resolveTestTarget(ci({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL is not set/);
    expect(() => resolveTestTarget(rehearsal({ REDIS_URL: undefined }))).toThrow(/REDIS_URL is not set/);
    expect(() => resolveTestTarget(ci({ REDIS_URL: undefined }))).toThrow(/REDIS_URL is not set/);
  });
  it("requires exactly one context", () => {
    expect(() => resolveTestTarget({ ...base } as NodeJS.ProcessEnv)).toThrow(/no context/);
    expect(() => resolveTestTarget(rehearsal({ TWINS_CI: "1" }))).toThrow(/both/);
  });
  it.each(["twins_dev", "twins_ci", "twins_restore_drill", "twins_rehearsal_other", "postgres", "twins_test"])("rehearsal rejects database %s", (name) => {
    expect(() => resolveTestTarget(rehearsal({ DATABASE_URL: `postgresql://twins:pw@127.0.0.1:15432/${name}` }))).toThrow(/approved list/);
  });
  it.each(["twins_dev", "twins_rehearsal_fresh", "twins_ci_other", "twins_test"])("CI rejects database %s", (name) => {
    expect(() => resolveTestTarget(ci({ DATABASE_URL: `postgresql://twins_ci:pw@127.0.0.1:5432/${name}` }))).toThrow(/exactly twins_ci/);
  });
  it("rejects wrong user, host or port for the context", () => {
    expect(() => resolveTestTarget(rehearsal({ DATABASE_URL: "postgresql://twins_ci:pw@127.0.0.1:15432/twins_rehearsal_f2_fresh" }))).toThrow(/user/);
    expect(() => resolveTestTarget(rehearsal({ DATABASE_URL: "postgresql://twins:pw@db.example.com:15432/twins_rehearsal_f2_fresh" }))).toThrow(/127\.0\.0\.1:15432/);
    expect(() => resolveTestTarget(rehearsal({ DATABASE_URL: "postgresql://twins:pw@127.0.0.1:5432/twins_rehearsal_f2_fresh" }))).toThrow(/127\.0\.0\.1:15432/);
    expect(() => resolveTestTarget(ci({ DATABASE_URL: "postgresql://twins:pw@127.0.0.1:5432/twins_ci" }))).toThrow(/user/);
    expect(() => resolveTestTarget(ci({ DATABASE_URL: "postgresql://twins_ci:pw@db.example.com:5432/twins_ci" }))).toThrow(/loopback/);
  });
  it("rejects wrong or non-loopback Redis", () => {
    expect(() => resolveTestTarget(rehearsal({ REDIS_URL: "redis://127.0.0.1:6379" }))).toThrow(/16379/);
    expect(() => resolveTestTarget(rehearsal({ REDIS_URL: "redis://cache.example.com:16379" }))).toThrow(/16379/);
    expect(() => resolveTestTarget(ci({ REDIS_URL: "redis://cache.example.com:6379" }))).toThrow(/loopback/);
  });
  it("requires LIVE_TRADING=false and not live mode", () => {
    expect(() => resolveTestTarget(rehearsal({ LIVE_TRADING: undefined }))).toThrow(/LIVE_TRADING/);
    expect(() => resolveTestTarget(ci({ LIVE_TRADING: "true" }))).toThrow(/LIVE_TRADING/);
    expect(() => resolveTestTarget(ci({ TRADING_MODE: "live" }))).toThrow(/TRADING_MODE/);
  });
  it("never echoes the connection string, user or password in diagnostics", () => {
    for (const env of [rehearsal({ DATABASE_URL: "postgresql://secretuser:secretpw@evil.example.com:1/twins_dev" }), ci({ DATABASE_URL: "postgresql://secretuser:secretpw@evil.example.com:1/twins_dev" }), rehearsal({ DATABASE_URL: "not a url secretpw" })]) {
      try { resolveTestTarget(env); throw new Error("should have thrown"); } catch (e) {
        expect(String((e as Error).message)).not.toMatch(/secretpw|secretuser|evil\.example/);
      }
    }
  });
});

describe("migration state comparison (repository journal/hash convention)", () => {
  const expected = loadExpectedMigrations();
  const recorded = expected.map((m) => ({ hash: m.hash, created_at: String(m.when) }));
  it("matches the repository chain exactly (28 migrations)", () => {
    expect(expected).toHaveLength(28);
    expect(describeMigrationMismatch(expected, recorded)).toBeNull();
  });
  it("reports a target that is behind, naming the missing migrations", () => {
    const msg = describeMigrationMismatch(expected, recorded.slice(0, 4));
    expect(msg).toMatch(/behind: 4 of 28/);
    expect(msg).toContain("0005_r0b_signal_evidence_unique_links");
    expect(msg).toContain("0006_options_claims_unverified");
    expect(msg).toContain("0007_telegram_user_capture_provenance");
    expect(msg).toContain("0008_approval_bot_review_log");
    expect(msg).toContain("0009_system_controls_kill_switch");
    expect(msg).toContain("0010_audit_immutability_hash_chain");
    expect(msg).toContain("0011_stop_loss_validations");
    expect(msg).toContain("0012_telegram_intake_outbox");
    expect(msg).toContain("0013_outbox_dead_letter_replay");
    expect(msg).toContain("0014_risk_decisions_foundation");
    expect(msg).toContain("0015_risk_decision_sizing");
    expect(msg).toContain("0016_risk_decision_portfolio_review");
    expect(msg).toContain("0017_circuit_breakers");
    expect(msg).toContain("0018_market_risk_gates");
    expect(msg).toContain("0019_risk_approvals");
    expect(msg).toContain("0020_historical_import");
    expect(msg).toContain("0021_historical_outcomes");
    expect(msg).toContain("0022_historical_scorecards");
    expect(msg).toContain("0023_historical_patterns");
    expect(msg).toContain("0024_risk_source_intelligence");
    expect(msg).toContain("0025_agent_engine");
    expect(msg).toContain("0026_agent_id_hyphen");
    expect(msg).toContain("0027_research_eligibility");
  });
  it("reports an empty history, extra history, and altered content or timestamp", () => {
    expect(describeMigrationMismatch(expected, [])).toMatch(/behind: 0 of 28/);
    expect(describeMigrationMismatch(expected, [...recorded, { hash: "x", created_at: "1" }])).toMatch(/ahead or foreign/);
    expect(describeMigrationMismatch(expected, recorded.map((r, i) => (i === 2 ? { ...r, hash: "0".repeat(64) } : r)))).toMatch(/different content/);
    expect(describeMigrationMismatch(expected, recorded.map((r, i) => (i === 7 ? { ...r, created_at: "1" } : r)))).toMatch(/timestamp/);
  });
});
