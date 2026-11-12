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
const migration = read("packages/database/drizzle/0010_audit_immutability_hash_chain.sql") + read("packages/database/drizzle/0011_stop_loss_validations.sql") + read("packages/database/drizzle/0014_risk_decisions_foundation.sql") + read("packages/database/drizzle/0017_circuit_breakers.sql") + read("packages/database/drizzle/0018_market_risk_gates.sql") + read("packages/database/drizzle/0019_risk_approvals.sql") + read("packages/database/drizzle/0020_historical_import.sql") + read("packages/database/drizzle/0021_historical_outcomes.sql") + read("packages/database/drizzle/0022_historical_scorecards.sql") + read("packages/database/drizzle/0023_historical_patterns.sql") + read("packages/database/drizzle/0025_agent_engine.sql");
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
  it("the protected tables are the five of Task 3, the stop-loss evidence table of Task 4 and the risk decisions of Stage 3 the loss / breaker events of Task 4 the event blackout windows of Task 5 the risk approvals of Task 6 and the historical source records of Stage 4 and the outcome datasets / runs / labels / events of Stage 4 Task 2 and the source registry / scorecard runs / metrics / trust tiers / events of Stage 4 Task 3 and the pattern definitions / runs / snapshots / confidence runs / estimates of Stage 4 Task 4 and the agent definitions / orchestrator runs / agent runs / findings / evidence references / syntheses of Stage 5 Task 1", () => {
    expect([...PROTECTED_TABLES].sort()).toEqual(["agent_definitions", "agent_evidence_references", "agent_findings", "agent_orchestrator_runs", "agent_orchestrator_syntheses", "agent_runs", "audit_events", "circuit_breaker_events", "event_blackout_windows", "historical_confidence_estimates", "historical_confidence_runs", "historical_datasets", "historical_evaluation_events", "historical_evaluation_runs", "historical_outcome_labels", "historical_pattern_definitions", "historical_pattern_runs", "historical_pattern_snapshots", "historical_scorecard_events", "historical_scorecard_metrics", "historical_scorecard_runs", "historical_source_records", "historical_source_registry", "historical_trust_tiers", "loss_events", "options_claims", "risk_approvals", "risk_decisions", "signal_validations", "stop_loss_validations", "system_control_events", "telegram_messages"]);
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
  it("app-role.sql lists the execution tables (orders, fills, positions) as read-only, and migration 0029 revokes writes on them from the runtime and bot roles", () => {
    const readOnly = /read_only text\[\] := ARRAY\[([^\]]*)\]/.exec(role)?.[1] ?? "";
    for (const t of ["orders", "fills", "positions"]) expect(readOnly, t).toContain(`'${t}'`);
    const mig = read("packages/database/drizzle/0029_p1_revoke_runtime_execution_writes.sql");
    expect(mig).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %I/);
    expect(mig).toMatch(/ARRAY\['twins_app', 'twins_bot'\]/);
    expect(mig).toMatch(/ARRAY\['orders', 'fills', 'positions'\]/);
    expect(mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/\bGRANT\b/i); // it only ever takes privileges away
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

describe("risk-control hardening (migration 0047): the files agree with the design", () => {
  const sql = read("packages/database/drizzle/0047_risk_control_door.sql"), appRole = read("infrastructure/staging/app-role.sql");
  const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  it("app-role.sql: risk_control_events is READ-ONLY for the runtime role, the owner allowlist is NO-ACCESS, and the one door is granted explicitly (and revoked from PUBLIC)", () => {
    const readOnly = must(/read_only text\[\] := ARRAY\[([^\]]*)\]/.exec(appRole))[1] ?? "", none = must(/none_for_runtime text\[\] := ARRAY\[([^\]]*)\]/.exec(appRole))[1] ?? "", insertOnly = must(/insert_only text\[\] := ARRAY\[([^\]]*)\]/.exec(appRole))[1] ?? "";
    expect(readOnly).toContain("'risk_control_events'"); expect(insertOnly).not.toContain("risk_control_events"); expect(none).toContain("'twins_control_privileged_roles'");
    expect(appRole).toMatch(/REVOKE ALL ON FUNCTION twins_set_user_halt\(text, text, timestamptz\) FROM PUBLIC;/); expect(appRole).toMatch(/GRANT EXECUTE ON FUNCTION twins_set_user_halt\(text, text, timestamptz\) TO :"app_role";/);
  });
  it("migration 0047: the writer role is NOLOGIN NOSUPERUSER NOBYPASSRLS, owns only the door, and the door is a fixed-search_path SECURITY DEFINER that PUBLIC cannot execute", () => {
    const body = noComments(sql);
    expect(body).toMatch(/CREATE ROLE twins_control_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT/); expect(body).toMatch(/ALTER ROLE twins_control_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT/);
    expect(body).toMatch(/GRANT SELECT, INSERT ON public\.risk_control_events TO twins_control_writer/); expect(body).not.toMatch(/GRANT (ALL|UPDATE|DELETE|TRUNCATE)[^;]*twins_control_writer/);
    expect(body).toMatch(/CREATE FUNCTION public\.twins_set_user_halt\([^)]*\) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp/);
    expect(body).toMatch(/ALTER FUNCTION public\.twins_set_user_halt\(text, text, timestamptz\) OWNER TO twins_control_writer/); expect(body).toMatch(/REVOKE ALL ON FUNCTION public\.twins_set_user_halt\(text, text, timestamptz\) FROM PUBLIC/);
    expect(body).toMatch(/REVOKE CREATE ON SCHEMA public FROM twins_control_writer/);
  });
  it("migration 0047: the door's fixed columns cannot be chosen by the caller, and the guard keys on session_user", () => {
    const door = noComments(must(/CREATE FUNCTION public\.twins_set_user_halt[\s\S]*?\n\$\$;/.exec(sql))[0]), guard = noComments(must(/CREATE FUNCTION public\.twins_risk_control_guard[\s\S]*?\n\$\$;/.exec(sql))[0]);
    expect(door).toMatch(/VALUES \(nid, uid, 'USER', uid::text, p_kind, 'SET', p_reason, 'planning-cycle', 'SYSTEM', p_expires\)/); expect(door).not.toMatch(/'CLEAR'|'OWNER'|'KILL_SWITCH'|'RESTRICTION'(?!,\s*'DAILY)/);
    expect(guard).toMatch(/role_name = session_user/); expect(guard).not.toMatch(/current_user/); expect(guard).toMatch(/NEW\.actor_kind = 'SYSTEM' AND NEW\.actor = 'planning-cycle'/);
  });
  it("migration 0047: the guard, the owner allowlist and both existing append-only triggers are ENABLE ALWAYS, and the allowlist is append-only", () => {
    const body = noComments(sql);
    for (const [table, trg] of [["risk_control_events", "risk_control_events_guard"], ["risk_control_events", "risk_control_events_no_update_delete"], ["risk_control_events", "risk_control_events_no_truncate"], ["twins_control_privileged_roles", "twins_control_privileged_roles_no_update_delete"], ["twins_control_privileged_roles", "twins_control_privileged_roles_no_truncate"]] as const)
      expect(body, trg).toContain(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${trg};`);
    expect(body).toMatch(/REVOKE ALL ON public\.twins_control_privileged_roles FROM PUBLIC/);
  });
  it("the runtime services that connect as twins_app all enforce role separation at start: the API, the worker and the scheduler (and the channel-news job)", () => {
    for (const f of ["apps/api/src/index.ts", "services/worker/src/index.ts", "services/scheduler/src/index.ts"]) expect(noComments(read(f)), f).toMatch(/enforceRuntimeRoleSeparation\(/);
    expect(read("scripts/ops/channel-news-export.ts")).toMatch(/checkRuntimeRolePrivileges\(/);
    expect(read("services/scheduler/package.json")).toContain('"@twins/audit-chain"'); expect(read("services/scheduler/tsconfig.json")).toContain("packages/audit-chain");
  });
  it("the planning cycle writes halts only through the door (no direct control-event insert remains in the runtime path)", () => {
    const cycle = noComments(read("packages/planning/src/cycle.ts")); expect(cycle).toMatch(/recordUserHalt\(/); expect(cycle).not.toMatch(/setRiskControl|clearRiskControl/);
  });
});
