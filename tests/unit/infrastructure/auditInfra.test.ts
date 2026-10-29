import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAIN_SPECS, HEADS_TRIGGERS, PROTECTED_TABLES, SYSTEM_CONTROLS_TRIGGERS } from "../../../packages/audit-chain/src/index";
import { must } from "../../support/must";

const read = (p: string) => readFileSync(p, "utf8");
const compose = read("infrastructure/staging/docker-compose.staging.yml");
const service = (name: string) => {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z_-]+:\\n|\\nnetworks:)`).exec(compose);
  if (!m) throw new Error(`service ${name} not found`);
  return must(m[1]).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
};
const migration = read("packages/database/drizzle/0010_audit_immutability_hash_chain.sql") + read("packages/database/drizzle/0011_stop_loss_validations.sql") + read("packages/database/drizzle/0014_risk_decisions_foundation.sql") + read("packages/database/drizzle/0017_circuit_breakers.sql") + read("packages/database/drizzle/0018_market_risk_gates.sql") + read("packages/database/drizzle/0019_risk_approvals.sql");
const migration0009 = read("packages/database/drizzle/0009_system_controls_kill_switch.sql");

describe("migration 0010 and the verifier specification agree", () => {
  it("every guard/chain trigger the verifier expects is created by a migration, and every per-table trigger is ENABLE ALWAYS", () => {
    const all = migration + migration0009;
    for (const s of CHAIN_SPECS) {
      for (const t of s.triggers) expect(all, t).toContain(`CREATE TRIGGER "${t}"`);
      expect(migration, s.table).toMatch(new RegExp(`ALTER TABLE "${s.table}" ENABLE ALWAYS TRIGGER[^;]*"${s.table}_no_update_delete"`));
      expect(migration, s.table).toMatch(new RegExp(`ALTER TABLE "${s.table}" ENABLE ALWAYS TRIGGER[^;]*"${s.table}_chain_before_insert"`));
    }
    for (const t of [...HEADS_TRIGGERS, ...SYSTEM_CONTROLS_TRIGGERS]) expect(all, t).toContain(`CREATE TRIGGER "${t}"`);
  });
  it("the payload functions list exactly the content columns of the spec (same count and order as the TypeScript fields)", () => {
    for (const s of CHAIN_SPECS) {
      const fn = new RegExp(`CREATE FUNCTION "twins_audit_payload_${s.table}"[\\s\\S]*?SELECT to_json\\(ARRAY\\[([\\s\\S]*?)\\]\\)::text`).exec(migration);
      expect(fn, s.table).not.toBeNull();
      const sqlFields = must(must(fn)[1]).split(/,(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
      expect(sqlFields.length, s.table).toBe(s.fields.length);
      // column names appear in the same order in both definitions
      const cols = (text: string) => [...text.matchAll(/\b[rt]\.([a-z_]+)/g)].map((m) => m[1]).filter((c, i, a) => c !== a[i - 1]); // (timestamp renderings mention their column more than once)
      expect(cols(must(must(fn)[1])), s.table).toEqual(cols(s.fields.join(",")));
    }
  });
  it("the hash definition in SQL uses the same domain string and field order as the TypeScript hashing", () => {
    expect(migration).toContain("'TWINS-AUDIT-V1' || E'\\n' || chain || E'\\n' || NEW.chain_index::text || E'\\n' || NEW.previous_hash || E'\\n' || NEW.payload_hash");
    expect(read("packages/audit-chain/src/specs.ts")).toContain('HASH_DOMAIN = "TWINS-AUDIT-V1"');
  });
  it("chain order assignment is serialized by a per-chain advisory lock and derived from the table (no gap on ON CONFLICT DO NOTHING)", () => {
    expect(migration).toContain("pg_advisory_xact_lock(1953720, hashtext(chain))");
    expect(migration).toMatch(/ORDER BY chain_index DESC LIMIT 1/);
    expect(migration).toMatch(/AFTER INSERT ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "twins_audit_chain_after_insert"/);
  });
  it("the protected tables are the five of Task 3, the stop-loss evidence table of Task 4 and the risk decisions of Stage 3 the loss / breaker events of Task 4 the event blackout windows of Task 5 and the risk approvals of Task 6", () => {
    expect([...PROTECTED_TABLES].sort()).toEqual(["audit_events", "circuit_breaker_events", "event_blackout_windows", "loss_events", "options_claims", "risk_approvals", "risk_decisions", "signal_validations", "stop_loss_validations", "system_control_events", "telegram_messages"]);
  });
});

describe("role separation in the staging stack", () => {
  const role = read("infrastructure/staging/app-role.sql");
  it("the runtime services connect as twins_app; migrate, safety-control and audit-verify use the owner credential via the shared anchor", () => {
    for (const n of ["api", "worker", "scheduler"]) expect(service(n), n).toMatch(/DATABASE_URL: postgresql:\/\/twins_app:\$\{TWINS_APP_DB_PASSWORD:\?/);
    for (const n of ["migrate", "safety-control", "audit-verify"]) {
      expect(service(n), n).toContain("environment: *app-env");
      expect(service(n), n).toMatch(/profiles: \["(?:migrate|ops)"\]/);
    }
    expect(service("approval-bot")).not.toMatch(/twins_app|POSTGRES_PASSWORD/);
    expect(read("infrastructure/staging/staging.env.example")).toMatch(/^TWINS_APP_DB_PASSWORD=CHANGE_ME/m);
  });
  it("app-role.sql: no DELETE/TRUNCATE/REFERENCES/TRIGGER grant anywhere, append-only tables get SELECT+INSERT only, controls are read-only, the audit heads and the bot's tables are not granted", () => {
    const code = role.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b/i);
    expect(code).toContain("GRANT SELECT, INSERT ON %I TO %I");
    expect(code).toContain("GRANT SELECT ON %I TO %I");
    expect(code).toContain("GRANT SELECT, INSERT, UPDATE ON %I TO %I");
    for (const t of ["claim_review_cards", "claim_reviews", "approval_bot_events", "approval_bot_state", "system_control_events", "audit_chain_heads"]) expect(code, t).toContain(`'${t}'`);
    expect(code).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
    expect(code).toMatch(/event_hash/); // a table that has chain columns is treated as append-only automatically
    expect(code).toMatch(/_no\\_update\\_delete/);
  });
  it("the API and the worker refuse to start (exit 82) outside development unless they run as the least-privilege role", () => {
    expect(read("apps/api/src/index.ts")).toMatch(/appEnv !== "development"\) await enforceRuntimeRoleSeparation\("api", getPool\(\)\)/);
    expect(read("services/worker/src/index.ts")).toMatch(/appEnv !== "development"\) await enforceRuntimeRoleSeparation\("worker", workerDb\.pool\)/);
  });
});

describe("scheduled and CI verification", () => {
  it("the systemd units run the audit-verify job with an external anchor and a status file", () => {
    const unit = read("infrastructure/staging/twins-audit-verify.service");
    expect(unit).toMatch(/--profile ops run --rm -T audit-verify .*--require-ddl-watch .*--anchor-file \/monitor\/audit-anchor\.json .*--status-file \/monitor\/audit-verify\.json/); // /monitor = the host directory mounted into the one-shot container (compose volumes)
    expect(unit).toMatch(/Type=oneshot/);
    const timer = read("infrastructure/staging/twins-audit-verify.timer");
    expect(timer).toMatch(/OnCalendar=hourly/);
    expect(timer).toMatch(/Unit=twins-audit-verify\.service/);
  });
  it("CI runs the verifier after the integration suite and fails the job on a FAIL", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci.indexOf("Integration tests")).toBeGreaterThan(-1);
    expect(ci.indexOf("npm run audit:verify")).toBeGreaterThan(ci.indexOf("Integration tests"));
    expect(ci).toContain('exit "${PIPESTATUS[0]}"');
  });
  it("verify-migrations checks the 0010 structures", () => {
    const v = read("scripts/ci/verify-migrations.mjs");
    expect(v).toContain("audit_chain_heads");
    expect(v).toContain("tgenabled !== \"A\"");
  });
});

describe("ops one-shot services accept arguments (found in the first real staging run)", () => {
  const compose = readFileSync(new URL("../../../infrastructure/staging/docker-compose.staging.yml", import.meta.url), "utf8");
  it("safety-control and audit-verify use `entrypoint`, so `compose run <service> <args>` appends arguments instead of replacing the CLI", () => {
    for (const [service, script] of [["safety-control", "safety-control.ts"], ["audit-verify", "verify-audit-chain.ts"]] as const) {
      const block = compose.slice(compose.indexOf(`\n  ${service}:`), compose.indexOf("\n  ", compose.indexOf(`\n  ${service}:`) + 5 + 400) );
      expect(block, service).toMatch(new RegExp(`entrypoint: \\["node", "--import", "tsx", "/app/scripts/ops/${script.replace(".", "\\.")}"\\]`));
      expect(block, service).not.toMatch(/\n    command:/);
    }
  });
});
